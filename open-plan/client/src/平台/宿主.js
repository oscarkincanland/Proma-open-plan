/**
 * 宿主能力探测（平台适配层，ADR 0024）。
 *
 * 业务代码只问「能力有没有」，不问「是不是桌面」：
 *   if (平台能力.原生文件对话框) … 而不是 if (isDesktop) …
 *
 * 浏览器形态下 preload 不注入 window.__OAW_HOST__，所有原生能力自然为 false，
 * 调用方按各自回退路径执行（<input type=file> / 服务端接口）。
 */

/**
 * Proma 壳适配（ADR 0044 / 计划 2026-11-21-002 P2）。
 * Proma preload 暴露 window.electronAPI（白名单桥），把其既有能力映射为
 * open-plan 宿主契约（__OAW_HOST__）；缺口经 guiju:select-files IPC 最小追加。
 * 注意重名陷阱：Proma 的 openFile = 系统打开（≠ open-plan 的「选择文件」）。
 */
function createPromaBridge(api) {
  return {
    isDesktop: true,
    async openFile(options) {
      // selectFiles（ADR 0044 追加）：返回 {canceled, paths}，契约一致
      if (typeof api.selectFiles === "function") {
        return api.selectFiles({
          title: options?.title,
          filters: options?.filters,
        });
      }
      return { canceled: true, paths: [] };
    },
    async openDirectory(options) {
      if (typeof api.openFolderDialog === "function") {
        const result = await api.openFolderDialog();
        return result ? { canceled: false, paths: [result.path] } : { canceled: true, paths: [] };
      }
      return { canceled: true, paths: [] };
    },
    async openPath(target) {
      if (typeof api.systemOpenFile === "function") {
        try {
          await api.systemOpenFile(String(target));
          return { ok: true, error: "" };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }
      return { ok: false, error: "宿主未提供 systemOpenFile" };
    },
    async showItemInFolder(target) {
      if (typeof api.showItemInFolder === "function") {
        try {
          const ok = await api.showItemInFolder(String(target));
          return { ok: Boolean(ok), error: "" };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }
      return { ok: false, error: "宿主未提供 showItemInFolder" };
    },
    // 内嵌浏览器视图边界上报：preload IPC 直达（ADR 0044 P2，与自研壳 __OAW_HOST__.browser 同构）
    browser: {
      async setBounds(key, bounds) {
        if (typeof api.browserSetBounds !== "function") return { ok: false };
        try { return await api.browserSetBounds(String(key), bounds || {}); } catch { return { ok: false }; }
      },
      async setVisible(key, visible) {
        if (typeof api.browserSetVisible !== "function") return { ok: false };
        try { return await api.browserSetVisible(String(key), visible !== false); } catch { return { ok: false }; }
      },
    },
    // 窗口控制（ADR 0044 P5：Proma 壳 frameless 窗口的标题栏承接，
    // 复用 Proma preload 既有 window:minimize/maximize/close IPC，不新增通道）
    window: {
      async minimize() {
        if (typeof api.windowMinimize !== "function") return { ok: false };
        try { await api.windowMinimize(); return { ok: true }; } catch { return { ok: false }; }
      },
      async toggleMaximize() {
        if (typeof api.windowMaximize !== "function") return { ok: false };
        try { await api.windowMaximize(); return { ok: true }; } catch { return { ok: false }; }
      },
      async close() {
        if (typeof api.windowClose !== "function") return { ok: false };
        try { await api.windowClose(); return { ok: true }; } catch { return { ok: false }; }
      },
    },
  };
}

/** 读取 preload 注入的宿主桥（不存在即浏览器形态）。 */
export function hostBridge() {
  if (typeof window === "undefined") return null;
  if (window.__OAW_HOST__) return window.__OAW_HOST__;
  const api = window.electronAPI;
  if (api && typeof api === "object" && typeof api.selectFiles === "function") {
    // 缓存适配桥，保证多次调用返回同一对象
    if (!window.__OAW_PROMA_BRIDGE__) window.__OAW_PROMA_BRIDGE__ = createPromaBridge(api);
    return window.__OAW_PROMA_BRIDGE__;
  }
  return null;
}

/** 是否桌面宿主。 */
export function isDesktopHost() {
  return Boolean(hostBridge()?.isDesktop);
}

/** 桌面窗口控制能力（仅 Proma 壳提供；浏览器形态返回 null）。 */
export function 桌面窗口控制() {
  if (!isDesktopHost()) return null;
  return hostBridge()?.window || null;
}

/** 能力表：每一项都是「有没有」，不是「什么形态」。 */
export const 平台能力 = {
  get 原生文件对话框() { return typeof hostBridge()?.openFile === "function"; },
  get 原生目录对话框() { return typeof hostBridge()?.openDirectory === "function"; },
  get 系统打开文件() { return typeof hostBridge()?.openPath === "function"; },
  get 文件管理器定位() { return typeof hostBridge()?.showItemInFolder === "function"; },
  /** 桌面端内置浏览器走原生视图（无帧流）；浏览器端走系统 Edge + CDP。 */
  get 内嵌浏览器视图() { return Boolean(hostBridge()?.isDesktop); },
};

/** 宿主信息（异步，仅在桌面宿主可用）。 */
export async function 宿主信息() {
  const bridge = hostBridge();
  if (!bridge?.info) return null;
  try { return await bridge.info(); } catch { return null; }
}

/** 等待主进程下发服务地址（端口 + token），浏览器形态立即返回 null。 */
export function onHostReady(callback) {
  const bridge = hostBridge();
  if (!bridge?.onReady) return () => {};
  return bridge.onReady(callback) || (() => {});
}
