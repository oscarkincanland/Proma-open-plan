#!/usr/bin/env node
/**
 * 会话切换串页回归测试（2026-11-20，方案 docs/plans/2026-11-19-012 §8）
 *
 * 守护：运行中会话 A 的流式气泡不得泄漏进会话 B 的消息列表（历史水合合并路径）。
 * 这是缺陷一的主守护（行为级、可复跑）；scripts/会话切换稳定性测试.mjs 的字面量断言
 * 仅作结构断言（防实现被回改），不验证运行时取值（见方案 §8 局限声明）。
 *
 * 做法：加载真实 client bundle（依赖 npm start），Playwright 路由 stub 全部数据面
 * （sessions / runs / resume / SSE），不依赖真实模型与真实会话数据：
 *   - A：历史含 running Run 摘要，SSE 注入 token 事件 → A 出现 streaming 气泡；
 *   - B：仅历史消息，无运行；
 *   - A→B→A→B 往返，每次切到 B 后（水合完成后）断言 B 指纹与基线一致且无 streaming 气泡；
 *     切回 A 断言 streaming 气泡仍在（不误删合法气泡）。
 *
 * 用法：npm run test:session-leak   （服务不可达时退出码 2 = 跳过，与 ui-smoke 约定一致）
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.OAW_LEAK_BASE || "http://127.0.0.1:3002";
const WORKSPACE = process.env.OAW_LEAK_WORKSPACE || path.join(PROJECT_DIR, "office-workspace");

const ID_A = "leak-sess-a";
const ID_B = "leak-sess-b";
const THREAD_A = "thread-leak-a";
const THREAD_B = "thread-leak-b";
const RUN_A = "run-leak-a";
const TITLE_A = "串页回归-A（运行中）";
const TITLE_B = "串页回归-B（已完成）";
const CLIENT = "leak-client";

function loadChromium() {
  const candidates = [
    path.join(PROJECT_DIR, "node_modules"),
    path.join(PROJECT_DIR, "client", "node_modules"),
    path.join(PROJECT_DIR, "..", "pi-web"),
    path.join(process.env.APPDATA || "", "npm", "node_modules"),
  ];
  for (const dir of candidates) {
    try { return createRequire(path.join(dir, "noop.js"))("playwright").chromium; } catch {}
  }
  throw new Error("未找到 playwright：请先 npm i -D playwright（或在本机任意项目安装后重跑）");
}

const iso = () => new Date().toISOString();

// ---------- stub 数据 ----------
const sessions = [
  { id: ID_A, threadId: THREAD_A, title: TITLE_A, cwd: WORKSPACE, projectName: "串页回归项目", projectType: "综合项目", projectStatus: "进行中", runStatus: "running", runId: RUN_A, lastRunAt: iso(), mode: "agent", modified: Date.now(), archived: false, frozen: false, pinned: false, label: "", mapProject: "", mapView: null, creativeCanvas: "" },
  { id: ID_B, threadId: THREAD_B, title: TITLE_B, cwd: WORKSPACE, projectName: "串页回归项目", projectType: "综合项目", projectStatus: "进行中", runStatus: "idle", mode: "agent", modified: Date.now() - 60000, archived: false, frozen: false, pinned: false, label: "", mapProject: "", mapView: null, creativeCanvas: "" },
];

const entryUser = (id, text) => ({ type: "message", id, parentId: null, timestamp: iso(), message: { role: "user", content: text } });
const entryAssistant = (id, text) => ({ type: "message", id, parentId: "prev", timestamp: iso(), message: { role: "assistant", content: text } });

const runA = {
  id: RUN_A, status: "running", startedAt: iso(), finishedAt: null,
  task: { mode: "agent", prompt: "A 会话的运行中任务" },
  artifacts: [], references: [], events: [], todos: [], steps: [],
};
const sessionDetail = (id, entries) => ({
  entries,
  tree: {},
  leafId: entries[entries.length - 1]?.id || null,
  info: { id, cwd: WORKSPACE, chatView: true, historyHasMore: false, historyStart: 0, historyEnd: entries.length, historyPageSize: 50, activeLeafId: entries[entries.length - 1]?.id || null },
});

const detailA = sessionDetail(ID_A, [
  entryUser("a1", "A 会话的用户消息"),
  { type: "message", id: "a2", parentId: "a1", timestamp: iso(), message: { role: "assistant", content: "A 会话的历史回答" } },
]);
const detailB = sessionDetail(ID_B, [
  entryUser("b1", "B 会话的用户消息"),
  entryAssistant("b2", "B 会话的历史回答"),
]);

const runsFor = (url) => {
  const thread = url.searchParams.get("thread") || "";
  const session = url.searchParams.get("session") || "";
  if (thread === THREAD_A || session === ID_A) return { runs: [runA] };
  return { runs: [] };
};

/**
 * SSE 帧：A 的 token 帧不带 id → 客户端游标不前进 → 每次重连都会重放，
 * 模拟"持续 token 流"：即使早期帧落在探测窗口被丢，重连后气泡也会重建
 * （真实链路里运行中的会话每秒都有新 token）。B 只握手。
 */
const sseBody = (thread) => {
  const frames = [
    `data: ${JSON.stringify({ type: "connected", at: iso(), data: { client: CLIENT, thread, streamId: "gen1", cursor: 0, earliest: 1, latest: 3, truncated: false } })}\n\n`,
  ];
  if (thread === THREAD_A) {
    frames.push(`data: ${JSON.stringify({ type: "token", at: iso(), data: { runId: RUN_A, text: "A-流式正文" } })}\n\n`);
  }
  return frames.join("");
};

// ---------- 测试主体 ----------
const chromium = loadChromium();

// 服务没起：明确"跳过"而不是失败（与 ui-smoke 约定一致，退出码 2）。
try {
  const probe = await fetch(`${BASE}/api/status`).then((r) => r.json());
  if (!probe?.ok) throw new Error("status 非 ok");
} catch (error) {
  console.error(`[跳过] 服务不可达（${BASE}）：${String(error?.message || error)}`);
  console.error("请先 npm start，再运行 npm run test:session-leak");
  process.exit(2);
}

let browser;
for (const opts of [{}, { channel: "msedge" }, { channel: "chrome" }]) {
  try { browser = await chromium.launch({ headless: true, ...opts }); break; } catch {}
}
if (!browser) {
  console.error("无法启动浏览器：请确认已安装 chromium / Edge / Chrome");
  process.exit(1);
}

const pageErrors = [];
const consoleErrors = [];
let exitCode = 0;
let browserClosed = false;

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.addInitScript(({ workspace, client }) => {
    localStorage.setItem("oaw_client_id", client);
    localStorage.setItem("oaw_ui_state_v1", JSON.stringify({ workspace, sidebarOpen: true }));
  }, { workspace: WORKSPACE, client: CLIENT });

  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error).slice(0, 240)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text().slice(0, 240);
    if (!/Failed to load resource|favicon|net::ERR|ResizeObserver loop/i.test(text)) consoleErrors.push(text);
  });

  // 数据面 stub：只接管 fake 会话相关请求，其余放行到真实服务器（应用壳/静态资源/状态接口）。
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.origin.startsWith(BASE)) return route.fallback();
    const p = url.pathname;
    try {
      if (p === "/api/sessions" && request.method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions }) });
      }
      if (/^\/api\/sessions\/(leak-sess-[ab])$/.test(p) && url.searchParams.get("view") === "chat") {
        const detail = p.endsWith(ID_A) ? detailA : detailB;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail) });
      }
      if (p === "/api/runs") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runsFor(url)) });
      }
      if (/^\/api\/runs\/run-leak-a$/.test(p)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: runA }) });
      }
      if (p === "/api/agent/resume" && request.method() === "POST") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      if (p === "/api/agent/stream") {
        const thread = url.searchParams.get("thread") || "";
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(thread) });
      }
    } catch (error) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: String(error?.message || error) }) });
    }
    return route.fallback();
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);

  const openSession = async (title) => {
    await page.evaluate((title) => {
      const nodes = [...document.querySelectorAll("button, [role=button], .project-session-open, .session-item, a")]
        .filter((el) => (el.textContent || "").includes(title));
      const target = nodes[nodes.length - 1];
      if (target) target.click();
    }, title);
  };

  const viewSnapshot = () => page.evaluate(() => {
    const msgs = [...document.querySelectorAll(".msg")];
    const texts = msgs.map((m) => (m.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60));
    return {
      count: msgs.length,
      fingerprint: JSON.stringify(texts),
      first: texts[0] || "",
      streaming: msgs.filter((m) => /streaming/.test(m.className)).length,
      boundary: (document.querySelector(".chat-error-boundary")?.innerText || "").trim(),
    };
  });

  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await viewSnapshot();
      if (predicate(state)) return state;
      await page.waitForTimeout(400);
    }
    const last = await viewSnapshot();
    throw new Error(`等待超时（${label}）：last=${JSON.stringify({ count: last.count, first: last.first, streaming: last.streaming, boundary: last.boundary })}`);
  };

  // 1) 打开 A：历史渲染 + SSE token 注入 → streaming 气泡出现（测试前置条件）
  await openSession(TITLE_A);
  const stateA = await waitFor((s) => s.streaming > 0, 15000, "A 的 streaming 气泡未出现");
  if (stateA.boundary) throw new Error(`A 出现错误边界：${stateA.boundary}`);
  console.log(`  ✓ A 运行态就绪（msg=${stateA.count} streaming=${stateA.streaming}）`);

  // 2) 打开 B：记录基线指纹（水合完成后判定）
  await openSession(TITLE_B);
  const baseB = await waitFor((s) => s.first.includes("B 会话的用户消息") && s.count === 2, 15000, "B 的历史未水合");
  await page.waitForTimeout(1500); // 留出迟到合并/重放窗口
  const baseBStable = await viewSnapshot();
  if (baseBStable.fingerprint !== baseB.fingerprint || baseBStable.streaming > 0) {
    throw new Error(`B 基线即泄漏：${JSON.stringify(baseBStable)}`);
  }
  console.log(`  ✓ B 基线稳定（msg=${baseB.count} streaming=${baseBStable.streaming}）`);

  // 3) A↔B 往返两轮：每次回 B 断言指纹一致、无 streaming；回 A 断言气泡仍在
  for (let round = 1; round <= 2; round++) {
    await openSession(TITLE_A);
    await waitFor((s) => s.streaming > 0, 12000, `第${round}轮切回 A 后 streaming 气泡丢失`);
    await openSession(TITLE_B);
    const settled = await waitFor((s) => s.first.includes("B 会话的用户消息") && s.count === 2, 15000, `第${round}轮 B 未水合`);
    await page.waitForTimeout(1500);
    const after = await viewSnapshot();
    if (after.fingerprint !== baseBStable.fingerprint || after.streaming > 0 || after.count !== baseBStable.count) {
      throw new Error(`第${round}轮切回 B 后串页：base=${baseBStable.fingerprint} actual=${after.fingerprint} streaming=${after.streaming}`);
    }
    console.log(`  ✓ 第${round}轮往返 B 无泄漏（msg=${after.count} streaming=${after.streaming}）`);
  }

  // 4) 判定
  if (pageErrors.length) throw new Error(`pageerror ×${pageErrors.length}：${pageErrors.slice(0, 3).join(" | ")}`);
  if (consoleErrors.length) throw new Error(`console.error ×${consoleErrors.length}：${consoleErrors.slice(0, 3).join(" | ")}`);
  console.log("\n✓ 会话切换串页回归通过（运行中气泡未泄漏进其他会话，合法气泡未被误删）");
} catch (error) {
  exitCode = 1;
  console.error(`\n✗ 串页回归失败：${String(error?.message || error)}`);
  if (pageErrors.length) console.error(`pageerror: ${pageErrors.join(" | ")}`);
  if (consoleErrors.length) console.error(`console.error: ${consoleErrors.slice(0, 5).join(" | ")}`);
} finally {
  browserClosed = true;
  await browser.close().catch(() => {});
}
process.exit(exitCode);
