/**
 * 上下文压缩诊断（2026-11-19-010 P3.3）。
 *
 * 依据：pi 内核的 `session_before_compact` 钩子（`CompactionPreparation`）已经给出
 * `messagesToSummarize / tokensBefore / firstKeptEntryId / fileOps`，这是**受支持**的
 * 实证接口，不需要改写 Pi 私有消息数组（对抗审查 M6/R4）。
 *
 * 本模块只做两件事：
 *  1. `analyzeCompactionPlan()`：把"这次压缩将丢掉什么"算成人能看的数字（纯函数）；
 *  2. `rememberCompactionPlan / takeCompactionPlan`：扩展钩子与 agent.mjs 之间的进程内交接
 *     （扩展 API 没有 emit，只能通过共享模块传递；带 TTL，避免跨会话串台）。
 */

const DEFAULT_PLAN_TTL_MS = 120_000;
const plans = new Map();

function messageParts(message) {
  const content = message?.content;
  if (Array.isArray(content)) return content;
  if (content === undefined || content === null) return [];
  return [{ type: "text", text: String(content) }];
}

function bytesOf(value) {
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? ""), "utf8");
  } catch {
    return 0;
  }
}

function isToolResultMessage(message) {
  const role = String(message?.role || "").toLowerCase();
  return role === "toolresult" || role === "tool_result" || role === "tool";
}

/**
 * 分析一次压缩计划。
 *
 * @param {object} preparation `CompactionPreparation`（messagesToSummarize/tokensBefore/firstKeptEntryId/fileOps）
 * @param {object} [options]
 * @returns {object} 供 `context_compaction_plan` 事件使用的统计数据
 */
export function analyzeCompactionPlan(preparation = {}, { keepRecentTurns = 0 } = {}) {
  const messages = Array.isArray(preparation?.messagesToSummarize) ? preparation.messagesToSummarize : [];
  let toolResults = 0;
  let toolResultBytes = 0;
  let biggestToolResultBytes = 0;
  let images = 0;
  let imageBytes = 0;
  let textBytes = 0;
  for (const message of messages) {
    if (isToolResultMessage(message)) {
      const size = bytesOf(message?.content);
      toolResults += 1;
      toolResultBytes += size;
      if (size > biggestToolResultBytes) biggestToolResultBytes = size;
    }
    for (const part of messageParts(message)) {
      const type = String(part?.type || "");
      if (type === "image") {
        images += 1;
        imageBytes += bytesOf(part?.data ?? part?.source ?? part);
      } else if (type === "text" && !isToolResultMessage(message)) {
        textBytes += bytesOf(part?.text);
      }
    }
  }
  const tokensBefore = Number(preparation?.tokensBefore) || 0;
  // 粗估：被摘要丢弃的工具结果/图片按 4 字节≈1 token 折算；正文本身仍会进摘要，不计入"省下"。
  const estimatedTokensFreed = Math.ceil((toolResultBytes + imageBytes) / 4);
  return {
    messageCount: messages.length,
    toolResults,
    toolResultBytes,
    biggestToolResultBytes,
    images,
    imageBytes,
    textBytes,
    tokensBefore,
    estimatedTokensFreed,
    firstKeptEntryId: String(preparation?.firstKeptEntryId || "") || null,
    isSplitTurn: Boolean(preparation?.isSplitTurn),
    keepRecentTurns: Number(keepRecentTurns) || 0,
    readFiles: Array.isArray(preparation?.fileOps?.readFiles) ? preparation.fileOps.readFiles.slice(0, 50) : [],
    modifiedFiles: Array.isArray(preparation?.fileOps?.modifiedFiles) ? preparation.fileOps.modifiedFiles.slice(0, 50) : [],
  };
}

/** 记录本次压缩计划，供 agent.mjs 在 `compaction_start` 时取用。 */
export function rememberCompactionPlan(plan, { key = "latest", now = Date.now() } = {}) {
  if (!plan || typeof plan !== "object") return null;
  plans.set(String(key || "latest"), { at: now, plan });
  return plan;
}

/** 取出并删除（一次性消费），超时视为不可用。 */
export function takeCompactionPlan({ key = "latest", maxAgeMs = DEFAULT_PLAN_TTL_MS, now = Date.now() } = {}) {
  const slot = plans.get(String(key || "latest"));
  if (!slot) return null;
  plans.delete(String(key || "latest"));
  if (now - slot.at > Math.max(1000, Number(maxAgeMs) || DEFAULT_PLAN_TTL_MS)) return null;
  return slot.plan;
}

/** 测试/诊断用：清空交接槽。 */
export function clearCompactionPlans() {
  plans.clear();
}
