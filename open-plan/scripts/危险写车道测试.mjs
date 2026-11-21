#!/usr/bin/env node
/**
 * 危险写车道回归（计划 2026-11-19-001 批次 C）。
 *
 * 背景：Pi 内核按 maxParallelToolCalls 并行执行同批工具；写文件有 per-file 写锁，
 * 但两个**破坏性操作**（删除/固化/导入/覆盖/需审批）之间没有互斥，并发时对同一状态
 * 的判断不确定。本测试锁定：
 *   1. 同一车道内的任务严格串行（前一个结束才开始下一个）；
 *   2. 单个任务抛错不阻塞后续任务，且不产生 unhandled rejection；
 *   3. 只读/普通写不进入车道（不牺牲常规并发）；
 *   4. agent.mjs 确实按元数据判断并走车道。
 *
 * 用法：node scripts/危险写车道测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSerialLane, needsDangerousLane } from "../server/危险写车道.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = async (名, 函数) => {
  try { await 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await test("任务严格串行：前一个结束后才启动下一个", async () => {
  const lane = createSerialLane();
  const order = [];
  const first = lane.run(async () => { order.push("a:start"); await delay(40); order.push("a:end"); });
  const second = lane.run(async () => { order.push("b:start"); await delay(5); order.push("b:end"); });
  assert.equal(lane.pending, 2, "排队期间应有两个待执行任务");
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  assert.equal(lane.pending, 0);
});

await test("单任务失败不阻塞后续任务", async () => {
  const lane = createSerialLane();
  const order = [];
  const bad = lane.run(async () => { order.push("bad"); throw new Error("boom"); });
  const good = lane.run(async () => { order.push("good"); });
  await assert.rejects(() => bad, /boom/);
  await good;
  assert.deepEqual(order, ["bad", "good"]);
  await lane.idle();
});

await test("只有破坏性/需审批工具需要车道", () => {
  assert.equal(needsDangerousLane({ destructive: true }), true);
  assert.equal(needsDangerousLane({ forceConfirm: true }), true);
  assert.equal(needsDangerousLane({ needsApproval: true }), true);
  assert.equal(needsDangerousLane({ readOnly: true, destructive: false }), false);
  assert.equal(needsDangerousLane({ readOnly: false }), false, "普通写不串行，避免牺牲并发");
  assert.equal(needsDangerousLane(null), false);
});

await test("agent.mjs 按元数据判断并走车道（接线）", () => {
  const agent = read("server/agent.mjs");
  assert.match(agent, /import \{ createSerialLane, needsDangerousLane \} from "\.\/危险写车道\.mjs"/);
  assert.match(agent, /const laneMetadata = getToolMetadata\(tool\.name\)/);
  assert.match(agent, /dangerousWriteLane\.run\(\(\) => original\(/);
  assert.match(agent, /: await original\(toolCallId, effectiveParams, signal\)/, "非破坏性调用应保持原路径");
});

if (failed) {
  console.error("\n危险写车道回归：存在失败");
  process.exit(1);
}
console.log("\n危险写车道回归：全部通过");
