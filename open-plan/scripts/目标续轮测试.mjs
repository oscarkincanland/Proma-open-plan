#!/usr/bin/env node
/**
 * 目标空闲自动推进（2026-11-19-010 P2）判定层回归。
 *
 * 只测纯判定与提示词：真实启动 Run 的路径由 index.mjs 负责，验收在集成层。
 * 重点覆盖对抗审查提出的边界：取消不续、recovering 宽限、冷却、无进展转 blocked、失败退避。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const m = await import(pathToFileURL(path.join(ROOT, "server/目标续轮.mjs")).href);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const baseGoal = () => ({
  goalId: "goal_test",
  sessionId: "s1",
  text: "把口播稿的 PDF 版本做出来",
  status: "active",
  turns: 0,
  maxTurns: 0,
  budgetTokens: 0,
  usedTokens: 0,
});
const baseRun = (over = {}) => ({
  id: "run_1",
  status: "completed",
  finishedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  artifacts: [{ path: "a.docx" }],
  completion: { status: "success" },
  verificationStatus: "passed",
  finalText: "已完成第一版",
  ...over,
});
const decide = (opts = {}) => m.decideGoalRound({
  goal: baseGoal(),
  lastRun: baseRun(),
  enabled: true,
  globalMaxTurns: 10,
  processStartedAt: Date.now() - 60 * 60_000,
  now: Date.now(),
  ...opts,
});

console.log("\n▶ 开关与状态");

test("开关关闭时不动作", () => {
  assert.equal(decide({ enabled: false }).action, "none");
  assert.equal(decide({ enabled: false }).reason, "disabled");
});

test("目标非 active 不动作", () => {
  const goal = { ...baseGoal(), status: "paused" };
  assert.equal(decide({ goal }).action, "none");
  assert.equal(decide({ goal }).reason, "goal_paused");
  m.clearGoalRoundState(goal.goalId);
});

test("轮次达上限 → block/max_turns（goal.maxTurns 优先）", () => {
  assert.equal(decide({ goal: { ...baseGoal(), turns: 3, maxTurns: 3 } }).reason, "max_turns");
  assert.equal(decide({ goal: { ...baseGoal(), turns: 4 }, globalMaxTurns: 4 }).reason, "max_turns");
  assert.equal(m.effectiveMaxTurns({ maxTurns: 5 }, 10), 5, "goal.maxTurns 优先");
  assert.equal(m.effectiveMaxTurns({ maxTurns: 0 }, 10), 10, "0 时用全局硬顶");
});

test("Token 预算耗尽 → block/budget_limited", () => {
  const goal = { ...baseGoal(), budgetTokens: 100, usedTokens: 100 };
  assert.equal(decide({ goal }).reason, "budget_limited");
});

console.log("\n▶ 会话占用与等待");

test("会话忙 / 等审批 / 等用户 都不推进", () => {
  assert.equal(decide({ sessionBusy: true }).reason, "session_busy");
  assert.equal(decide({ pendingApprovals: 1 }).reason, "awaiting_approval");
  assert.equal(decide({ pendingAsks: 1 }).reason, "awaiting_user");
});

test("没有上一轮 Run 时不推进", () => {
  assert.equal(decide({ lastRun: null }).reason, "no_run");
});

test("上一轮仍在执行时不推进", () => {
  for (const status of ["running", "queued", "waiting_user", "cancel_requested", "finishing"]) {
    assert.equal(decide({ lastRun: baseRun({ status }) }).reason, "run_active", status);
  }
});

console.log("\n▶ 取消与恢复（对抗审查 M3/R3）");

test("任何来源的 cancelled 都不推进", () => {
  assert.equal(decide({ lastRun: baseRun({ status: "cancelled" }) }).reason, "cancelled");
  m.clearGoalRoundState("goal_test");
});

test("recovering 在宽限期内不续，宽限期后才续", () => {
  const goal = baseGoal();
  const run = baseRun({ status: "recovering", finishedAt: null });
  assert.equal(decide({ goal, lastRun: run, processStartedAt: Date.now() - 60_000 }).reason, "recovering_grace");
  const later = m.decideGoalRound({
    goal,
    lastRun: run,
    enabled: true,
    globalMaxTurns: 10,
    processStartedAt: Date.now() - 11 * 60_000,
    now: Date.now(),
  });
  assert.equal(later.action, "resume");
});

test("失败/中断走恢复通道（resume）", () => {
  for (const status of ["failed", "aborted"]) {
    m.clearGoalRoundState("goal_test");
    const decision = decide({ lastRun: baseRun({ status }) });
    assert.equal(decision.action, "resume", status);
  }
});

console.log("\n▶ 冷却与推进");

test("上一轮刚结束（冷却期内）不推进", () => {
  const goal = baseGoal();
  const run = baseRun({ finishedAt: new Date().toISOString() });
  assert.equal(decide({ goal, lastRun: run }).reason, "cooldown");
});

test("上一轮 completed 且目标未达成 → advance", () => {
  m.clearGoalRoundState("goal_test");
  const decision = decide();
  assert.equal(decision.action, "advance");
  assert.equal(decision.reason, "goal_incomplete");
});

console.log("\n▶ 无进展与失败退避");

test("连续两轮签名不变 → block/no_progress", () => {
  m.clearGoalRoundState("goal_p");
  const goal = { ...baseGoal(), goalId: "goal_p" };
  const run = baseRun({ id: "run_a" });
  m.noteRoundProgress(goal.goalId, run);           // 记录基线签名
  const same = decide({ goal, lastRun: baseRun({ id: "run_b" }) });
  assert.equal(same.action, "advance", "第 1 次同签名仍推进（要给一次机会）");
  m.noteRoundProgress(goal.goalId, baseRun({ id: "run_b" }));
  const blocked = decide({ goal, lastRun: baseRun({ id: "run_c" }) });
  assert.equal(blocked.action, "block");
  assert.equal(blocked.reason, "no_progress");
  m.clearGoalRoundState(goal.goalId);
});

test("产物变化算进展，不清零也不阻断", () => {
  m.clearGoalRoundState("goal_q");
  const goal = { ...baseGoal(), goalId: "goal_q" };
  m.noteRoundProgress(goal.goalId, baseRun({ id: "r1", artifacts: [{ path: "a" }] }));
  const decision = decide({ goal, lastRun: baseRun({ id: "r2", artifacts: [{ path: "a" }, { path: "b" }] }) });
  assert.equal(decision.action, "advance");
  m.clearGoalRoundState(goal.goalId);
});

test("同一条 Run 不重复计数", () => {
  m.clearGoalRoundState("goal_r");
  const run = baseRun({ id: "same" });
  m.noteRoundProgress("goal_r", run);
  const state = m.noteRoundProgress("goal_r", run);
  assert.equal(state.count, 0, "同一 run.id 重复记录不应累加");
  m.clearGoalRoundState("goal_r");
});

test("连续失败三次 → block/retry_exhausted", () => {
  m.clearGoalRoundState("goal_f");
  const goal = { ...baseGoal(), goalId: "goal_f" };
  for (let i = 0; i < 3; i += 1) m.noteRoundFailure(goal.goalId);
  const decision = decide({ goal, lastRun: baseRun({ status: "failed" }) });
  assert.equal(decision.action, "block");
  assert.equal(decision.reason, "retry_exhausted");
  m.clearGoalRoundState(goal.goalId);
});

test("失败退避随次数增长并在上限后停止", () => {
  assert.equal(m.roundBackoffMs(0), 60_000);
  assert.equal(m.roundBackoffMs(1), 300_000);
  assert.equal(m.roundBackoffMs(2), 900_000);
  assert.equal(m.roundBackoffMs(3), null);
});

console.log("\n▶ 提示词与签名");

test("推进提示词包含目标、轮次与「先判断是否达成」", () => {
  const prompt = m.goalRoundPrompt(baseGoal(), baseRun(), { round: 2, maxTurns: 10 });
  assert.match(prompt, /目标自动推进/);
  assert.match(prompt, /第 3\/10 轮/);
  assert.match(prompt, /把口播稿的 PDF 版本做出来/);
  assert.match(prompt, /目标是否已经达成/);
  assert.match(prompt, /不要重做已完成/);
});

test("进度签名对产物数/完成度敏感", () => {
  const a = m.progressSignature(baseRun({ artifacts: [] }));
  const b = m.progressSignature(baseRun({ artifacts: [{ path: "x" }] }));
  const c = m.progressSignature(baseRun({ completion: { status: "blocked" } }));
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.equal(m.progressSignature(null), "");
});

if (failed) {
  console.error("\n目标续轮测试：存在失败项\n");
  process.exit(1);
}
console.log("\n✓ 目标续轮测试全部通过\n");
