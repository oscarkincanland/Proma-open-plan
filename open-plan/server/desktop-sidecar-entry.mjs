/**
 * 桌面 sidecar 入口（ADR 0044 / 计划 2026-11-21-002 P1）。
 *
 * 为什么需要这一层：`server/服务入口.mjs` 的 `startDesktopService()` 设计给
 * Electron 主进程**进程内 import** 使用；而 Proma 壳采用 sidecar 子进程模型
 * （server 的 `uncaughtException → process.exit(1)` 语义与「监督循环拉起」假设
 * 决定了它必须独占一个进程）。本入口把 `startDesktopService()` 包成独立进程：
 *
 *   1. 解析命令行参数（--project-dir / --out 必填）；
 *   2. 调用 startDesktopService()（随机端口 + token + 注入 env + 就绪探测）；
 *   3. 把 {port, token, url} 写入 --out 指定的 ready 文件（壳读取后加载窗口）；
 *   4. 保持进程存活；SIGTERM/SIGINT 时尽力优雅退出。
 *
 * 用法（由 Proma main 以 ELECTRON_RUN_AS_NODE=1 spawn）：
 *   electron.exe server/desktop-sidecar-entry.mjs --project-dir <open-plan根> --out <ready文件> \
 *     [--user-data-dir <dir>] [--resources-dir <dir>] [--client-dist <dir>]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { startDesktopService } from "./服务入口.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      out[name] = "true";
    } else {
      out[name] = value;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const projectDir = path.resolve(String(args["project-dir"] || process.cwd()));
const outFile = args.out ? path.resolve(String(args.out)) : "";

if (!outFile) {
  console.error("[sidecar] 缺少 --out 参数（ready 文件路径）");
  process.exit(2);
}

try {
  // ADR 0044 P2：宿主桥参数透传为 env（server/index.mjs 监听后按 env 注入远程浏览器宿主）
  if (args["browser-bridge"]) process.env.OAW_BROWSER_HOST_BRIDGE = String(args["browser-bridge"]);
  if (args["bridge-token"]) process.env.OAW_BRIDGE_TOKEN = String(args["bridge-token"]);

  const service = await startDesktopService({
    projectDir,
    userDataDir: args["user-data-dir"] ? String(args["user-data-dir"]) : "",
    resourcesDir: args["resources-dir"] ? String(args["resources-dir"]) : "",
    clientDist: args["client-dist"] ? String(args["client-dist"]) : "",
  });

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify({ port: service.port, token: service.token, url: service.url, pid: process.pid }),
    "utf8",
  );
  console.log(`[sidecar] open-plan 服务就绪 ${service.url}（pid=${process.pid}）`);

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[sidecar] 收到 ${signal}，开始退出`);
    // index.mjs 对 SIGTERM 有优雅收尾链（写运行状态、关 runtimes）；交由其处理。
    process.kill(process.pid, "SIGTERM");
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => {
    // 到这里说明 index.mjs 的 SIGTERM 链未接管（或已处理完仍存活）；兜底直接退出。
    setTimeout(() => process.exit(0), 3000).unref?.();
  });

  // 保活：index.mjs 的监听句柄会维持事件循环；此定时器仅为双保险。
  setInterval(() => {}, 1 << 30);
} catch (error) {
  console.error("[sidecar] 启动失败:", error);
  try {
    writeFileSync(outFile, JSON.stringify({ error: String((error && error.message) || error) }), "utf8");
  } catch {}
  process.exit(1);
}
