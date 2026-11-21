#!/usr/bin/env node
/**
 * 会话切换稳定性契约：
 * - 历史先展示，resume 只控制“能否继续发送”；
 * - getSession 走控制面超时；
 * - 恢复失败时输入/发送禁用，重试成功后恢复；
 * - 后台 run_finished 使历史缓存失效。
 *
 * 用法: node scripts/会话切换稳定性测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const app = read("client/src/App.jsx");
const chat = read("client/src/components/ChatPanel.jsx");
const api = read("client/src/api.js");

console.log("\n▶ 会话加载链路");

test("getSession 走 apiControl（8s 超时 + 回收可放弃流）", () => {
  const block = api.slice(api.indexOf("export const getSession"), api.indexOf("export const deleteSession"));
  assert.match(block, /apiControl\(/);
});

test("历史先 await，resume 后 await，不放在同一个 Promise.all 阻塞", () => {
  const start = app.indexOf("const historyPromise = (async () =>");
  const end = app.indexOf("// 从消息里解析会话关联的文件", start);
  const segment = app.slice(start, end);
  assert.match(segment, /const historyResult = await historyPromise;/);
  assert.match(segment, /if \(!historyResult\.ok\)/);
  assert.doesNotMatch(segment, /await Promise\.all\(\[historyPromise, resumePromise\]\)/);
  assert.ok(segment.indexOf("await historyPromise") < segment.indexOf("await resumePromise"), "历史必须先去展示");
});

test("历史成功后先切会话并置 agentReady=false，resume 成功才放开", () => {
  const segment = app.slice(app.indexOf("const historyResult = await historyPromise;"), app.indexOf("// 从消息里解析会话关联的文件"));
  assert.match(segment, /setAgentReady\(false\);/);
  assert.match(segment, /setCurrentSessionId\(session\.id\);/);
  assert.match(segment, /const resumeResult = await resumePromise;/);
  assert.match(segment, /setAgentReady\(Boolean\(resumeResult\?\.ok\)\);/);
});

test("恢复失败时输入与发送禁用", () => {
  assert.match(chat, /if \(!agentReady\)/);
  assert.match(chat, /正在恢复会话，请稍候/);
  assert.match(chat, /disabled=\{frozen \|\| !agentReady\}/);
  assert.match(chat, /frozen \|\| !agentReady \|\| compacting \|\| !hasDraft/);
});

test("agentReady=false 时不连接对话流", () => {
  // 2026-11-06：守卫由「只有 agentReady 才连」演进为「恢复中但本地已确认活跃 Run 时也要连」
  // （streamAttachAllowed = agentReady || busy），避免切回运行中会话时冻结不刷新。
  assert.match(chat, /const streamAttachAllowed = Boolean\(agentReady \|\| busy\);/);
  assert.match(chat, /if \(!streamAttachAllowed\) return undefined;/);
  assert.match(chat, /\[clientId, threadId, workspace, streamAttachAllowed\]/);
});

test("重试恢复成功/失败联动 agentReady", () => {
  const segment = app.slice(app.indexOf("const retrySessionResume"), app.indexOf("// A2（OAW_RESUME_AUTO_RETRY"));
  assert.match(segment, /setAgentReady\(true\)/);
  assert.match(segment, /setAgentReady\(false\)/);
});

test("run_finished 使后台会话历史缓存失效", () => {
  assert.match(app, /finishedSessionId/);
  assert.match(app, /sessionHistoryCacheRef\.current\.delete\(finishedSessionId\)/);
});

// 2026-11-20 串页修复（方案 docs/plans/2026-11-19-012 §8）：以下为结构断言（规范 §3 豁免路径），
// 只防实现被回改，不验证打标运行时取值；行为级守护见 scripts/会话切换串页回归测试.mjs（test:session-leak）。
console.log("\n▶ 会话切换串页防线（结构断言）");

test("4 个流式气泡创建点均携带 threadId 归属标记", () => {
  // ensureAssistant（事件驱动恢复，泄漏源）
  assert.match(chat, /status: "streaming", images: \[\], createdAt: Date\.now\(\), threadId: threadId \|\| undefined/);
  // 提问卡恢复气泡
  assert.match(chat, /runId: question\.runId \|\| null,\s*threadId, \/\/ 归属标记/);
  // 模型重试气泡
  assert.match(chat, /id: retryAid, role: "assistant", blocks: \[\],\s*status: "streaming", images: \[\], createdAt: Date\.now\(\),\s*threadId, \/\/ 归属标记/);
  // 发送消息气泡
  assert.match(chat, /model: model \|\| "",\s*status: "streaming", images: \[\],\s*createdAt: Date\.now\(\),\s*threadId, \/\/ 归属标记/);
});

test("历史水合合并只保留属于当前会话的 streaming 气泡", () => {
  assert.match(chat, /item\?\.status === "streaming"\s*&&\s*String\(item\?\.threadId \|\| ""\) === String\(threadId \|\| ""\)/);
});

console.log(failed ? "\n✗ 会话切换稳定性测试存在失败" : "\n✓ 会话切换稳定性测试全部通过");
process.exitCode = failed ? 1 : 0;
