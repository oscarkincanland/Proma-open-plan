#!/usr/bin/env node
/**
 * 计划文件持久化测试
 * 覆盖：写入/读取/列表 / todo 转计划 / 路径安全
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPlans, persistPlanFromTodo, prunePlans, readPlan, writePlan } from "../server/计划文件.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-plan-"));

test("写入计划并读取", () => {
  const out = writePlan({ workspace, title: "Harness 改造", content: "- [ ] 元数据\n- [ ] 权限", runId: "run1" });
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(out.path));
  const plan = readPlan(workspace, path.basename(out.path));
  assert.ok(plan.content.includes("Harness 改造"));
});

test("计划列表", () => {
  const plans = listPlans(workspace);
  assert.equal(plans.length, 1);
  assert.ok(plans[0].name.endsWith(".md"));
  assert.equal(plans[0].source, "workspace.plans");
});

test("从 todo 生成计划", () => {
  const out = persistPlanFromTodo({
    workspace,
    title: "任务计划",
    goal: "完成 Harness",
    runId: "run2",
    todoItems: [
      { content: "元数据", status: "completed" },
      { content: "权限", status: "pending" },
    ],
  });
  assert.equal(out.ok, true);
  const plan = readPlan(workspace, path.basename(out.path));
  assert.ok(plan.content.includes("- [x] 元数据"));
  assert.ok(plan.content.includes("- [ ] 权限"));
});

test("文件名中的非法字符被替换", () => {
  const out = writePlan({ workspace, title: "a/b:c*?", content: "x" });
  assert.equal(out.ok, true);
  assert.ok(!path.basename(out.path).includes(":"));
  assert.ok(!path.basename(out.path).includes("*"));
});

test("写入走写入协调：带 runId 时加锁并在结束后释放", () => {
  const runId = `run_plan_lock_${Date.now()}`;
  const first = writePlan({ workspace, title: "加锁计划", content: "- [ ] 第一步", runId, threadId: "t-lock" });
  assert.equal(first.ok, true);
  // 锁已释放：同一 Run 再写一次不应抛 WRITE_CONFLICT（若未释放会因 owner 相同而累加引用，
  // 这里用不同 runId 验证"锁确实不再被占"）。
  const second = writePlan({ workspace, title: "加锁计划", content: "- [x] 第一步", runId: runId + "-2", threadId: "t-lock" });
  assert.equal(second.ok, true);
  assert.ok(readPlan(workspace, path.basename(second.path)).content.includes("- [x] 第一步"));
});

test("同一会话的计划文件名固定（续跑原地更新，不产生第二份）", () => {
  const a = persistPlanFromTodo({ workspace, threadId: "thread-plan-a", runId: "run_1", todoItems: [{ content: "一", status: "pending" }] });
  const b = persistPlanFromTodo({ workspace, threadId: "thread-plan-a", runId: "run_2", todoItems: [{ content: "一", status: "completed" }] });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(path.basename(a.path), path.basename(b.path), "同一 thread 应写同一个文件");
  assert.ok(readPlan(workspace, path.basename(b.path)).content.includes("- [x] 一"));
});

test("prunePlans 默认 dryRun：只列候选、不删除", () => {
  const old = writePlan({ workspace, title: "陈旧计划", content: "x" });
  const past = new Date(Date.now() - 90 * 86400000);
  fs.utimesSync(old.path, past, past);
  const report = prunePlans(workspace, { keepDays: 30 });
  assert.equal(report.dryRun, true);
  assert.ok(report.candidates.some((item) => item.name === path.basename(old.path)), "应把 90 天未更新的计划列为候选");
  assert.ok(fs.existsSync(old.path), "dryRun 不得删除文件");
  assert.equal(report.deleted.length, 0);
});

test("prunePlans dryRun:false 只删过期/超额，保留最近计划", () => {
  const fresh = writePlan({ workspace, title: "最新计划", content: "y" });
  const reports = prunePlans(workspace, { keepDays: 30, maxFiles: 1, dryRun: false });
  assert.equal(reports.dryRun, false);
  assert.ok(reports.deleted.length > 0, "应删除过期/超额计划");
  assert.ok(fs.existsSync(fresh.path), "最近更新的计划必须保留");
  const remaining = listPlans(workspace);
  assert.ok(remaining.length <= 1, `保留数量应受 maxFiles 限制，实际 ${remaining.length}`);
});

fs.rmSync(workspace, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
