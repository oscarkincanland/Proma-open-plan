#!/usr/bin/env node
/**
 * 上下文分域回归（计划 2026-11-19-001 批次 C）。
 *
 * 背景：技能目录 68 条 ≈8KB 每轮全量注入并截断，其中地图/图表/画布域与"写一份工可报告"
 * 无关；已有 writingLeanContext 只照顾写作一路。本测试锁定：
 *   1. 领域判定顺序：地图/画布/研究线索优先，写作路由兜底，Chat/Review 只按写作裁剪；
 *   2. 按域筛选命中不足 minHit 时**回退全量**（不能因为裁剪让模型失去能力）；
 *   3. agent.mjs 实际接线（按域选择 + 4KB 预算 + 事件带 domain 字段）；
 *   4. 系统提示里规则标题不重复（同一规则只出现一次）。
 *
 * 用法：node scripts/上下文分域测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONTEXT_DOMAINS, detectDomainFromText, resolveContextDomain, selectSkillsForDomain } from "../server/上下文分域.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = (名, 函数) => {
  try { 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

const 技能 = [
  { name: "doc-report", description: "写工可报告与规划文本", aliases: [] },
  { name: "ppt-master", description: "PPT 演示制作", aliases: [] },
  { name: "map-heat", description: "地图热力图与等时圈", aliases: [] },
  { name: "canvas-design", description: "画布配色与展板设计", aliases: [] },
  { name: "kb-research", description: "知识库检索与调研", aliases: [] },
  { name: "doc-polish", description: "公文写作润色", aliases: [] },
];

test("领域判定：文本线索优先于写作路由", () => {
  assert.equal(detectDomainFromText("在义乌做一个公交 OD 热力图"), "map");
  assert.equal(detectDomainFromText("帮我做一个汇报用的展板配色"), "canvas");
  assert.equal(detectDomainFromText("检索一下知识库里的交通政策"), "research");
  assert.equal(detectDomainFromText("写一份工可报告"), "");
  assert.equal(resolveContextDomain({ route: "template", text: "写一份工可报告" }), "document");
  assert.equal(resolveContextDomain({ route: "read", text: "画一张等时圈地图" }), "map");
  assert.equal(resolveContextDomain({ route: "read", text: "随便聊聊" }), "all");
});

test("Chat/Review 只读模式不按域裁剪（可能同时查多域技能）", () => {
  assert.equal(resolveContextDomain({ route: "read", text: "画一张地图", mode: "chat" }), "all");
  assert.equal(resolveContextDomain({ route: "read", text: "审一下地图数据", mode: "review" }), "all");
  assert.equal(resolveContextDomain({ route: "generate", text: "写报告", mode: "chat" }), "document");
});

test("按域筛选：命中足够则裁剪，命中不足回退全量", () => {
  const map = selectSkillsForDomain(技能, "map", { minHit: 1 });
  assert.equal(map.filtered, true);
  assert.deepEqual(map.skills.map((item) => item.name), ["map-heat"]);
  assert.equal(map.domain, "map");

  const none = selectSkillsForDomain([{ name: "doc-report", description: "写报告" }], "map");
  assert.equal(none.filtered, false, "命中不足 minHit 必须回退全量");
  assert.equal(none.skills.length, 1);

  const all = selectSkillsForDomain(技能, "all");
  assert.equal(all.filtered, false);
  assert.equal(all.skills.length, 技能.length);
  assert.deepEqual([...CONTEXT_DOMAINS], ["document", "map", "canvas", "research", "all"]);
});

test("document 域复用既有写作筛选（PPT/报告类技能被保留）", () => {
  const doc = selectSkillsForDomain(技能, "document");
  assert.equal(doc.filtered, true);
  const names = doc.skills.map((item) => item.name);
  assert.ok(names.includes("doc-report"), "报告类技能应保留");
  assert.ok(names.includes("ppt-master"), "PPT 类技能应保留");
  assert.ok(!names.includes("map-heat"), "地图技能不应进写作目录");
  assert.ok(!names.includes("canvas-design"), "画布技能不应进写作目录");
});

test("agent.mjs 接线：按域选择 + 4KB 预算 + 事件带 domain", () => {
  const agent = read("server/agent.mjs");
  assert.match(agent, /resolveContextDomain\(\{ route: routeForCatalog/);
  assert.match(agent, /selectSkillsForDomain\(catalogSkills, contextDomain\)/);
  assert.match(agent, /budgetBytes: 4 \* 1024/);
  assert.match(agent, /domain: contextDomain/);
  assert.match(agent, /catalog-domain-\$\{contextDomain\}/);
});

test("系统提示规则标题不重复（同一规则只出现一次）", () => {
  const agent = read("server/agent.mjs");
  const titles = [...agent.matchAll(/- \*\*([^*]{2,24})\*\*/g)].map((match) => match[1].trim());
  const counts = new Map();
  for (const title of titles) counts.set(title, (counts.get(title) || 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([title, count]) => `${title}×${count}`);
  assert.deepEqual(duplicates, [], `重复规则：${duplicates.join("、")}`);
});

if (failed) {
  console.error("\n上下文分域回归：存在失败");
  process.exit(1);
}
console.log("\n上下文分域回归：全部通过");
