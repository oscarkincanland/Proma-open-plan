#!/usr/bin/env node
/**
 * 模板结构覆盖回归（计划 2026-11-19-001 批次 B）。
 *
 * 背景：`server/office规范/模板结构.mjs` 早已是模板章节的**唯一解析事实源**
 * （编辑流水线注入必备小节、验收规则跑 assertCoverage）。但它的结构骨架标题正则
 * 只认 `## 二、结构骨架`，而 01/02 写 `## 2. 结构骨架`、03 写 `## 2. 结构骨架：…`、
 * 11 写 `## 二、PPT …实测骨架`，导致 14 个模板里只有 5 个能解析出必备章节，
 * 其余静默退化为"推断结构"——验收实际什么都没查。
 *
 * 本测试锁定：
 *   1. 主要文书模板必须解析出必备小节（数量下限），且来源可解释（explicit/chapters）；
 *   2. 无法解析的（规范汇总、PPT 场景、素材库）必须显式 inferred=true，不得静默"零缺失"；
 *   3. assertCoverage 真的能点名缺失章节（不是只断言字符串存在）。
 *
 * 用法：node scripts/模板结构覆盖测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import os from "node:os";

import JSZip from "jszip";

import { assertCoverage, parseTemplateStructure } from "../server/office规范/模板结构.mjs";
import { runDocxQa } from "../server/office规范/验收规则.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = path.join(ROOT, "templates/traffic-material");

let failed = 0;
const test = (名, 函数) => {
  try { 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

const 模板 = new Map();
for (const file of fs.readdirSync(TEMPLATE_DIR).filter((name) => name.endsWith(".md"))) {
  模板.set(file, fs.readFileSync(path.join(TEMPLATE_DIR, file), "utf8"));
}
const parse = (file) => parseTemplateStructure(模板.get(file));

test("主要文书模板解析出必备小节（数量下限 + 来源可解释）", () => {
  const 期望 = [
    ["04_工程可行性研究报告模板.md", "explicit", 30],
    ["05_线位论证预可模板.md", "explicit", 25],
    ["09_物流园区规划模板.md", "explicit", 20],
    ["03_规划文本条文式模板.md", "chapters", 10],
    ["08_汇报材料模板.md", "explicit", 5],
    ["02_五年发展规划模板.md", "explicit", 5],
    ["06_选址和用地预审论证模板.md", "explicit", 5],
    ["01_年度工作报告模板.md", "explicit", 5],
    ["07_交通影响评价模板.md", "chapters", 2],
    ["10_规划研究报告模板.md", "chapters", 4],
  ];
  for (const [file, 来源, 下限] of 期望) {
    const 结构 = parse(file);
    assert.ok(结构.requiredSections.length >= 下限, `${file} 必备小节 ${结构.requiredSections.length} < ${下限}`);
    assert.equal(结构.structureSource, 来源, `${file} 章节来源应为 ${来源}，实际 ${结构.structureSource}`);
    assert.equal(结构.inferred, 来源 !== "explicit", `${file} inferred 与来源不一致`);
  }
});

test("解析不出章节的模板必须显式标记 inferred（不得静默零缺失）", () => {
  for (const file of ["00_总览通用规范.md", "00_格式数据汇总.md", "11_PPT汇报模板.md", "12_素材库深挖.md"]) {
    const 结构 = parse(file);
    if (结构.requiredSections.length === 0) {
      assert.equal(结构.inferred, true, `${file} 零章节却未标记 inferred`);
      assert.equal(结构.structureSource, "none", `${file} 来源应为 none`);
    }
  }
  // 至少 10 个模板能给出章节（修复前是 5 个）
  const 有章节 = [...模板.keys()].filter((file) => parse(file).requiredSections.length > 0);
  assert.ok(有章节.length >= 10, `能解析出章节的模板只有 ${有章节.length} 个（应 ≥10）`);
});

test("assertCoverage 能点名缺失章节（真实行为，不是字符串匹配）", () => {
  const 结构 = parse("04_工程可行性研究报告模板.md");
  const 必备 = 结构.requiredSections;
  assert.ok(必备.length >= 30, "04 模板必备小节应 ≥30");

  // 把全部必备小节 + 必备图/表写进正文 → 章节层面不应有缺失
  const 全覆盖 = [...必备, ...结构.figures, ...结构.tables].join("\n");
  const 全 = assertCoverage(结构, 全覆盖);
  assert.deepEqual(全.missing.filter((item) => 必备.includes(item)), [], "全部写入后不应有缺失");

  // 去掉一节 → 必须点名到它
  const 缺 = 必备[3];
  const 部分 = [...必备.filter((item) => item !== 缺), ...结构.figures, ...结构.tables].join("\n");
  const 结果 = assertCoverage(结构, 部分);
  assert.equal(结果.ok, false, "缺章节应判失败");
  assert.ok(结果.missing.includes(缺), `缺失应点名「${缺}」，实际 ${JSON.stringify(结果.missing.slice(0, 5))}`);
});

/** 造一份最小 docx（只含文本段落），用于端到端验收。 */
async function buildDocx(texts) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder("_rels").file(".rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = texts.map((t) => `<w:p><w:r><w:t xml:space="preserve">${String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</w:t></w:r></w:p>`).join("");
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

const testAsync = async (名, 函数) => {
  try { await 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

await testAsync("端到端 docx：章节写全 → 0 处覆盖缺失；少一节 → 只点名该节", async () => {
  const 结构 = parse("04_工程可行性研究报告模板.md");
  const 必备 = [...结构.requiredSections, ...结构.figures, ...结构.tables];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-tpl-"));
  const 全路径 = path.join(dir, "全量.docx");
  const 少路径 = path.join(dir, "少一节.docx");
  try {
    fs.writeFileSync(全路径, await buildDocx(必备));
    const 全 = await runDocxQa(全路径, { structure: 结构, coverageMode: "strict" });
    const 全缺 = (全.issues || []).filter((item) => item.rule === "template_coverage");
    assert.deepEqual(全缺.map((item) => item.message), [], "章节写全时不得再报覆盖缺失（会误伤真实产物）");

    const 去掉 = 结构.requiredSections[2];
    fs.writeFileSync(少路径, await buildDocx(必备.filter((item) => item !== 去掉)));
    const 少 = await runDocxQa(少路径, { structure: 结构, coverageMode: "strict" });
    const 少缺 = (少.issues || []).filter((item) => item.rule === "template_coverage");
    assert.equal(少缺.length, 1, `少一节应只报 1 处，实际 ${少缺.length} 处`);
    assert.ok(String(少缺[0].message).includes(去掉), `缺失应点名「${去掉}」，实际「${少缺[0].message}」`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failed) {
  console.error("\n模板结构覆盖回归：存在失败");
  process.exit(1);
}
console.log("\n模板结构覆盖回归：全部通过");
