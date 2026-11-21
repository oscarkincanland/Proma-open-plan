/**
 * 远程浏览器宿主（平台适配层，ADR 0044 / 计划 2026-11-21-002 P2）。
 *
 * 背景：Proma 壳采用 sidecar 进程模型——open-plan server 跑在纯 Node 子进程里，
 * 没有 Electron GUI 能力；WebContentsView 只能活在 Proma main 进程。两侧经
 * Proma main 提供的「宿主桥」（仅回环 HTTP + WebSocket）协作：
 *
 *   server（本模块，客户端） ──HTTP/WS──▶ Proma main（open-plan-browser-host.ts）
 *   attach(key) → POST /attach → { wsUrl } → new WebSocket(wsUrl) → transport
 *   setBounds/setVisible/detach → POST 对应端点
 *
 * WS 上的 CDP 传输协议（JSON 帧）：
 *   server → 桥：{type:"send", id, method, params} / {type:"close"}
 *   桥 → server：{type:"result", id, result?, error?} / {type:"event", method, params}
 *
 * 与 desktop/src/浏览器视图.cjs（同进程形态）的 transport 契约逐字同构：
 *   { ready, sessionId: null, send(method, params), on(event, handler), close() }
 * server/内置浏览器.mjs 无需感知差异。
 *
 * 注入时机：server/index.mjs 启动时检测 OAW_BROWSER_HOST_BRIDGE + OAW_BRIDGE_TOKEN。
 */

const BRIDGE_TIMEOUT_MS = 15_000;

/** 带超时与 token 的桥 HTTP 调用。 */
async function bridgeFetch(bridgeUrl, token, pathname, body, timeoutMs = BRIDGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${bridgeUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-oaw-bridge-token": token,
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(String(payload?.error || `桥返回 HTTP ${res.status}`)), {
        code: payload?.code || "BRIDGE_HTTP_ERROR",
      });
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/** 把浏览器 WebSocket 包成 server 期望的 transport 契约。 */
function createWebSocketTransport(ws) {
  const handlers = new Map();
  const pending = new Map();
  let nextId = 1;
  let settled = false;

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        reject(new Error("宿主桥 WebSocket 连接失败"));
      }
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    let frame = null;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (frame?.type === "result" && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(entry?.timer);
      if (frame.error) entry.reject(new Error(frame.error));
      else entry.resolve(frame.result || {});
      return;
    }
    if (frame?.type === "event" && typeof frame.method === "string") {
      const set = handlers.get(frame.method);
      if (set) for (const fn of [...set]) {
        try { fn(frame.params); } catch {}
      }
    }
  });

  ws.addEventListener("close", () => {
    if (!settled) {
      settled = true;
      // ready 永不 resolve 的兜底：连接在 open 前就关了
    }
    for (const [, entry] of pending) {
      clearTimeout(entry?.timer);
      entry.reject(new Error("宿主桥连接已关闭"));
    }
    pending.clear();
  });

  return {
    ready,
    sessionId: null,
    async send(method, params = {}) {
      await ready;
      const id = nextId++;
      const frame = JSON.stringify({ type: "send", id, method, params: params || {} });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`宿主桥 CDP 命令超时：${method}`));
        }, BRIDGE_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(frame);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    close() {
      try {
        ws.send(JSON.stringify({ type: "close" }));
      } catch {}
      try { ws.close(); } catch {}
      settled = true;
      handlers.clear();
    },
  };
}

/**
 * 创建远程宿主实现（满足 installEmbeddedBrowserHost 契约）。
 * @param {{bridgeUrl:string, token:string}} options
 */
export function createRemoteBrowserHost({ bridgeUrl, token }) {
  const url = String(bridgeUrl || "").replace(/\/$/, "");
  if (!url) throw new Error("createRemoteBrowserHost 需要非空 bridgeUrl");

  return {
    kind: "embedded",
    supportsScreencast: false,

    async attach(key) {
      const result = await bridgeFetch(url, token, "/attach", { key: String(key || "") });
      if (!result?.wsUrl) throw new Error("宿主桥未返回 wsUrl");
      const ws = new WebSocket(result.wsUrl);
      return createWebSocketTransport(ws);
    },

    async detach(key) {
      await bridgeFetch(url, token, "/detach", { key: String(key || "") });
    },

    async setBounds(key, bounds) {
      await bridgeFetch(url, token, "/setBounds", { key: String(key || ""), bounds: bounds || {} });
    },

    async setVisible(key, visible) {
      await bridgeFetch(url, token, "/setVisible", { key: String(key || ""), visible: visible !== false });
    },
  };
}

/**
 * 启动时注入：env OAW_BROWSER_HOST_BRIDGE（桥 URL）存在即注入远程宿主。
 * @returns {boolean} 是否注入成功
 */
export function installRemoteBrowserHostFromEnv() {
  const bridgeUrl = String(process.env.OAW_BROWSER_HOST_BRIDGE || "").trim();
  if (!bridgeUrl) return false;
  const token = String(process.env.OAW_BRIDGE_TOKEN || "").trim();
  // 延迟 import 避免无桥形态的加载开销
  return import("./浏览器驱动.mjs").then(({ installEmbeddedBrowserHost }) => {
    installEmbeddedBrowserHost(createRemoteBrowserHost({ bridgeUrl, token }));
    return true;
  });
}
