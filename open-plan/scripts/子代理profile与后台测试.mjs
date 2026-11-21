#!/usr/bin/env node
/**
 * 子代理 profile 测试
 * 覆盖：冻结字段 / 校验 / 变更检测
 */
import assert from "node:assert/strict";
import { SUBAGENT_ROLES, resolveRoleTimeoutMs } from "../server/子代理编排器.mjs";
import { buildSubagentProfile, profileDiff, validateSubagentProfile } from "../server/子代理配置.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("profile 冻结角色/工具/模型/预算", () => {
  const profile = buildSubagentProfile({
    childId: "subagent_1",
    role: "worker",
    roleSpec: SUBAGENT_ROLES.worker,
    model: "provider/model",
    budget: { timeoutMs: 1000, maxTurns: 5 },
    frozenAt: "2026-10-27T00:00:00.000Z",
  });
  assert.equal(profile.childId, "subagent_1");
  assert.equal(profile.role, "worker");
  assert.equal(profile.readOnly, false);
  assert.ok(profile.tools.includes("write"));
  assert.equal(profile.model, "provider/model");
  assert.equal(profile.budget.maxTurns, 5);
  assert.equal(profile.frozenAt, "2026-10-27T00:00:00.000Z");
});

test("profile 校验", () => {
  assert.equal(validateSubagentProfile(buildSubagentProfile({ role: "scout", roleSpec: SUBAGENT_ROLES.scout })).ok, true);
  assert.equal(validateSubagentProfile({}).ok, false);
});

test("profile 变更检测", () => {
  const a = buildSubagentProfile({ role: "scout", roleSpec: SUBAGENT_ROLES.scout });
  const b = { ...a, tools: [...a.tools, "write"] };
  assert.deepEqual(profileDiff(a, b), ["tools"]);
  assert.deepEqual(profileDiff(a, { ...a }), []);
});

// ---- 2026-11-19-001 批次 C：角色超时可配 ----

test("角色超时默认值不变（scout 60s / writer 240s）", () => {
  assert.equal(resolveRoleTimeoutMs("scout", {}), 60000);
  assert.equal(resolveRoleTimeoutMs("pipeline_writer", {}), 240000);
  assert.equal(resolveRoleTimeoutMs("不存在的角色", {}), 60000, "未知角色回退 scout");
});

test("角色超时可按角色/全局覆盖，并夹取到 15s~15min", () => {
  assert.equal(resolveRoleTimeoutMs("reviewer", { OAW_SUBAGENT_TIMEOUT_MS_REVIEWER: "180000" }), 180000);
  assert.equal(resolveRoleTimeoutMs("scout", { OAW_SUBAGENT_TIMEOUT_MS: "90000" }), 90000);
  assert.equal(resolveRoleTimeoutMs("scout", { OAW_SUBAGENT_TIMEOUT_MS_REVIEWER: "180000", OAW_SUBAGENT_TIMEOUT_MS: "90000" }), 90000, "单角色键只影响该角色");
  assert.equal(resolveRoleTimeoutMs("scout", { OAW_SUBAGENT_TIMEOUT_MS: "1000" }), 15000, "低于下限夹取");
  assert.equal(resolveRoleTimeoutMs("scout", { OAW_SUBAGENT_TIMEOUT_MS: "99999999" }), 900000, "高于上限夹取");
  assert.equal(resolveRoleTimeoutMs("scout", { OAW_SUBAGENT_TIMEOUT_MS: "abc" }), 60000, "非法值回退默认");
});

test("编排器实际使用可配超时（配置不再形同虚设）", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../server/子代理编排器.mjs", import.meta.url), "utf8");
  assert.match(src, /budget: \{ timeoutMs: resolveRoleTimeoutMs\(role\) \}/, "budget 未走 resolveRoleTimeoutMs");
  assert.doesNotMatch(src, /budget: \{ timeoutMs: roleSpec\.timeoutMs \}/, "仍有写死取值的旧代码");
});

process.exitCode = failed ? 1 : 0;
