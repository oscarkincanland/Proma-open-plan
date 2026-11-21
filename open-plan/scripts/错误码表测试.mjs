#!/usr/bin/env node
/**
 * 错误码表回归（计划 2026-11-19-001 批次 B）。
 *
 * 背景：officecli/bash 的常见失败原先以散文写法塞在工具描述里（KNOWN ERRORS (a)…(f)…），
 * 模型只能逐句比对措辞，每遇新失败再加一句、文本只增不减。
 * 现在改为「错误码 → 立即动作 / 禁止动作」登记表，本测试锁定：
 *   1. 每条码字段齐全、渲染包含全部码；
 *   2. 真实错误文本能映射到对应码（lookupErrorCode）；
 *   3. agent.mjs 已切换到渲染函数，旧散文标记不再存在。
 *
 * 用法：node scripts/错误码表测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CODES, errorCodeStats, lookupErrorCode, renderErrorCodeTable } from "../server/错误码表.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = (名, 函数) => {
  try { 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

test("登记表：字段齐全、码不重复", () => {
  assert.ok(ERROR_CODES.length >= 8, `登记项过少：${ERROR_CODES.length}`);
  const seen = new Set();
  for (const entry of ERROR_CODES) {
    assert.ok(entry.code && /^[A-Z][A-Z0-9_]+$/.test(entry.code), `code 不合法：${entry.code}`);
    assert.ok(!seen.has(entry.code), `code 重复：${entry.code}`);
    seen.add(entry.code);
    for (const 字段 of ["scope", "match", "meaning", "action", "forbid"]) {
      assert.ok(String(entry[字段] || "").trim(), `${entry.code} 缺字段 ${字段}`);
    }
  }
  const stats = errorCodeStats();
  assert.equal(stats.total, ERROR_CODES.length);
  assert.ok(Object.keys(stats.byScope).length >= 2, "应覆盖多个作用域");
});

test("渲染：包含全部码，且是紧凑表而非散文", () => {
  const text = renderErrorCodeTable();
  for (const entry of ERROR_CODES) assert.ok(text.includes(entry.code), `渲染缺少 ${entry.code}`);
  assert.match(text, /动作:/, "必须给出立即动作");
  assert.match(text, /禁止:/, "必须给出禁止动作");
  // 一行一条：整体行数应等于条目数（用 "; " 分隔）
  assert.equal(text.split("; ").length - 1, ERROR_CODES.length - 1, "条目之间应以分号分隔、不换行");
});

test("渲染：按作用域过滤只返回该作用域", () => {
  const office = renderErrorCodeTable({ scope: "officecli" });
  const bash = renderErrorCodeTable({ scope: "bash" });
  assert.match(office, /OFFICE_STYLE_MISSING/);
  assert.doesNotMatch(office, /BASH_GUARD_DENIED/);
  assert.match(bash, /BASH_GUARD_DENIED/);
  assert.equal(renderErrorCodeTable({ scope: "不存在的域" }), "");
});

test("映射：真实错误文本 → 错误码", () => {
  assert.equal(lookupErrorCode("Style Normal not found")?.code, "OFFICE_STYLE_MISSING");
  assert.equal(lookupErrorCode("Error: Image file not found: a.png")?.code, "IMAGE_NOT_FOUND");
  assert.equal(lookupErrorCode("Malformed XML in document part")?.code, "OOXML_MALFORMED");
  assert.equal(lookupErrorCode("sharing violation, file is locked")?.code, "FS_SHARING_VIOLATION");
  assert.equal(lookupErrorCode("EPERM: operation not permitted")?.code, "FS_ACCESS_DENIED");
  assert.equal(lookupErrorCode("decompression_bomb: too many elements")?.code, "OFFICE_DECOMPRESSION_BOMB");
  assert.equal(lookupErrorCode(""), null);
  assert.equal(lookupErrorCode("完全无关的文本"), null);
});

test("接线：agent.mjs 已改用渲染函数，旧散文标记消失", () => {
  const agent = read("server/agent.mjs");
  assert.match(agent, /import \{ renderErrorCodeTable \} from "\.\/错误码表\.mjs"/, "未引入错误码表");
  assert.match(agent, /renderErrorCodeTable\(\{ header: "ERROR CODES/, "officecli 描述未改用渲染函数");
  assert.doesNotMatch(agent, /KNOWN ERRORS \(avoid loops\)/, "旧的散文式 KNOWN ERRORS 仍在");
});

if (failed) {
  console.error("\n错误码表回归：存在失败");
  process.exit(1);
}
console.log("\n错误码表回归：全部通过");
