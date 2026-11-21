#!/usr/bin/env node
/**
 * 运行开关热更测试（2026-11-19-002 阶段1）。
 *
 * 验证 buildRuntimeFlags / reloadRuntimeFlags 热更管道：
 *   ① 默认值正确（无文件无 env；ADR 0043 默认开、降级开关默认关）
 *   ② 写配置文件 → reloadRuntimeFlags() → 快照翻转（持久化缓存 memo 重置生效）
 *   ③ env 优先：env 存在时 reload 不覆盖 env；来源标注 env/file/default 正确
 *   ④ 热更后 flag 门控白名单函数返回新集合（task.mjs cad_read/cad_edit、context.mjs dxf/dwg、workspace.mjs 扩展名）
 *   ⑤ 创建时快照项在热更后保持不变（任务白名单按任务创建时快照；逐次读取项新值生效）
 *
 * 本脚本自设 OAW_RUNTIME_FLAGS_FILE 指向临时文件，不触碰真实 `.oaw/`。
 * 运行：node scripts/运行开关热更测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-flags-hot-"));
const flagsFile = path.join(dir, "runtime-flags.json");
// 必须在动态 import 之前设置：RUNTIME_FLAGS_FILE 在模块加载时解析。
process.env.OAW_RUNTIME_FLAGS_FILE = flagsFile;
// 本机可能全局设置了 OAW_* 环境变量（如 OAW_CREATIVE_CANVAS=1），env 优先级最高会
// 干扰 file/default 断言；测试进程内清除本用例涉及的变量，保证判据确定性。
for (const key of ["OAW_CREATIVE_CANVAS", "OAW_MAP_REPORT", "OAW_CAD_AGENT", "OAW_CAD_PREVIEW", "OAW_CHART_WORKBENCH", "OAW_VISUAL_EFFECTS_OFF", "OAW_FEEDBACK_V2"]) {
  delete process.env[key];
}

// 注意：RUNTIME_FLAGS 是 let 绑定（热更后引用会变），必须经命名空间对象访问才是 live binding；
// 解构 `const { RUNTIME_FLAGS } = import(...)` 会拷贝当时值，热更后读到旧快照。
const 运行开关 = await import("../server/运行开关.mjs");
const { reloadRuntimeFlags, runtimeFlagSourcesSnapshot, flagSource } = 运行开关;
const { toolPolicyForMode } = await import("../server/task.mjs");
const { supportedExtensions } = await import("../server/workspace.mjs");
const { supportedDocumentExts } = await import("../server/context.mjs");

function writeFlags(obj) {
  fs.writeFileSync(flagsFile, JSON.stringify(obj, null, 2));
}

console.log("\n▶ 热更管道");

await test("① 默认值正确且快照冻结（无文件无 env）", () => {
  assert.equal(fs.existsSync(flagsFile), false, "临时配置文件此时不应存在");
  assert.equal(运行开关.RUNTIME_FLAGS.creativeCanvas, true, "creativeCanvas 按 ADR 0043 默认开");
  assert.equal(运行开关.RUNTIME_FLAGS.visualEffectsOff, false, "视觉特效降级开关默认关");
  assert.equal(运行开关.RUNTIME_FLAGS.feedbackV2, false, "feedbackV2 保持默认关（2026-10-28 D2）");
  assert.ok(Object.isFrozen(运行开关.RUNTIME_FLAGS), "快照应冻结");
  assert.equal(flagSource("OAW_CREATIVE_CANVAS"), "default", "无文件无 env 时来源为 default（flagSource 入参为 env 名）");
  assert.equal(runtimeFlagSourcesSnapshot().creativeCanvas, "default", "来源快照（语义名键）为 default");
});

await test("② 写配置文件 → reload → 快照翻转（live binding 生效）", () => {
  writeFlags({ creativeCanvas: false });
  const before = 运行开关.RUNTIME_FLAGS.creativeCanvas;
  reloadRuntimeFlags();
  assert.equal(before, true, "reload 前仍是默认值");
  assert.equal(运行开关.RUNTIME_FLAGS.creativeCanvas, false, "reload 后吃文件值（ESM live binding）");
  assert.equal(flagSource("OAW_CREATIVE_CANVAS"), "file", "来源应为 file");
  writeFlags({ creativeCanvas: true });
  reloadRuntimeFlags();
  assert.equal(运行开关.RUNTIME_FLAGS.creativeCanvas, true, "再翻转回 true");
});

await test("③ env 优先：reload 不覆盖 env，来源标注正确", () => {
  process.env.OAW_MAP_REPORT = "1";
  writeFlags({ mapReport: false });
  reloadRuntimeFlags();
  assert.equal(运行开关.RUNTIME_FLAGS.mapReport, true, "env=1 应压过文件 false");
  assert.equal(flagSource("OAW_MAP_REPORT"), "env");
  assert.equal(runtimeFlagSourcesSnapshot().mapReport, "env", "来源快照应为 env");
  delete process.env.OAW_MAP_REPORT;
  reloadRuntimeFlags();
  assert.equal(运行开关.RUNTIME_FLAGS.mapReport, false, "env 移除后回落文件值 false");
  assert.equal(flagSource("OAW_MAP_REPORT"), "file");
  // 恢复默认（清掉临时文件里的 mapReport，避免污染后续用例）
  writeFlags({});
  reloadRuntimeFlags();
  assert.equal(运行开关.RUNTIME_FLAGS.mapReport, true, "清文件后回落默认值 true");
});

await test("④ 热更后 flag 门控白名单函数返回新集合", () => {
  writeFlags({ cadAgent: false, creativeCanvas: false, chartWorkbench: false, cadPreview: false });
  reloadRuntimeFlags();
  const chat = toolPolicyForMode("chat").tools;
  const agent = toolPolicyForMode("agent").tools;
  assert.ok(!chat.includes("cad_read"), "cadAgent 关：Chat 白名单无 cad_read");
  assert.ok(!agent.includes("cad_read") && !agent.includes("cad_edit"), "cadAgent 关：Work 白名单无 cad_read/cad_edit");
  assert.ok(!agent.includes("canvas_read"), "creativeCanvas 关：Work 白名单无 canvas_*");
  assert.ok(!agent.includes("chart_read"), "chartWorkbench 关：Work 白名单无 chart_*");
  assert.ok(!supportedDocumentExts().has("dxf"), "cadAgent 关：context 支持集无 dxf");
  assert.ok(!supportedExtensions().test("平面图.dxf"), "cadPreview 关：文件树扩展名不含 dxf");
  // 翻回开启：新集合恢复
  writeFlags({ cadAgent: true, creativeCanvas: true, chartWorkbench: true, cadPreview: true });
  reloadRuntimeFlags();
  const agent2 = toolPolicyForMode("agent").tools;
  assert.ok(agent2.includes("cad_edit") && agent2.includes("canvas_read") && agent2.includes("chart_read"), "开关翻回后白名单恢复");
  assert.ok(supportedExtensions().test("平面图.dxf"), "cadPreview 开：扩展名含 dxf");
});

await test("⑤ 创建时快照项在热更后保持不变，新调用吃新值", () => {
  const snapshotBefore = toolPolicyForMode("agent").tools;
  writeFlags({ cadAgent: false });
  reloadRuntimeFlags();
  assert.ok(snapshotBefore.includes("cad_edit"), "任务创建时快照的白名单在热更后不变（运行中任务语义稳定）");
  assert.ok(!toolPolicyForMode("agent").tools.includes("cad_edit"), "热更后新调用返回新集合（新任务即时生效）");
  // 清理：恢复默认
  writeFlags({});
  reloadRuntimeFlags();
});

console.log(`\n运行开关热更测试：${failed ? "失败" : "通过 5 项"}`);
process.exit(failed ? 1 : 0);
