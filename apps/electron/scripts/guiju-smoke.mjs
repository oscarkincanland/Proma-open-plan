#!/usr/bin/env node
/**
 * GuiJu（open-plan × Proma）桌面产物冒烟测试（不依赖 GUI，ADR 0044 / 计划 2026-11-21-002 P5）。
 *
 * 移植自 open-plan scripts/桌面/产物冒烟.mjs，按 Proma 打包形态调整：
 *   - main 进程在 app.asar 内（Proma 自身 renderer），open-plan 应用内核在
 *     resources/open-plan/（extraResources：server 源码 + client/dist + node_modules 闭包 + bin）
 *   - server 以 sidecar（ELECTRON_RUN_AS_NODE）运行；冒烟直接 import 资源里的
 *     server/服务入口.mjs（纯 Node 可跑），验证资源闭包完整性 + 服务可用性；
 *     ELECTRON_RUN_AS_NODE spawn 链路由真机 GUI 验证覆盖
 *
 * 用法:
 *   node scripts/guiju-smoke.mjs                       # 默认测 out/win-unpacked
 *   node scripts/guiju-smoke.mjs --dir <win-unpacked 目录>
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir") >= 0 ? args[args.indexOf("--dir") + 1] : "";
const UNPACKED = path.resolve(dirArg || path.join(HERE, "..", "out", "win-unpacked"));
const OP_DIR = path.join(UNPACKED, "resources", "open-plan");

const results = [];
let failed = false;
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failed = true;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log(`\n▶ GuiJu 产物冒烟：${UNPACKED}\n`);

  // ---- 0. 产物结构 ----
  console.log("▶ 产物结构（Proma 壳 + open-plan 内核闭包）");
  const required = [
    // Proma 壳（electron-builder productName: Proma）
    "Proma.exe",
    "resources/app.asar",
    // open-plan 应用内核（extraResources to: open-plan）
    "resources/open-plan/server/index.mjs",
    "resources/open-plan/server/服务入口.mjs",
    "resources/open-plan/server/desktop-sidecar-entry.mjs",
    "resources/open-plan/client/dist/index.html",
    "resources/open-plan/package.json",
    "resources/open-plan/node_modules/express/package.json",
    "resources/open-plan/bin/清单.json",
    "resources/open-plan/docs/规范/Office排版规范.md",
  ];
  for (const rel of required) {
    check(`存在 ${rel}`, fs.existsSync(path.join(UNPACKED, rel)));
  }

  // ---- 1. 启动资源目录内的服务（纯 Node，同 sidecar 语义）----
  console.log("\n▶ 启动 open-plan 服务（资源闭包完整性验证）");
  const entryUrl = pathToFileURL(path.join(OP_DIR, "server", "服务入口.mjs")).href;
  const { startDesktopService } = await import(entryUrl);
  const svc = await startDesktopService({
    projectDir: OP_DIR,
    userDataDir: path.join(process.env.TEMP || OP_DIR, "guiju-smoke"),
    resourcesDir: OP_DIR,
    clientDist: path.join(OP_DIR, "client", "dist"),
  });
  const base = svc.url;
  check("服务监听随机端口", svc.port > 0, `port=${svc.port}`);
  check("签发 API token", (svc.token || "").length >= 32, `len=${(svc.token || "").length}`);

  const auth = { headers: { Authorization: `Bearer ${svc.token}` } };

  // ---- 2. SPA 与静态资源 ----
  console.log("\n▶ SPA 与静态资源");
  const index = await fetch(`${base}/`);
  const html = await index.text();
  check("GET / 返回 200", index.status === 200, String(index.status));
  check("返回 HTML", /text\/html/.test(index.headers.get("content-type") || ""));
  check("HTML 含应用挂载点", /id="root"/.test(html));
  const assets = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((m) => m[1]);
  check("HTML 引用前端资源", assets.length > 0, `${assets.length} 个`);
  let assetOk = 0;
  for (const asset of assets.slice(0, 6)) {
    const res = await fetch(new URL(asset, base).href);
    if (res.ok) assetOk += 1;
    await res.arrayBuffer();
  }
  check("前端资源可加载", assetOk === Math.min(assets.length, 6), `${assetOk}/${Math.min(assets.length, 6)}`);

  // ---- 3. 关键 API ----
  console.log("\n▶ 关键 API");
  const endpoints = ["/api/status", "/api/sessions", "/api/workspaces", "/api/models", "/api/browser/state?client=smoke&thread=t"];
  for (const ep of endpoints) {
    try {
      const res = await fetch(base + ep, auth);
      check(`GET ${ep}`, res.ok, String(res.status));
      await res.arrayBuffer();
    } catch (error) {
      check(`GET ${ep}`, false, String(error?.message || error).slice(0, 80));
    }
  }

  // ---- 4. 鉴权 ----
  console.log("\n▶ 鉴权");
  const noToken = await fetch(`${base}/api/sessions`);
  check("无 token 访问 API 被拒", noToken.status === 401 || noToken.status === 403, String(noToken.status));
  await noToken.arrayBuffer();

  // ---- 5. 桌面运行语义 ----
  console.log("\n▶ 桌面运行语义");
  const status = await fetch(`${base}/api/status`, auth);
  const statusBody = await status.json().catch(() => ({}));
  check("/api/status 可解析", status.ok && typeof statusBody === "object");
  // AGPL 合规：AGPL-3.0 文本随包（衍生作品分发义务，P5 任务 3）
  const licenseCandidates = ["resources/LICENSE", "LICENSE"];
  check("AGPL LICENSE 随包", licenseCandidates.some((rel) => fs.existsSync(path.join(UNPACKED, rel))));

  // ---- 收尾 ----
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n▶ 冒烟结果：${passed}/${results.length} 通过${failed ? "（存在失败项）" : ""}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("\n[guiju-smoke] 冒烟中断:", error);
  process.exit(1);
});
