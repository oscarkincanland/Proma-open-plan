#!/usr/bin/env node
/**
 * 内核侧车契约测试（计划 2026-11-20-002 / v2）
 *
 * 目的：证明侧车（并发门 + 统计）委托 localBash 后，完整满足 Pi SDK
 * `BashOperations.exec` 契约：onData(Buffer) 回放、{ exitCode }、timeout（秒）、
 * AbortSignal、进程树终止、cwd/env 与错误文案。
 *
 * 不使用真实模型；SDK 工具定义直接执行本地命令。
 * 修复前（侧车自己 spawn、返回 {code,stdout}）本套件应失败（(no output)/undefined）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { BashSidecarManager, createSidecarBashOperations } from "../server/内核侧车.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CWD = ROOT;
const local = createLocalBashOperations();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}: ${error?.message || error}`);
  }
}

function makeOps(manager) {
  return createSidecarBashOperations(manager, local.exec.bind(local));
}

function toolFor(manager) {
  return createBashToolDefinition(CWD, { operations: makeOps(manager), exposeSessionEnvironment: false });
}

console.log("▶ 侧车契约（SDK BashOperations）");

await test("SDK 工具端到端：echo hi 有输出、exit_code=0、无 (no output)", async () => {
  const manager = new BashSidecarManager();
  const tool = toolFor(manager);
  const result = await tool.execute("tc-echo", { command: "echo hi" });
  const text = String(result?.content?.[0]?.text || "");
  assert.ok(text.includes("hi"), `content=${text.slice(0, 200)}`);
  assert.ok(!text.includes("(no output)"), "不应出现 (no output)");
  assert.ok(!/code undefined/i.test(text), "不应出现 undefined 退出码");
  assert.equal(result?.structuredContent?.exit_code, 0);
  assert.ok(manager.snapshot().bytes >= 2, "应统计到输出字节");
});

await test("真实命令：node --version / npm --version 经侧车可用", async () => {
  const manager = new BashSidecarManager();
  const tool = toolFor(manager);
  const nodeResult = await tool.execute("tc-node", { command: "node --version" });
  const nodeText = String(nodeResult?.content?.[0]?.text || "");
  assert.match(nodeText.trim(), /^v?\d+\.\d+/i, `node 版本输出异常: ${nodeText.slice(0, 200)}`);
  const npmResult = await tool.execute("tc-npm", { command: "npm --version" });
  const npmText = String(npmResult?.content?.[0]?.text || "");
  assert.match(npmText.trim(), /\d+\.\d+/i, `npm 版本输出异常: ${npmText.slice(0, 300)}`);
  assert.equal(npmResult?.structuredContent?.exit_code, 0);
});

await test("非零退出 + stderr：exit_code=3、isError、stderr 透出", async () => {
  const manager = new BashSidecarManager();
  const tool = toolFor(manager);
  const result = await tool.execute("tc-fail", { command: "node -e \"console.error('errmsg');process.exit(3)\"" });
  const text = String(result?.content?.[0]?.text || "");
  assert.ok(text.includes("errmsg"), `stderr 未透出: ${text.slice(0, 300)}`);
  assert.equal(result?.structuredContent?.exit_code, 3);
  assert.equal(result?.isError, true);
  assert.equal(manager.snapshot().failed, 1);
});

await test("timeout 单位=秒：timeout:1 约 1s 生效并抛 timeout", async () => {
  const manager = new BashSidecarManager();
  const exec = makeOps(manager).exec;
  const started = Date.now();
  await assert.rejects(
    () => exec("node -e \"setTimeout(()=>{}, 5000)\"", CWD, { timeout: 1 }),
    /timeout/i,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 800 && elapsed < 4000, `timeout 未按秒生效，elapsed=${elapsed}ms`);
  assert.equal(manager.snapshot().timeout, 1);
  assert.equal(manager.snapshot().active, 0);
});

await test("pre-abort：已取消信号直接拒绝 aborted", async () => {
  const manager = new BashSidecarManager();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => makeOps(manager).exec("echo never", CWD, { signal: controller.signal }), /aborted/i);
  assert.equal(manager.snapshot().aborted, 1);
  assert.equal(manager.snapshot().active, 0);
});

await test("运行中 abort：进程被终止、拒绝 aborted、槽位释放", async () => {
  const manager = new BashSidecarManager();
  const controller = new AbortController();
  const started = Date.now();
  const running = makeOps(manager).exec("node -e \"setTimeout(()=>{}, 5000)\"", CWD, { signal: controller.signal });
  await sleep(200);
  controller.abort();
  await assert.rejects(() => running, /aborted/i);
  assert.ok(Date.now() - started < 5000, "abort 后不应等命令自然结束");
  assert.equal(manager.snapshot().active, 0);
});

await test("排队中 abort：出队不泄漏槽位", async () => {
  const manager = new BashSidecarManager({ maxConcurrency: 1 });
  const exec = makeOps(manager).exec;
  const first = exec("node -e \"setTimeout(()=>{}, 1200)\"", CWD, {});
  await sleep(150);
  const controller = new AbortController();
  const second = exec("echo queued", CWD, { signal: controller.signal });
  await sleep(100);
  controller.abort();
  await assert.rejects(() => second, /aborted/i);
  await first;
  assert.equal(manager.snapshot().active, 0);
});

await test("并发上限：6 条并发峰值 ≤ 4", async () => {
  const manager = new BashSidecarManager({ maxConcurrency: 4 });
  const exec = makeOps(manager).exec;
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, manager.snapshot().active); }, 20);
  try {
    await Promise.all(Array.from({ length: 6 }, (_, index) => exec(`node -e "setTimeout(()=>{}, 300)"`, CWD, {}).catch(() => null)));
  } finally {
    clearInterval(timer);
  }
  assert.ok(peak <= 4, `并发峰值 ${peak} > 4`);
  assert.equal(manager.snapshot().active, 0);
});

await test("坏 cwd / 空命令：可解释错误且槽位释放", async () => {
  const manager = new BashSidecarManager();
  const exec = makeOps(manager).exec;
  let badCwdError = null;
  try {
    await exec("echo hi", path.join(CWD, "definitely-not-exist-" + Date.now()), {});
  } catch (error) {
    badCwdError = error;
  }
  assert.ok(badCwdError, "坏 cwd 应抛可解释错误");
  assert.ok(String(badCwdError.message || "").length > 0);
  let emptyOutcome = null;
  try {
    emptyOutcome = await exec("   ", CWD, {});
  } catch (error) {
    emptyOutcome = error;
  }
  // 空命令由 localBash 决定语义（可能是 no-op 成功，也可能是错误）；侧车只保证不崩、不泄漏槽位。
  assert.ok(emptyOutcome !== null, "空命令应有结果（成功结果或可解释错误）");
  assert.equal(manager.snapshot().active, 0);
});

await test("agent.mjs 接线：sidecar 走适配器、backgroundJobs 不再被压制", async () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(agent, /createSidecarBashOperations/);
  assert.match(agent, /const sidecarBash = createSidecarBashOperations\(/);
  assert.match(agent, /await sidecarBash\.exec\(effectiveCommand, cwd \|\| ctx\.workspace, execOptions\)/);
  assert.match(agent, /const backgroundEnabled = RUNTIME_FLAGS\.backgroundJobs;/);
  assert.doesNotMatch(agent, /backgroundEnabled = RUNTIME_FLAGS\.backgroundJobs && !RUNTIME_FLAGS\.piBashSidecar/);
});

console.log(`\n内核侧车契约测试：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
