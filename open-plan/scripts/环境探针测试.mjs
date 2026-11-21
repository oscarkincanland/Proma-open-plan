#!/usr/bin/env node
/**
 * 环境探针回归（计划 2026-11-19-001 批次 A）。
 *
 * 目标：模型动手前能用一次只读调用拿到环境事实，而不是靠失败试错。
 * 本测试锁定：
 *   1. 事实结构稳定（时间/时区、工作区、bash、Office、能力开关）；
 *   2. 探测失败不抛异常，降级为可读原因；
 *   3. 工具在三种模式的工具白名单与工具元数据里都登记（漏一处即为缺陷）；
 *   4. 工具确实定义在 agent.mjs 且接入 customTools。
 *
 * 用法：node scripts/环境探针测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectEnvironmentFacts, formatLocalTime } from "../server/环境探针.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = async (名, 函数) => {
  try { await 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

const 固定时间 = new Date("2026-11-19T08:00:00.000Z");
const 正常探测 = {
  shellProbe: () => ({ available: true, shell: "C:/Program Files/Git/bin/bash.exe", shellKind: "git-bash", reason: "" }),
  shellInfo: () => ({ available: true, shell: "C:/Program Files/Git/bin/bash.exe", shellKind: "git-bash" }),
  officeProbe: async () => ({ available: true, version: "officecli 1.2.3" }),
};

await test("事实结构：时间/工作区/bash/Office/能力开关齐备", async () => {
  const facts = await collectEnvironmentFacts({
    workspace: ROOT,
    toolNames: ["read", "bash", "officecli", "web_search", "canvas_write", "map_read", "run_subagent"],
    now: 固定时间,
    ...正常探测,
  });
  assert.equal(facts.now, "2026-11-19T08:00:00.000Z");
  assert.equal(typeof facts.localTime, "string");
  assert.equal(facts.localTime.length, 19, "本地时间应为 YYYY-MM-DD HH:mm:ss");
  assert.equal(typeof facts.timeZone, "string");
  assert.equal(facts.workspace.writable, true, `工作区应可写：${facts.workspace.reason}`);
  assert.equal(facts.shell.available, true);
  assert.equal(facts.shell.kind, "git-bash");
  assert.equal(facts.shell.toolAvailable, true, "白名单含 bash 时应标记工具可用");
  assert.equal(facts.office.available, true);
  assert.equal(facts.office.version, "officecli 1.2.3");
  assert.equal(facts.capabilities.network, true);
  assert.equal(facts.capabilities.canvas, true);
  assert.equal(facts.capabilities.map, true);
  assert.equal(facts.capabilities.subagent, true);
  assert.equal(facts.capabilities.browser, false, "未给 browser_* 时不应声称可用");
});

await test("能力开关只按本轮白名单判断（不虚报）", async () => {
  const facts = await collectEnvironmentFacts({
    workspace: ROOT,
    toolNames: ["read", "grep"],
    now: 固定时间,
    ...正常探测,
  });
  for (const 键 of ["network", "browser", "map", "canvas", "chart", "cad", "editorial", "subagent", "team"]) {
    assert.equal(facts.capabilities[键], false, `${键} 不应在只读工具集里被声称可用`);
  }
});

await test("探测失败降级为可读原因，不抛异常", async () => {
  const facts = await collectEnvironmentFacts({
    workspace: path.join(ROOT, "__不存在的工作区__"),
    toolNames: ["read"],
    shellProbe: () => { throw new Error("spawn EPERM"); },
    shellInfo: () => ({}),
    officeProbe: async () => { throw new Error("officecli 启动失败"); },
    now: 固定时间,
  });
  assert.equal(facts.workspace.writable, false);
  assert.match(facts.workspace.reason, /ENOENT|不存在|不是目录|no such/i, `工作区原因应可读：${facts.workspace.reason}`);
  assert.equal(facts.shell.available, false);
  assert.match(facts.shell.reason, /EPERM/);
  assert.equal(facts.office.available, false);
  assert.match(facts.office.message, /启动失败/);
});

await test("formatLocalTime 对非法输入返回空串", async () => {
  assert.equal(formatLocalTime(new Date("invalid")), "");
  assert.equal(formatLocalTime(null), "");
});

await test("工具三处登记一致：白名单 / 元数据 / agent 定义与注册", async () => {
  const task = read("server/task.mjs");
  const meta = read("server/工具元数据.mjs");
  const agent = read("server/agent.mjs");
  assert.match(task, /const READ_ONLY_TOOLS = Object\.freeze\(\[[\s\S]*?"env_probe"/, "环境探针必须进只读白名单（Chat/Work 共用）");
  assert.match(task, /const REVIEW_TOOLS = Object\.freeze\(\[[\s\S]*?"env_probe"/, "环境探针必须进 Review 白名单");
  assert.match(meta, /meta\("env_probe",\s*\{[\s\S]*?readOnly|meta\("env_probe",\s*\{\s*\.\.\.READ/, "工具元数据必须登记 env_probe 且为只读");
  assert.match(agent, /name: "env_probe"/, "agent.mjs 必须定义 env_probe 工具");
  assert.match(agent, /customTools: \[[\s\S]*?envProbeTool/, "env_probe 必须接入 customTools，否则模型看不到");
});

await test("只读模式不主动 spawn Office CLI（Chat 边界）", async () => {
  let 调用次数 = 0;
  const facts = await collectEnvironmentFacts({
    workspace: ROOT,
    toolNames: ["read", "grep"],
    allowOfficeProbe: false,
    officeProbe: async () => { 调用次数 += 1; return { available: true }; },
    now: 固定时间,
    shellProbe: 正常探测.shellProbe,
    shellInfo: 正常探测.shellInfo,
  });
  assert.equal(调用次数, 0, "allowOfficeProbe=false 时不得调用探测");
  assert.equal(facts.office.available, null, "未探测时应为 null（不是 false，避免误导为不可用）");
  assert.match(facts.office.message, /不主动探测/);
});

await test("Review 白名单覆盖只读工具（除联网/地图/CAD 明确例外）", async () => {
  const task = read("server/task.mjs");
  const pick = (name) => {
    const block = new RegExp("const " + name + " = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)").exec(task);
    assert.ok(block, "找不到 " + name);
    return [...block[1].matchAll(/"([a-z][a-z0-9_]+)"/g)].map((m) => m[1]);
  };
  const readOnly = pick("READ_ONLY_TOOLS");
  const review = new Set(pick("REVIEW_TOOLS"));
  const 例外 = new Set(["web_search", "web_fetch"]);
  const 应覆盖 = readOnly.filter((name) => !例外.has(name) && !name.startsWith("map_") && !name.startsWith("cad_"));
  const 缺失 = 应覆盖.filter((name) => !review.has(name));
  assert.deepEqual(缺失, [], "Review 白名单漏了只读工具：" + 缺失.join(", "));
});

if (failed) {
  console.error("\n环境探针回归：存在失败");
  process.exit(1);
}
console.log("\n环境探针回归：全部通过");
