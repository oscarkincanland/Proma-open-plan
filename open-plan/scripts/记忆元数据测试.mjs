#!/usr/bin/env node
/**
 * 记忆元数据回归（计划 2026-11-19-001 批次 C）。
 *
 * 背景：MEMORY.md 只写着"记忆可能过时"，但每条记忆没有置信度/最后核验时间/适用范围，
 * 模型无法判断新旧，条目越攒越乱。本测试锁定：
 *   1. 条目元数据可写可解析、往返不丢信息；
 *   2. 旧条目（无元数据）视为"未核验"，只标注不删除；
 *   3. 过时判断按天数，召回注入里逐条标注并给出待复核数量；
 *   4. 写入按"内容"去重（同内容不同日期不重复写），且批准链路透传元数据。
 *
 * 用法：node scripts/记忆元数据测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  annotateMemoryBody,
  formatMemoryEntry,
  isMemoryStale,
  memoryAgeDays,
  normalizeConfidence,
  normalizeScope,
  parseMemoryEntry,
  staleReason,
  summarizeMemoryHealth,
} from "../server/记忆元数据.mjs";

let failed = 0;
const test = async (名, 函数) => {
  try { await 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

const 现在 = new Date("2026-11-19T10:00:00Z");

await test("格式与解析往返：内容/置信度/核验日期/适用范围都不丢", () => {
  const line = formatMemoryEntry({ content: "交通规划项目默认用 WGS84 坐标", scope: "project", confidence: 0.8, lastVerified: "2026-11-01" });
  assert.equal(line, "- 交通规划项目默认用 WGS84 坐标（置信度 0.8 · 核验 2026-11-01 · 适用 project）");
  const parsed = parseMemoryEntry(line);
  assert.equal(parsed.content, "交通规划项目默认用 WGS84 坐标");
  assert.equal(parsed.scope, "project");
  assert.equal(parsed.confidence, 0.8);
  assert.equal(parsed.lastVerified, "2026-11-01");
  assert.equal(parsed.hasMeta, true);
});

await test("无置信度时不伪造精度；非法值被归一化", () => {
  const line = formatMemoryEntry({ content: "走查报告用三线表", now: 现在 });
  assert.ok(!line.includes("置信度"), `未给置信度时不应写该字段：${line}`);
  assert.match(line, /核验 2026-11-19/);
  assert.equal(normalizeConfidence("abc"), null);
  assert.equal(normalizeConfidence(2), 1);
  assert.equal(normalizeConfidence(-1), 0);
  assert.equal(normalizeScope("PROJECT"), "project");
  assert.equal(normalizeScope("随便"), "workspace");
});

await test("旧条目（无元数据）视为未核验，但不改原文", () => {
  const parsed = parseMemoryEntry("- 老条目：报告模板在 templates/traffic-material");
  assert.equal(parsed.hasMeta, false);
  assert.equal(parsed.scope, "workspace");
  assert.equal(parsed.confidence, null);
  assert.equal(parsed.content, "老条目：报告模板在 templates/traffic-material");
  assert.equal(isMemoryStale(parsed, { now: 现在 }), true);
  assert.equal(staleReason(parsed, { now: 现在 }), "未标注核验时间");
});

await test("过时按天数判断（超过 90 天为过时）", () => {
  const 新 = parseMemoryEntry(formatMemoryEntry({ content: "x", lastVerified: "2026-11-10" }));
  const 旧 = parseMemoryEntry(formatMemoryEntry({ content: "y", lastVerified: "2026-06-01" }));
  assert.equal(memoryAgeDays(新, 现在), 9);
  assert.equal(isMemoryStale(新, { now: 现在 }), false);
  assert.equal(isMemoryStale(旧, { now: 现在 }), true);
  assert.match(staleReason(旧, { now: 现在 }), /已 \d+ 天未核验/);
  assert.equal(isMemoryStale(旧, { now: 现在, maxAgeDays: 365 }), false, "阈值可调");
});

await test("正文标注：只标过时条目、保留原文本、可重复调用不叠加", () => {
  const body = [
    "# 记忆索引",
    "",
    "## 项目事实",
    formatMemoryEntry({ content: "新事实", lastVerified: "2026-11-15" }),
    "- 旧事实（无元数据）",
    "",
    "## 经验教训",
    formatMemoryEntry({ content: "陈年经验", lastVerified: "2026-01-01" }),
  ].join("\n");
  const 一次 = annotateMemoryBody(body, { now: 现在 });
  assert.equal(一次.total, 3);
  assert.equal(一次.stale, 2);
  assert.ok(一次.text.includes("- 旧事实（无元数据）（可能过时：未标注核验时间）"));
  assert.ok(一次.text.includes("陈年经验"), "原条目文本必须保留");
  assert.ok(!/新事实（可能过时/.test(一次.text), "新条目不标注");
  const 二次 = annotateMemoryBody(一次.text, { now: 现在 });
  assert.equal(二次.stale, 0, "已标注的条目不应再次计入或叠加");
  assert.equal((二次.text.match(/可能过时/g) || []).length, 2);
});

await test("健康度摘要：总数/过时/带元数据比例", () => {
  const body = [
    formatMemoryEntry({ content: "a", lastVerified: "2026-11-15", confidence: 0.9 }),
    formatMemoryEntry({ content: "b", lastVerified: "2026-05-01", confidence: 0.3 }),
    "- c（无元数据）",
  ].join("\n");
  const health = summarizeMemoryHealth(body, { now: 现在 });
  assert.equal(health.total, 3);
  assert.equal(health.stale, 2);
  assert.equal(health.fresh, 1);
  assert.equal(health.withMeta, 2);
  assert.equal(health.avgConfidence, 0.6);
});

await test("写入链路：落盘带元数据、同内容去重、批准透传 scope/confidence", async () => {
  const { writeMemoryEntry, createMemoryProposal, approveMemoryProposal } = await import("../server/记忆管理.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-mem-"));
  try {
    const 一 = writeMemoryEntry({ workspace: ws, category: "项目事实", content: "默认坐标系 WGS84", scope: "project", confidence: 0.9 });
    assert.equal(一.ok, true);
    const file = path.join(ws, "memory", "MEMORY.md");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /默认坐标系 WGS84（置信度 0\.9 · 核验 \d{4}-\d{2}-\d{2} · 适用 project）/);

    const 二 = writeMemoryEntry({ workspace: ws, category: "项目事实", content: "默认坐标系 WGS84", scope: "workspace", confidence: 0.4 });
    assert.equal(二.duplicate, true, "同内容不同元数据不应写第二条");
    assert.equal((fs.readFileSync(file, "utf8").match(/默认坐标系 WGS84/g) || []).length, 1);

    const proposal = createMemoryProposal({
      workspace: ws,
      category: "经验教训",
      content: "写工可先读 04 模板",
      scope: "project",
      confidence: 0.7,
    });
    assert.equal(proposal.scope, "project");
    assert.equal(proposal.confidence, 0.7);
    const approved = approveMemoryProposal(proposal.id, {});
    assert.equal(approved.ok, true);
    const after = fs.readFileSync(file, "utf8");
    assert.match(after, /写工可先读 04 模板（置信度 0\.7 · 核验 \d{4}-\d{2}-\d{2} · 适用 project）/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

await test("召回注入：过时条目被逐条标注并给出待复核数量", async () => {
  const { buildRecallContextSync } = await import("../server/记忆召回.mjs");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-mem-recall-"));
  try {
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "memory", "MEMORY.md"),
      ["# 记忆索引", "", "## 项目事实", "- 旧规则：先读模板", formatMemoryEntry({ content: "新规则：一次成稿", lastVerified: new Date().toISOString().slice(0, 10) })].join("\n"),
      "utf8",
    );
    const recall = buildRecallContextSync({ workspace: ws, query: "模板 成稿" });
    assert.ok(recall.text.includes("记忆召回"), "应注入召回段");
    assert.match(recall.text, /条待复核/);
    assert.match(recall.text, /旧规则：先读模板（可能过时：未标注核验时间）/);
    assert.ok(!/新规则：一次成稿（可能过时/.test(recall.text), "新条目不应被标过时");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

if (failed) {
  console.error("\n记忆元数据回归：存在失败");
  process.exit(1);
}
console.log("\n记忆元数据回归：全部通过");
