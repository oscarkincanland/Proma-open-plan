#!/usr/bin/env node
/**
 * 运行开关 API 契约测试（2026-11-19-002 阶段2）。
 *
 * 拉起隔离服务实例（空闲端口 + 临时目录全套 env，沿用 恢复隔离测试.mjs 先例，
 * 不触碰用户真实 `.oaw/` 与 3002 端口），覆盖 GET/POST /api/runtime-flags 契约
 * 与 runtime_flags_changed 事件落盘/广播：
 *   ① GET 形态：flags 快照 + sources + editable 白名单元数据（restartRequired/reverse/confirmOnDisable）
 *   ② POST 合法键：写盘语义键 → 热更 → GET/状态一致 → runtime_flags_changed 落盘且 data.flags 为全量快照
 *   ③ 白名单外键 / 非布尔值 → 400，且文件与快照不变
 *   ④ env 接管键：POST 跳过写盘并在响应标注 envLocked
 *   ⑤ 写盘失败（flags 路径指向目录，EISDIR 跨平台）→ 500，快照不变、无新事件
 *
 * 运行：node scripts/运行开关API契约测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); }
}

/** 探测一个空闲端口（探测后立即释放，服务随后显式绑定）。 */
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

/** 拉起一个隔离服务实例；ambient OAW_ 开关变量清空以保证判据确定性。 */
async function startServer({ port, flagsFile, extraEnv = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-flags-api-"));
  const runsDir = path.join(dir, "runs");
  const instanceDir = path.join(dir, "instances");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(instanceDir, { recursive: true });
  const env = { ...process.env };
  // 清掉本机可能全局设置的 OAW_ 开关变量，避免 env 接管干扰契约判据
  for (const key of Object.keys(env)) if (/^OAW_(?!RUNTIME_FLAGS_FILE|RUNS_DIR|WRITE_LOCK_DIR|EVENT_DIR|INSTANCE_DIR|GOAL_DIR|DISABLE_RECOVERY)/.test(key)) delete env[key];
  Object.assign(env, {
    PORT: String(port),
    HOST: "127.0.0.1",
    OAW_RUNTIME_FLAGS_FILE: flagsFile,
    OAW_RUNS_DIR: runsDir,
    OAW_WRITE_LOCK_DIR: path.join(dir, "locks"),
    OAW_EVENT_DIR: path.join(dir, "events"),
    OAW_INSTANCE_DIR: instanceDir,
    OAW_GOAL_DIR: path.join(dir, "goals"),
    OAW_DISABLE_RECOVERY: "1",
    ...extraEnv,
  });
  const child = spawn(process.execPath, ["server/index.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  let started = false;
  for (let i = 0; i < 160 && !started; i += 1) {
    if (out.includes("running at")) started = true;
    else await sleep(250);
  }
  return {
    child,
    dir,
    started,
    baseUrl: `http://127.0.0.1:${port}`,
    eventsFile: path.join(dir, "events", "事件流.jsonl"),
    eventsCount(type = null) {
      try {
        const lines = fs.readFileSync(this.eventsFile, "utf8").trim().split("\n").filter(Boolean);
        const events = lines.map((l) => JSON.parse(l));
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
  const r = await fetch(`${base}/api/runtime-flags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log("\n▶ 运行开关 API 契约（隔离实例）");
const flagsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oaw-flags-main-")), "runtime-flags.json");
const port = await freePort();
const server = await startServer({ port, flagsFile });
if (!server.started) {
  console.error("  ✗ 服务实例未能在超时内启动，契约测试无法进行");
  process.exit(2);
}

try {
  await test("① GET 形态：flags + sources + editable 元数据", async () => {
    const data = await get(server.baseUrl);
    assert.ok(data.flags && typeof data.flags === "object", "flags 快照存在");
    assert.ok(data.sources && typeof data.sources === "object", "sources 存在");
    assert.ok(Array.isArray(data.editable) && data.editable.length >= 40, `editable 白名单应≥40 项，实际 ${data.editable?.length}`);
    const byKey = new Map(data.editable.map((f) => [f.key, f]));
    assert.equal(byKey.get("dataAdapters")?.restartRequired, true, "dataAdapters 标注重启生效");
    assert.equal(byKey.get("visualEffectsOff")?.reverse, true, "visualEffectsOff 反向语义标注");
    assert.equal(byKey.get("teamGuard")?.confirmOnDisable, true, "teamGuard 关闭需确认");
    assert.equal(byKey.get("creativeCanvas")?.group, "常用");
    assert.equal(data.flags.creativeCanvas, true, "无 env 无文件时 creativeCanvas 默认开");
    assert.ok(data.flags.heartbeatChatMs > 0, "数值位随快照下发（全量快照形态）");
  });

  await test("② POST 合法键：写盘 + 热更 + GET 一致 + 事件全量快照", async () => {
    const beforeEvents = server.eventsCount("runtime_flags_changed");
    const { status, body } = await post(server.baseUrl, { flags: { creativeCanvas: false, mapReport: false }, client: "contract-test" });
    assert.equal(status, 200, `POST 应 200，实际 ${status} ${JSON.stringify(body)}`);
    assert.equal(body.flags.creativeCanvas, false, "响应快照已翻转");
    assert.equal(body.envLocked.length, 0, "无 env 接管");
    const data = await get(server.baseUrl);
    assert.equal(data.flags.creativeCanvas, false, "GET 与写盘一致");
    const onDisk = JSON.parse(fs.readFileSync(flagsFile, "utf8"));
    assert.equal(onDisk.creativeCanvas, false, "落盘语义键正确");
    assert.equal(onDisk.mapReport, false, "mapReport 落盘正确");
    // 事件：落盘 + 全量快照 + clientId
    assert.equal(server.eventsCount("runtime_flags_changed"), beforeEvents + 1, "runtime_flags_changed 已落盘 1 条");
    const lastEvent = JSON.parse(fs.readFileSync(server.eventsFile, "utf8").trim().split("\n").pop());
    assert.equal(lastEvent.type, "runtime_flags_changed", "事件类型正确");
    assert.equal(lastEvent.clientId, "contract-test", "事件携带发起页 clientId");
    assert.equal(lastEvent.data.flags.creativeCanvas, false, "data.flags 含本次变更");
    assert.ok(typeof lastEvent.data.flags.heartbeatChatMs === "number", "data.flags 为全量快照（含数值位），非 POST 子集");
    assert.equal(lastEvent.data.flags.mapReport, false, "data.flags 含 mapReport");
  });

  await test("③ 白名单外键 / 非布尔值 → 400 且状态不变", async () => {
    const before = await get(server.baseUrl);
    const eventsBefore = server.eventsCount("runtime_flags_changed");
    const bad1 = await post(server.baseUrl, { flags: { notAFlag: true } });
    assert.equal(bad1.status, 400, "白名单外键应 400");
    const bad2 = await post(server.baseUrl, { flags: { creativeCanvas: "yes" } });
    assert.equal(bad2.status, 400, "非布尔值应 400");
    const bad3 = await post(server.baseUrl, { flags: "nope" });
    assert.equal(bad3.status, 400, "flags 非对象应 400");
    const after = await get(server.baseUrl);
    const diffKeys = Object.keys({ ...before.flags, ...after.flags }).filter((k) => before.flags[k] !== after.flags[k]);
    assert.equal(diffKeys.length, 0, `400 后快照不变，差异键：${diffKeys.map((k) => `${k}: ${JSON.stringify(before.flags[k])} → ${JSON.stringify(after.flags[k])}`).join("; ")}`);
    assert.equal(server.eventsCount("runtime_flags_changed"), eventsBefore, "400 后无事件");
    assert.equal(JSON.parse(fs.readFileSync(flagsFile, "utf8")).notAFlag, undefined, "400 后文件无脏键");
  });

  await test("⑤ 写盘失败 → 500，快照不变、无新事件", async () => {
    const eventsBefore = server.eventsCount("runtime_flags_changed");
    // 注入方式：RUNTIME_FLAGS_FILE 的父路径是一个已存在的**文件**——mkdir 阶段即失败，
    // 跨平台可靠（Windows chmod 不阻断写入、目录路径场景已由服务端守卫兜底）。
    const badServer = await startServer({
      port: await freePort(),
      flagsFile: path.join(server.dir, "not-a-dir", "runtime-flags.json"),
      extraEnv: {},
    });
    // 把父路径预置为文件，使 mkdirSync(dirname) 必然失败
    fs.writeFileSync(path.join(server.dir, "not-a-dir"), "blocker", "utf8");
    try {
      assert.ok(badServer.started, "配置路径不可写时服务仍应启动（加载期 try/catch 容错）");
      const { status, body } = await post(badServer.baseUrl, { flags: { creativeCanvas: false } });
      assert.equal(status, 500, `写盘失败应 500，实际 ${status}`);
      assert.ok(body?.error, "500 返回可解释错误");
      const data = await get(badServer.baseUrl);
      assert.equal(data.flags.creativeCanvas, true, "写盘失败后快照保持原状（不热更）");
      assert.equal(badServer.eventsCount("runtime_flags_changed"), 0, "写盘失败不广播事件");
    } finally {
      await badServer.stop();
    }
  });

  await test("④ env 接管键：POST 跳过写盘并标注 envLocked", async () => {
    const envFlagsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oaw-flags-env-")), "runtime-flags.json");
    const envServer = await startServer({ port: await freePort(), flagsFile: envFlagsFile, extraEnv: { OAW_CREATIVE_CANVAS: "1" } });
    try {
      assert.ok(envServer.started, "env 实例启动");
      const data = await get(envServer.baseUrl);
      assert.equal(data.sources.creativeCanvas, "env", "来源标注 env");
      const { status, body } = await post(envServer.baseUrl, { flags: { creativeCanvas: false } });
      assert.equal(status, 200, "env 接管键 POST 仍 200（跳过而非报错）");
      assert.deepEqual(body.envLocked, ["creativeCanvas"], "响应标注 envLocked");
      assert.equal(body.flags.creativeCanvas, true, "env 优先，值不被改变");
      const onDisk = fs.existsSync(envFlagsFile) ? JSON.parse(fs.readFileSync(envFlagsFile, "utf8")) : {};
      assert.equal(onDisk.creativeCanvas, undefined, "env 接管键不写盘");
    } finally {
      await envServer.stop();
    }
  });
} finally {
  await server.stop();
}

console.log(`\n运行开关 API 契约测试：${failed ? "失败" : "通过 5 项"}`);
process.exit(failed ? 1 : 0);
