#!/usr/bin/env node
/**
 * 提示词与实现一致性回归（计划 2026-11-19-001 批次 D）。
 *
 * 背景：提示词里的数字/判据一旦与代码常量脱钩，模型会按错误前提工作。
 * 已知实例：技能检索代码拦在第 4 次（`attempts > 3`），提示词却写"最多 2 次"；
 * 计划闸门写"预计工具调用 ≥5 次"，与 AGENTS §7.2 的 S1/S2/S3 规模分级冲突。
 *
 * 本测试锁定三条：
 *   1. 技能检索次数：提示词文案 == 代码常量；
 *   2. 计划闸门：风险优先 + S1/S2/S3，且不再出现"≥5 次"这类计数式判据；
 *   3. 关键提示词不重复（同一规则不得在系统提示里出现两份）。
 *
 * 用法：node scripts/提示词与实现一致性测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = (名, 函数) => {
  try { 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

const agent = read("server/agent.mjs");

test("技能检索次数：提示词 == 代码常量", () => {
  const 常量匹配 = /const SKILL_SEARCH_MAX_ATTEMPTS = (\d+);/.exec(agent);
  assert.ok(常量匹配, "缺少 SKILL_SEARCH_MAX_ATTEMPTS 常量");
  const 常量值 = Number(常量匹配[1]);
  const 文案匹配 = /同一 Run 最多 (\d+) 次/.exec(agent);
  assert.ok(文案匹配, "提示词里找不到「同一 Run 最多 N 次」");
  const 文案值 = Number(文案匹配[1]);
  assert.equal(文案值, 常量值, `提示词写 ${文案值} 次、代码常量是 ${常量值} 次`);
  assert.match(agent, /if \(attempts > SKILL_SEARCH_MAX_ATTEMPTS\)/, "代码未使用该常量判断上限");
  assert.match(agent, /attempts >= SKILL_SEARCH_STOP_AFTER_EMPTY/, "空结果停止阈值应走常量");
});

test("计划闸门：风险优先，不再用工具调用次数、也不混用开发流程分级", () => {
  const 闸门行 = agent.split("\n").find((line) => line.includes("计划闸门（风险优先"));
  assert.ok(闸门行, "缺少新的计划闸门条款");
  assert.match(闸门行, /不可逆写|覆盖既有文件/, "应按风险判定，而不是按调用次数");
  assert.match(闸门行, /纯只读检索不建计划/, "应明确只读不建计划");
  assert.doesNotMatch(agent, /预计工具调用 ≥5 次/, "旧的计数式判据仍在");
  // AGENTS §7.2 明文：S1/S2/S3 是开发流程分级，不得当作产品内建计划的判据。
  assert.doesNotMatch(闸门行, /S1\/S2\/S3|S2\/S3/, "产品内判据不得混用开发流程分级标签");
});

test("同一规则不得在系统提示里出现两份", () => {
  const 写文件规范 = (agent.match(/\*\*写文件规范\*\*/g) || []).length;
  assert.ok(写文件规范 <= 1, `「写文件规范」出现 ${写文件规范} 次（应只保留一处）`);
});

test("env_probe 有明确的使用时机说明（不是只登记工具）", () => {
  assert.match(agent, /环境探测（动手前先问环境）/, "系统提示缺少 env_probe 使用时机");
  assert.match(agent, /不要靠调用失败去撞能力边界/, "应写明不要靠试错摸能力");
});

if (failed) {
  console.error("\n提示词与实现一致性回归：存在失败");
  process.exit(1);
}
console.log("\n提示词与实现一致性回归：全部通过");
