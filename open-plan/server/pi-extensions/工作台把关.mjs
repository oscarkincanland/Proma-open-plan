/**
 * U2+U6：工作台把关扩展（Pi Extension，随主会话 additionalExtensionPaths 加载）。
 *
 * 职责分层（与 agent.mjs 的 E02 事件层门禁互补，使用同一套 运行预算.mjs 纯函数）：
 *   - 本扩展：**工具级拦截**——在工具真正执行前（tool_call）评估门禁，命中即 block，
 *     模型收到结构化拒绝原因后可继续调整方案，不再像 hard 模式那样整 Run 中断。
 *   - agent.mjs E02：**回合级门禁**（turn 预算、硬停 abort）保持不变，作为兜底层。
 *
 * 事件语义：
 *   - block 时 reason 以 "[工具门禁]" 前缀标记；agent.mjs 的 tool_end 转译检测该前缀
 *     发出 tool_gate_denied 事件（注册表 persist:true），前端可见"被门禁拒绝"。
 *   - session_before_compact：注入保留任务上下文的压缩指令（SessionBeforeCompactResult）。
 *   - session_compact_failed：向会话注入 steer 提示，压缩失败不再静默。
 *
 * 本扩展仅在 OAW_PI_TOOL_GATE=on 时被加载（见 agent.mjs additionalExtensionPaths 接线）。
 */
import {
  createRunBudget,
  evaluateToolGate,
  noteToolResult,
  noteTurn,
} from "../运行预算.mjs";
import { RUNTIME_FLAGS } from "../运行开关.mjs";
import { getToolMetadata } from "../工具元数据.mjs";
import { analyzeCompactionPlan, rememberCompactionPlan } from "../上下文诊断.mjs";

// 压缩保留的最近轮次（仅用于诊断标注，实际保留量由 Pi 的 keepRecentTokens 决定）。
const PI_KEEP_RECENT_TURNS = 6;

const GATE_MARKER = "[工具门禁]";

/** 工具执行结果是否是本扩展发出的门禁拒绝（agent.mjs tool_end 转译用）。 */
export function isToolGateRejection(text) {
  return typeof text === "string" && text.includes(GATE_MARKER);
}

export default function workbenchGateExtension(pi) {
  // 会话级预算状态（扩展实例每会话一份；runId 在扩展层不可见，置空）。
  const budget = createRunBudget({
    runId: null,
    unlimited: RUNTIME_FLAGS.runBudgetUnlimited,
    limits: { failureLimit: RUNTIME_FLAGS.toolFailureLimit },
  });
  const toolArgsById = new Map();

  pi.on("turn_start", () => {
    noteTurn(budget);
  });

  pi.on("tool_call", (event) => {
    const toolName = String(event?.toolName || event?.name || "?");
    const args = event?.input ?? event?.args ?? null;
    const toolCallId = event?.toolCallId ?? null;
    if (toolCallId && toolArgsById.size > 400) toolArgsById.clear();
    if (toolCallId) toolArgsById.set(String(toolCallId), args);
    // 2026-11-19-010 P1：破坏性工具保持更严阈值（默认 2 次即停手）。
    const destructive = Boolean(getToolMetadata(toolName)?.destructive);
    const gate = evaluateToolGate(budget, { toolName, args, destructive });
    if (gate.level === "soft") {
      // 软预算不拦截：回合级软提醒由 agent.mjs E02 事件层承担（steer 通道），
      // 扩展层避免重复提醒；此处仅记录，保持"扩展=硬拦截、E02=软提醒"分层。
      return undefined;
    }
    if (gate.level === "hard" || gate.allow === false) {
      return { block: true, reason: `${GATE_MARKER} ${gate.code || "GATE_BLOCKED"}：${gate.reason || "命中硬预算/重复失败门禁，请调整方案"}` };
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const toolCallId = event?.toolCallId ? String(event.toolCallId) : "";
    const args = toolCallId ? toolArgsById.get(toolCallId) ?? null : null;
    if (toolCallId) toolArgsById.delete(toolCallId);
    noteToolResult(budget, {
      toolName: String(event?.toolName || event?.name || "?"),
      args,
      ok: event?.isError !== true,
      error: String(event?.error || event?.result || "").slice(0, 300),
    });
  });

  // 2026-11-19-010 P3.3：session_before_compact 的形状已实证（CompactionPreparation 提供
  // messagesToSummarize / tokensBefore / firstKeptEntryId / fileOps）。这里只做**诊断**：
  // 算出"这次压缩将丢掉多少工具结果/图片"，交给 agent.mjs 发 context_compaction_plan；
  // 不返回 compaction，压缩本身仍由 Pi 内核完成（不改写私有消息数组）。
  pi.on("session_before_compact", (event) => {
    try {
      const plan = analyzeCompactionPlan(event?.preparation || {}, {
        keepRecentTurns: PI_KEEP_RECENT_TURNS,
      });
      rememberCompactionPlan(plan);
    } catch { /* 诊断失败绝不影响压缩 */ }
    return undefined;
  });

  pi.on("session_compact_failed", (event) => {
    const message = `上下文压缩失败（${event?.reason || "unknown"}${event?.aborted ? "，已中止" : ""}）：${String(event?.errorMessage || "").slice(0, 200)}`;
    // 压缩失败可见化：不再静默——服务端日志 + 模型下一轮上下文可感知（错误进入会话流）。
    try { console.error(`[工具把关扩展] ${message}`); } catch {}
  });
}
