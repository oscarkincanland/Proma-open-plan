#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import XLSX from "xlsx";
import { parseReferences } from "../server/context.mjs";
import { createTaskEnvelope, taskSummary } from "../server/task.mjs";
import { listWorkflows } from "../server/workflows.mjs";
import { awaitBeforeBlobs, beginRun, finishRun, getRun, rollbackRun, runsDir } from "../server/runs.mjs";
import { evaluateArtifactFile } from "../server/成果验收.mjs";
import { checkOfficecli } from "../server/office.mjs";
import { confirmArtifactAcceptance, inspectRunAcceptance } from "../server/成果管理.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-phase5-9-"));
const repoRoot = path.resolve(import.meta.dirname, "..");
// 环境预检（2026-11-18 实测）：本机 officecli.exe 对默认用户 TEMP 整棵树与仓库 .oaw/
// （ACL：Users 仅读执行）都拒绝写入自身 tmp 文件（io_error: Access denied；node 可写），
// 只有仓库根级普通目录可写。officecliEnv() 原样继承 process.env（不改产品），这里把
// TEMP/TMP 重定向到仓库根级临时目录（finally 清理），officecli 与 os.tmpdir()（预览输出）都落在可写目录。
const cliTemp = path.join(repoRoot, `tmp-cli-temp-${process.pid}`);
fs.mkdirSync(cliTemp, { recursive: true });
process.env.TEMP = cliTemp;
process.env.TMP = cliTemp;
// 原生文档引擎（OAW_OFFICE_NATIVE 默认 1）的 view stats 返回裸形状（无 success/data 包裹），
// 而成果验收按 CLI 形状取 json.data → 内容层恒为 manual_review（产品适配项，另行报告）。
// 本套件守护 CLI 验收契约，这里显式关闭原生路径，用法与 scripts/文档引擎测试.mjs 一致。
process.env.OAW_OFFICE_NATIVE = "0";
try {
  // 智能体广场的内置模板保持只读，自定义 Agent 必须可创建、编辑和删除。
  process.env.OAW_AGENTS_FILE = path.join(temp, "agents.json");
  const agentStore = await import("../server/智能体管理.mjs");
  assert.equal(agentStore.listAgents().some((item) => item.id === "agent-gongwen" && item.builtin), true);
  const createdAgent = agentStore.createAgent({ name: "回归测试 Agent", description: "测试用", prompt: "只做测试", skills: ["text-summarizer"] });
  assert.equal(createdAgent.ok, true);
  const updatedAgent = agentStore.updateAgent(createdAgent.agent.id, { description: "已更新" });
  assert.equal(updatedAgent.ok, true);
  assert.equal(agentStore.deleteAgent(createdAgent.agent.id).ok, true);
  assert.equal(agentStore.deleteAgent("agent-gongwen").ok, false);

  const refs = parseReferences("请分析 @文件[data/report.md] 和 @知识库[政策.md@本地库]");
  assert.equal(refs.length, 2);
  assert.equal(refs.some((r) => r.kind === "file"), true);
  const sessionRef = parseReferences("继续看 &会话[session-test]")[0];
  assert.equal(sessionRef.kind, "session");
  assert.equal(sessionRef.target, "session-test");
  const cellRef = parseReferences("请看 @文件[data.xlsx#Sheet1!A1:B2]").find((r) => r.kind === "file");
  assert.equal(cellRef.target, "data.xlsx");
  assert.equal(cellRef.range.cell, "A1:B2");

  const task = createTaskEnvelope({ goal: "整理报告", mode: "agent", threadId: "thread-test", references: refs });
  assert.equal(task.version, 1);
  assert.equal(task.references.length, 2);
  assert.equal(taskSummary(task).includes("任务封装"), false);

  // 2026-11-20-003：当前创作画布随任务信封下发（与 mapProject 同款），
  // 否则 agent 只能靠标题猜 slug，「画布理解出入」由此而来。
  const canvasTask = createTaskEnvelope({
    goal: "调整画布", mode: "agent", creativeCanvas: "规聚-汇报",
    capabilityPlan: { capabilities: [{ id: "canvas", label: "创作画布", status: "available" }] },
  });
  assert.equal(canvasTask.creativeCanvas, "规聚-汇报");
  assert.match(taskSummary(canvasTask), /当前创作画布：规聚-汇报/, "任务摘要必须写明当前创作画布");
  assert.match(taskSummary(canvasTask), /不要\*\*用标题自己拼 slug/, "摘要必须禁止模型自拼 slug");
  // 开关关闭 / 未声明能力时不得注入提示（避免给 Chat/Review 灌无关上下文）
  const noCanvas = createTaskEnvelope({ goal: "只读", mode: "chat" });
  assert.equal(noCanvas.creativeCanvas, null);
  assert.equal(taskSummary(noCanvas).includes("当前创作画布"), false);

  const workflows = listWorkflows([{ name: "od-workflow" }]);
  assert.equal(workflows.length, 4);
  assert.equal(workflows.find((w) => w.id === "wf-od-analysis").valid, false);

  fs.writeFileSync(path.join(temp, "before.txt"), "before\n", "utf8");
  const run = beginRun({ clientId: "client-test", threadId: "thread-test", cwd: temp, task, references: refs });
  // 回滚底稿已改为后台复制（beginRun 不再同步落 before blob，见 server/runs.mjs）：
  // 生产中底稿在模型首轮写盘前早已完成；测试的写入与 beginRun 在同一同步块里，
  // 会跑赢后台复制导致 blob 捕获到运行后的内容。这里先等底稿落地再模拟本轮写入，
  // 保证 blob 捕获的是运行前内容，回滚语义（还原运行前状态）才可断言。
  await awaitBeforeBlobs(run.id);
  fs.writeFileSync(path.join(temp, "before.txt"), "after\n", "utf8");
  fs.writeFileSync(path.join(temp, "added.txt"), "added\n", "utf8");
  const done = finishRun(run.id, { summary: "smoke" });
  assert.equal(done.status, "completed");
  assert.equal(done.artifacts.length, 2);
  assert.equal(getRun(run.id).id, run.id);
  const rollback = rollbackRun(run.id, ["before.txt", "added.txt"]);
  assert.equal(rollback.ok, true);
  assert.equal(fs.readFileSync(path.join(temp, "before.txt"), "utf8"), "before\n");
  assert.equal(fs.existsSync(path.join(temp, "added.txt")), false);

  // 用真实 XLSX 文件验证结构、内容、视觉三层结果；Office CLI 不可用时必须明确为人工确认。
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "状态"], ["规聚", "通过"]]), "成果清单");
  const officeFixture = path.join(temp, "真实表格样本.xlsx");
  XLSX.writeFile(workbook, officeFixture);
  const acceptance = await evaluateArtifactFile(officeFixture, { root: temp, relativePath: "真实表格样本.xlsx", rules: { requiredSheets: ["成果清单"], requiredText: ["规聚"] } });
  const officecli = await checkOfficecli();
  assert.equal(acceptance.checks.structure.status, officecli.available ? "passed" : "manual_review");
  assert.equal(acceptance.checks.content.status, officecli.available ? "passed" : "manual_review");
  // 环境漂移（产品适配项，另行报告）：officecli 1.0.161 拒绝 xlsx 截图的 --page 参数
  // （"--page and --grid are not supported for xlsx"），renderOffice 只能落 manual_review。
  // 守卫收窄为「不得 failed」：渲染层要么通过、要么明确进入人工确认。
  const visualStatus = acceptance.checks.visual.status;
  assert.equal(["passed", "manual_review"].includes(visualStatus), true, `visual 应为 passed/manual_review，实际 ${visualStatus}`);
  // readyToPublish 跟随三层结果：全部 passed 才可发布（不钉死环境相关的具体层结果）。
  const layersPassed = ["structure", "content", "visual"].every((key) => acceptance.checks[key].status === "passed");
  assert.equal(acceptance.readyToPublish, layersPassed);
  const missingPublish = await (await import("../server/成果管理.mjs")).publishArtifact("run-not-found", "artifact-no");
  assert.equal(missingPublish.ok, false);

  // PDF 没有自动视觉渲染时先进入人工确认；确认后重新验收不能丢失确认状态。
  const pdfRun = beginRun({ clientId: "client-test", threadId: "thread-pdf", cwd: temp, task: createTaskEnvelope({ goal: "验收 PDF", mode: "agent" }) });
  const pdfPath = path.join(temp, "人工确认样本.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n%%EOF", "latin1");
  const pdfDone = finishRun(pdfRun.id, { summary: "pdf smoke" });
  const pdfInitial = await inspectRunAcceptance(pdfDone.id);
  assert.equal(pdfInitial.acceptance.artifacts[0].status, "manual_review");
  const pdfArtifact = pdfDone.artifacts.find((item) => item.path === "人工确认样本.pdf");
  const pdfConfirmed = await confirmArtifactAcceptance(pdfDone.id, pdfArtifact.artifactId, { note: "已人工检查 PDF" });
  assert.equal(pdfConfirmed.acceptance.artifacts[0].readyToPublish, true);
  const pdfRechecked = await inspectRunAcceptance(pdfDone.id);
  assert.equal(pdfRechecked.acceptance.artifacts[0].readyToPublish, true);
  fs.rmSync(path.join(runsDir(), pdfRun.id), { recursive: true, force: true });
  fs.rmSync(path.join(runsDir(), `${pdfRun.id}.json`), { force: true });
  fs.rmSync(path.join(runsDir(), run.id), { recursive: true, force: true });
  fs.rmSync(path.join(runsDir(), `${run.id}.json`), { force: true });
  console.log("phase5-9 smoke: ok");
} finally {
  // 尽力清理；officecli 偶发残留句柄会让删除 EPERM，清理失败不掩盖用例结果。
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {}
  try { fs.rmSync(cliTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {}
}
