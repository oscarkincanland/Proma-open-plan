#!/usr/bin/env node
/**
 * 上下文压缩诊断（2026-11-19-010 P3.3）回归。
 *
 * 测的是纯函数：给定 CompactionPreparation 统计"这次压缩会丢掉多少工具结果/图片"，
 * 以及扩展钩子与 agent.mjs 之间的一次性交接（TTL + 取走即删）。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const m = await import(pathToFileURL(path.join(ROOT, "server/上下文诊断.mjs")).href);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const text = (value) => ({ role: "assistant", content: [{ type: "text", text: value }] });
const toolResult = (value) => ({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: value }] });
const image = (bytes) => ({
  role: "user",
  content: [{ type: "image", data: "A".repeat(Math.max(4, Math.floor(bytes / 0.75))) }],
});

console.log("\n▶ 统计口径");

test("统计消息数、工具结果条数与字节", () => {
  const plan = m.analyzeCompactionPlan({
    tokensBefore: 1234,
    firstKeptEntryId: "e42",
    isSplitTurn: false,
    messagesToSummarize: [text("hello"), toolResult("x".repeat(4000)), toolResult("y".repeat(2000)), text("done")],
    fileOps: { readFiles: ["a.md"], modifiedFiles: ["b.docx"] },
  });
  assert.equal(plan.messageCount, 4);
  assert.equal(plan.toolResults, 2);
  assert.ok(plan.toolResultBytes >= 6000, `工具结果字节应按内容累计（含少量序列化开销），实际 ${plan.toolResultBytes}`);
  assert.ok(plan.biggestToolResultBytes >= 4000, `最大单条应 >= 4000，实际 ${plan.biggestToolResultBytes}`);
  assert.equal(plan.tokensBefore, 1234);
  assert.equal(plan.firstKeptEntryId, "e42");
  assert.deepEqual(plan.readFiles, ["a.md"]);
  assert.deepEqual(plan.modifiedFiles, ["b.docx"]);
});

test("图片按 base64 长度计字节并单独计数", () => {
  const plan = m.analyzeCompactionPlan({ messagesToSummarize: [image(4000), text("x")] });
  assert.equal(plan.images, 1);
  assert.ok(plan.imageBytes >= 4000, `图片字节应 >= 4000，实际 ${plan.imageBytes}`);
});

test("省下的 token 只按工具结果与图片折算，正文不计入", () => {
  const plan = m.analyzeCompactionPlan({
    messagesToSummarize: [toolResult("z".repeat(4000)), text("a".repeat(40000))],
  });
  assert.ok(plan.toolResultBytes >= 4000, "工具结果字节按原文计（含少量序列化开销）");
  assert.equal(plan.estimatedTokensFreed, Math.ceil(plan.toolResultBytes / 4), "正文会进摘要，不算省下");
  assert.ok(plan.estimatedTokensFreed < 2000, `正文不得被算成省下的 token，实际 ${plan.estimatedTokensFreed}`);
});

test("空输入安全返回零值", () => {
  const plan = m.analyzeCompactionPlan();
  assert.equal(plan.messageCount, 0);
  assert.equal(plan.toolResults, 0);
  assert.equal(plan.estimatedTokensFreed, 0);
  assert.equal(plan.firstKeptEntryId, null);
});

test("fileOps 列表有上限且不炸", () => {
  const many = Array.from({ length: 80 }, (_, i) => `f${i}.md`);
  const plan = m.analyzeCompactionPlan({ messagesToSummarize: [], fileOps: { readFiles: many } });
  assert.equal(plan.readFiles.length, 50, "最多保留 50 条");
});

console.log("\n▶ 交接槽（扩展 → agent.mjs）");

test("取出即删除，第二次为空", () => {
  m.clearCompactionPlans();
  m.rememberCompactionPlan({ toolResults: 3 });
  assert.deepEqual(m.takeCompactionPlan(), { toolResults: 3 });
  assert.equal(m.takeCompactionPlan(), null);
});

test("超时的计划不可用", () => {
  m.clearCompactionPlans();
  const now = Date.now();
  m.rememberCompactionPlan({ toolResults: 1 }, { now: now - 5 * 60_000 });
  assert.equal(m.takeCompactionPlan({ now }), null);
});

test("不同 key 互不串台", () => {
  m.clearCompactionPlans();
  m.rememberCompactionPlan({ id: "a" }, { key: "s1" });
  m.rememberCompactionPlan({ id: "b" }, { key: "s2" });
  assert.deepEqual(m.takeCompactionPlan({ key: "s1" }), { id: "a" });
  assert.deepEqual(m.takeCompactionPlan({ key: "s2" }), { id: "b" });
});

if (failed) {
  console.error("\n上下文压缩诊断：存在失败项\n");
  process.exit(1);
}
console.log("\n✓ 上下文压缩诊断全部通过\n");
