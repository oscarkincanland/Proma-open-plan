#!/usr/bin/env node
/**
 * 开关设置端到端测试（2026-11-19-002 阶段3，用户明确的主验收）。
 *
 * 隔离：空闲端口 + 临时目录全套 env（恢复隔离测试.mjs 先例）+ 临时 flags 文件，
 * 不触碰用户真实 `.oaw/` 与 3002 端口；playwright chromium 驱动真实页面。
 * 判据（§7 端到端判据 1–10，任一不满足即 FAIL 退出码 1）：
 *   1 分区渲染（常用组展开、高级组折叠，展开后按组计数；反向/重启徽标）
 *   2 切换即生效（设置页 toggle → +菜单「创作画布」门控翻转 → GET/文件一致）
 *   3 跨标签页同步（B 页不刷新收到 runtime_flags_changed）
 *   4 env 接管锁定（徽标 + 不可切换 + POST 不改值）
 *   5 restartRequired 徽标（dataAdapters）
 *   6 护栏二次确认（teamGuard：取消不生效 / 确认生效）
 *   7 持久化与重启恢复（刷新 + 重启实例按文件值生效）
 *   8 坏路径（白名单外键/非布尔 400；写盘失败 500 快照不变）
 *   9 JSON 容错（损坏配置启动回落默认值）
 *  10 无错误边界（无 pageerror / 非噪声 console.error）
 *
 * 运行：node scripts/开关设置端到端测试.mjs   （npm run test:flags-e2e）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const pageErrors = [];
const consoleErrors = [];
const NOISE = [/favicon/i, /devtools/i, /Download the React DevTools/i, /Failed to load resource/i, /ERR_CONNECTION_RESET/i, /ERR_CONNECTION_REFUSED/i];

function loadChromium() {
  const candidates = [
    path.join(PROJECT_DIR, "node_modules"),
    path.join(PROJECT_DIR, "client", "node_modules"),
    path.join(PROJECT_DIR, "..", "pi-web"),
    path.join(process.env.APPDATA || "", "npm", "node_modules"),
  ];
  for (const dir of candidates) {
    try {
      const require = createRequire(path.join(dir, "noop.js"));
      return require("playwright").chromium;
    } catch {}
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) {
    fail(`${name}: ${e.message}`);
    // 失败现场截图，便于诊断 UI 状态
    try { await page1Ref?.screenshot({ path: path.join(tmpRootDebug, `fail-${Date.now()}.png`), fullPage: false }); } catch {}
  }
}
let page1Ref = null;
const tmpRootDebug = path.join(os.tmpdir(), `oaw-flags-e2e-shots-${process.pid}`);
fs.mkdirSync(tmpRootDebug, { recursive: true });

/** 拉起隔离服务实例（ambient OAW_ 开关变量清空，除非 extraEnv 显式注入）。 */
function startServer({ port, flagsFile, extraEnv = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-flags-e2e-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^OAW_(?!RUNTIME_FLAGS_FILE|RUNS_DIR|WRITE_LOCK_DIR|EVENT_DIR|INSTANCE_DIR|GOAL_DIR|DISABLE_RECOVERY)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    PORT: String(port),
    HOST: "127.0.0.1",
    OAW_RUNTIME_FLAGS_FILE: flagsFile,
    OAW_RUNS_DIR: path.join(dir, "runs"),
    OAW_WRITE_LOCK_DIR: path.join(dir, "locks"),
    OAW_EVENT_DIR: path.join(dir, "events"),
    OAW_INSTANCE_DIR: path.join(dir, "instances"),
    OAW_GOAL_DIR: path.join(dir, "goals"),
    OAW_DISABLE_RECOVERY: "1",
    ...extraEnv,
  });
  const child = spawn(process.execPath, ["server/index.mjs"], { cwd: PROJECT_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  const started = (async () => {
    for (let i = 0; i < 160; i += 1) {
      if (out.includes("running at")) return true;
      await sleep(250);
    }
    return false;
  })();
  return {
    child, dir, env, started,
    baseUrl: `http://127.0.0.1:${port}`,
    eventsFile: path.join(dir, "events", "事件流.jsonl"),
    eventsCount(type = null) {
      try {
        const events = fs.readFileSync(this.eventsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        return type ? events.filter((e) => e.type === type).length : events.length;
      } catch { return 0; }
    },
    async stop() {
      try { child.kill(); } catch {}
      await sleep(300);
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
    },
  };
}

const get = async (base) => (await fetch(`${base}/api/runtime-flags`, { cache: "no-store" })).json();
const post = async (base, body) => {
  const r = await fetch(`${base}/api/runtime-flags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** 等待谓词成立（默认 4s），超时抛错。 */
async function waitFor(desc, fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch {}
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${desc}`);
    await sleep(150);
  }
}

/* ===== UI 助手 ===== */
async function openFlagsSection(page) {
  // 设置是模块视图（activeModule === "settings" → .module-view），按钮为 toggle 语义。
  // force 点击：个别状态下主界面浮层会遮挡命中测试，UI 锚点本身固定可靠。
  if (!(await page.locator(`.module-view`).isVisible().catch(() => false))) {
    await page.click(`button[title="设置（含记忆）"]`, { force: true });
  }
  await page.locator(`.module-view`).waitFor({ state: "visible", timeout: 8000 });
  await page.locator(`.module-view .settings-nav-item`, { hasText: "功能开关" }).click();
  await page.locator(`#settings-flags [data-flag-key="creativeCanvas"]`).waitFor({ state: "visible", timeout: 8000 });
}
async function closeSettings(page) {
  if (!(await page.locator(`.module-view`).isVisible().catch(() => false))) return;
  // 返回对话按钮关闭模块视图；若一次没关掉（toggle 语义）再补一次。
  for (let i = 0; i < 2; i += 1) {
    await page.locator(`.module-view .module-back`).click({ force: true });
    if (await page.locator(`.module-view`).waitFor({ state: "hidden", timeout: 2500 }).then(() => true).catch(() => false)) return;
  }
}
/** 切换开关：打开设置 → （高级组按需展开）→ 定位行 → 切换 →（护栏开关在应用内确认框处置）→ 关闭模块视图。 */
async function toggleFlagViaSettings(page, key, next, { confirm = null } = {}) {
  await openFlagsSection(page);
  let box = page.locator(`[data-flag-key="${key}"] input[type="checkbox"]`);
  if (!(await box.count())) {
    await page.locator(`#settings-flags button.sp-opt`, { hasText: "展开" }).click();
    box = page.locator(`[data-flag-key="${key}"] input[type="checkbox"]`);
  }
  await box.waitFor({ state: "visible", timeout: 4000 });
  if ((await box.isChecked()) !== next) await box.click();
  if (confirm !== null) await confirmDialog(page, confirm);
  await closeSettings(page);
}
/** 「+ → 打开新视图」菜单里「创作画布」菜单项是否渲染（creativeCanvas 门控的确定性锚点）。 */
async function canvasMenuItemVisible(page) {
  await page.click(`[aria-label="打开新视图"]`, { force: true });
  await page.locator(`.canvas-plus-menu`).waitFor({ state: "visible", timeout: 4000 });
  const count = await page.locator(`.canvas-plus-menu [role="menuitem"]`, { hasText: "创作画布" }).count();
  await page.mouse.click(6, 300);
  await page.locator(`.canvas-plus-menu`).waitFor({ state: "hidden", timeout: 2000 }).catch(() => {});
  return count > 0;
}

console.log("\n▶ 开关设置端到端");
const chromium = loadChromium();
if (!chromium) {
  console.error("  ✗ playwright chromium 不可用（跳过不算通过）");
  process.exit(2);
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-flags-e2e-root-"));
const flagsFile = path.join(tmpRoot, "runtime-flags.json");
const port = await freePort();
const server = startServer({ port, flagsFile });
if (!(await server.started)) {
  console.error("  ✗ 服务实例未能在超时内启动");
  process.exit(2);
}

const browser = await (async () => {
  // 与 聊天界面冒烟检查.mjs 同款回退：优先下载版 chromium，其次系统 Edge / Chrome 通道。
  for (const opts of [{}, { channel: "msedge" }, { channel: "chrome" }]) {
    try { return await chromium.launch({ headless: true, ...opts }); } catch {}
  }
  console.error("  ✗ 无可用浏览器内核（playwright chromium / msedge / chrome）——跳过不算通过");
  process.exit(2);
})();
const context = await browser.newContext();
const page1 = await context.newPage();
const page2 = await context.newPage();
for (const page of [page1, page2]) {
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = String(msg.text() || "");
    if (NOISE.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
}
/** 应用内确认框（FeedbackHost ConfirmDialog）：accept=true 点「确定」，否则「取消」。 */
async function confirmDialog(page, accept) {
  const dlg = page.locator(`[role="alertdialog"][aria-label="确认操作"]`);
  await dlg.waitFor({ state: "visible", timeout: 4000 });
  await dlg.locator(`button`, { hasText: accept ? "确定" : "取消" }).first().click();
}

try {
  await page1.goto(server.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  page1Ref = page1;
  await page1.locator(`button[title="设置（含记忆）"]`).waitFor({ state: "visible", timeout: 20000 });

  await test("① 分区渲染：常用组展开、高级组折叠、展开后按组计数与白名单一致", async () => {
    await openFlagsSection(page1);
    const flagsRoot = page1.locator(`#settings-flags`);
    const data = await get(server.baseUrl);
    const commonKeys = data.editable.filter((f) => f.group === "常用").map((f) => f.key);
    const advancedKeys = data.editable.filter((f) => f.group === "高级").map((f) => f.key);
    for (const key of commonKeys) {
      await flagsRoot.locator(`[data-flag-key="${key}"]`).waitFor({ state: "visible", timeout: 4000 });
    }
    assert.equal(await flagsRoot.locator(`[data-flag-key="${advancedKeys[0]}"]`).count(), 0, "高级组默认折叠（行不在 DOM）");
    await flagsRoot.locator(`button.sp-opt`, { hasText: "展开" }).click();
    for (const key of advancedKeys) {
      await flagsRoot.locator(`[data-flag-key="${key}"]`).waitFor({ state: "visible", timeout: 4000 });
    }
    const rowCount = await flagsRoot.locator(`[data-flag-key]`).count();
    assert.equal(rowCount, data.editable.length, `行数 ${rowCount} 应与白名单 ${data.editable.length} 一致`);
    assert.ok(await flagsRoot.locator(`[data-flag-key="visualEffectsOff"] .sp-flag-tag.reverse`).count(), "visualEffectsOff 有反向标注");
    await closeSettings(page1);
  });

  await test("②+③ 切换即生效 + 跨标签页同步（B 页不刷新）", async () => {
    await page2.goto(server.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page2.locator(`[aria-label="打开新视图"]`).waitFor({ state: "visible", timeout: 20000 });
    assert.ok(await canvasMenuItemVisible(page1), "切换前 page1 菜单含创作画布");
    assert.ok(await canvasMenuItemVisible(page2), "切换前 page2 菜单含创作画布");
    await toggleFlagViaSettings(page1, "creativeCanvas", false);
    await waitFor("page1 菜单创作画布消失", async () => !(await canvasMenuItemVisible(page1)));
    assert.equal((await get(server.baseUrl)).flags.creativeCanvas, false, "GET 生效值翻转");
    assert.equal(JSON.parse(fs.readFileSync(flagsFile, "utf8")).creativeCanvas, false, "落盘语义键正确");
    // page2 不刷新：菜单应已同步消失（runtime_flags_changed → applyRuntimeFlagsSnapshot）
    await waitFor("page2 菜单创作画布同步消失", async () => !(await canvasMenuItemVisible(page2)), 6000);
    await toggleFlagViaSettings(page1, "creativeCanvas", true);
    await waitFor("GET 恢复 true", async () => (await get(server.baseUrl)).flags.creativeCanvas === true);
    await waitFor("page2 菜单恢复", async () => canvasMenuItemVisible(page2));
  });

  await test("⑥ 护栏二次确认：取消不生效 / 确认生效", async () => {
    assert.equal((await get(server.baseUrl)).flags.teamGuard, true, "teamGuard 默认开");
    // 取消：应用内确认框点「取消」→ 无 POST、仍开启
    await toggleFlagViaSettings(page1, "teamGuard", false, { confirm: false });
    await sleep(500);
    assert.equal((await get(server.baseUrl)).flags.teamGuard, true, "取消确认后仍开启");
    // 确认：点「确定」→ POST 生效
    await toggleFlagViaSettings(page1, "teamGuard", false, { confirm: true });
    try {
      await waitFor("teamGuard 关闭生效", async () => (await get(server.baseUrl)).flags.teamGuard === false);
    } catch (error) {
      const state = await get(server.baseUrl);
      throw new Error(`${error.message} | teamGuard=${state.flags.teamGuard} src=${state.sources.teamGuard} events=${server.eventsCount("runtime_flags_changed")}`);
    }
    // 恢复默认开启（开启方向无确认）
    await toggleFlagViaSettings(page1, "teamGuard", true);
    await waitFor("teamGuard 恢复", async () => (await get(server.baseUrl)).flags.teamGuard === true);
  });

  await test("⑤ restartRequired 徽标（dataAdapters）", async () => {
    await openFlagsSection(page1);
    await page1.locator(`#settings-flags button.sp-opt`, { hasText: "展开" }).click();
    const row = page1.locator(`[data-flag-key="dataAdapters"]`);
    await row.waitFor({ state: "visible", timeout: 4000 });
    assert.ok(await row.locator(`.sp-flag-tag.restart`).count(), "dataAdapters 行有「重启后生效」徽标");
    await closeSettings(page1);
  });

  await test("④ env 接管锁定：徽标 + 不可切换 + POST 不改值", async () => {
    const envServer = startServer({ port: await freePort(), flagsFile: path.join(tmpRoot, "env-flags.json"), extraEnv: { OAW_CREATIVE_CANVAS: "1" } });
    try {
      assert.ok(await envServer.started, "env 实例启动");
      const page3 = await context.newPage();
      try {
        await page3.goto(envServer.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await openFlagsSection(page3);
        const row = page3.locator(`[data-flag-key="creativeCanvas"]`);
        assert.match(String(await row.locator(`.sp-flag-badge.env`).textContent()), /环境变量接管/, "锁定徽标可见");
        assert.equal(await row.locator(`input[type="checkbox"]`).isDisabled(), true, "Toggle 不可点");
        await closeSettings(page3);
      } finally {
        await page3.close();
      }
      const { status, body } = await post(envServer.baseUrl, { flags: { creativeCanvas: false } });
      assert.equal(status, 200);
      assert.deepEqual(body.envLocked, ["creativeCanvas"], "POST 响应标注 envLocked");
      assert.equal(body.flags.creativeCanvas, true, "env 优先，值不变");
    } finally {
      await envServer.stop();
    }
  });

  await test("⑧ 坏路径：白名单外键/非布尔 400；写盘失败 500 快照不变", async () => {
    assert.equal((await post(server.baseUrl, { flags: { notAFlag: true } })).status, 400, "白名单外键 400");
    assert.equal((await post(server.baseUrl, { flags: { creativeCanvas: "yes" } })).status, 400, "非布尔 400");
    // 写盘失败：父路径预置为文件 → mkdir 必败（跨平台可靠）
    const blocker = path.join(tmpRoot, "not-a-dir");
    fs.writeFileSync(blocker, "blocker", "utf8");
    const failServer = startServer({ port: await freePort(), flagsFile: path.join(blocker, "runtime-flags.json") });
    try {
      assert.ok(await failServer.started, "坏配置路径下服务仍可启动");
      const { status, body } = await post(failServer.baseUrl, { flags: { creativeCanvas: false } });
      assert.equal(status, 500, `写盘失败应 500，实际 ${status}`);
      assert.ok(body?.error, "500 可解释错误");
      assert.equal((await get(failServer.baseUrl)).flags.creativeCanvas, true, "快照保持原状");
      assert.equal(failServer.eventsCount("runtime_flags_changed"), 0, "失败不广播");
    } finally {
      await failServer.stop();
    }
  });

  await test("⑦ 持久化与重启恢复", async () => {
    await toggleFlagViaSettings(page1, "creativeCanvas", false);
    await waitFor("关闭生效", async () => (await get(server.baseUrl)).flags.creativeCanvas === false);
    // 追加 cadAgent:false 后重启（同 flagsFile；加载期文件摄取的进程级证明）
    const persisted = JSON.parse(fs.readFileSync(flagsFile, "utf8"));
    fs.writeFileSync(flagsFile, JSON.stringify({ ...persisted, cadAgent: false }));
    await server.stop();
    const restarted = startServer({ port: await freePort(), flagsFile, extraEnv: {} });
    try {
      assert.ok(await restarted.started, "重启启动");
      // 不带 env：新实例按文件值生效；白名单/加载期求值点在 热更测试④ 以函数级断言覆盖
      const data = await get(restarted.baseUrl);
      assert.equal(data.flags.creativeCanvas, false, "重启后 creativeCanvas 按文件值关闭");
      assert.equal(data.flags.cadAgent, false, "重启后 cadAgent 按文件值关闭");
      assert.equal(data.sources.creativeCanvas, "file", "来源为 file");
      // UI 刷新后仍关闭（重启换了端口，goto 新地址）
      await page1.goto(restarted.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page1.locator(`button[title="设置（含记忆）"]`).waitFor({ state: "visible", timeout: 20000 });
      await openFlagsSection(page1);
      assert.equal(await page1.locator(`[data-flag-key="creativeCanvas"] input[type="checkbox"]`).isChecked(), false, "刷新后设置页仍显示关闭");
      await closeSettings(page1);
      assert.equal(await canvasMenuItemVisible(page1), false, "重启后菜单无创作画布");
      // 恢复默认，避免影响 ⑨ 判定（⑨ 用独立实例，此处仅复位文件）
      fs.writeFileSync(flagsFile, JSON.stringify({}));
    } finally {
      await restarted.stop();
    }
  });

  await test("⑨ JSON 容错：损坏配置启动回落默认值", async () => {
    const corruptFile = path.join(tmpRoot, "corrupt-flags.json");
    fs.writeFileSync(corruptFile, "corrupt{{{", "utf8");
    const badServer = startServer({ port: await freePort(), flagsFile: corruptFile });
    try {
      assert.ok(await badServer.started, "损坏配置下服务正常启动");
      assert.equal((await get(badServer.baseUrl)).flags.creativeCanvas, true, "回落默认值（开）");
    } finally {
      await badServer.stop();
    }
  });

  await test("⑩ 无错误边界：无 pageerror / 非噪声 console.error", async () => {
    const realPageErrors = pageErrors.filter((t) => !NOISE.some((re) => re.test(t)));
    assert.equal(realPageErrors.length, 0, `pageerror: ${realPageErrors.slice(0, 3).join(" | ")}`);
    assert.equal(consoleErrors.length, 0, `console.error: ${consoleErrors.slice(0, 3).join(" | ")}`);
  });
} finally {
  try { server.child?.kill(); } catch {}
  await server.stop().catch(() => {});
  await browser.close().catch(() => {});
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
}

console.log(`\n开关设置端到端测试：${failed ? "失败" : "通过 8 项（判据 1–10）"}`);
process.exit(failed ? 1 : 0);
