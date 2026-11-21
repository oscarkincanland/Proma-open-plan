/**
 * 目标空闲自动推进（2026-11-19-010 P2）——纯判定 + 进程内进度记忆，无 IO。
 *
 * 设计约束（对齐方案 §2 与对抗审查 M1–M3 / R1–R3）：
 *  - 分为两条路径：`advance` 新开 Run（上一轮 completed 但目标未达成）、`resume` 走既有恢复通道
 *    （仅 failed/aborted/recovering；completed 不在可续集合内，见 index.mjs CONTINUABLE_RUN_STATUSES）；
 *  - **任何来源的 cancelled 都不推进**（用户取消、静默回收、取消看门狗）；
 *  - `recovering` 只在进程启动一段时间后才允许续，避免开机立刻自动重跑；
 *  - 连续 N 轮无进展（产物数/完成度/验收状态都没变）→ `block`，等用户处理；
 *  - 本模块只做判断，启动 Run、写事件、更新 Goal 统计都由调用方（index.mjs）负责。
 *
 * 事实源：Goal 状态与轮次在 `server/goal.mjs`；本模块不写 goal 文件，也不读磁盘。
 */

export const GOAL_ROUND_DEFAULTS = Object.freeze({
  /** 两次自动推进之间的最小间隔（毫秒）。 */
  cooldownMs: 60_000,
  /** 进程启动后多久才允许续 recovering（毫秒）。 */
  recoveringGraceMs: 10 * 60_000,
  /** 连续多少轮无进展转为 blocked。 */
  noProgressRounds: 2,
  /** 自动推进失败后的退避（毫秒），超出后停止自动。 */
  failureBackoffMs: Object.freeze([60_000, 300_000, 900_000]),
  /** 一次自动推进连续失败多少次后停止。 */
  maxFailures: 3,
});

const ACTIVE_RUN_STATUSES = new Set(["running", "queued", "waiting_user", "cancel_requested", "finishing"]);
const RESUMABLE_RUN_STATUSES = new Set(["failed", "aborted"]);

/** 进程内进度记忆：goalId → { signature, count, failures, lastAttemptAt }。 */
const goalRoundState = new Map();

export function goalRoundStateOf(goalId) {
  return goalRoundState.get(String(goalId || "")) || { signature: "", count: 0, failures: 0, lastAttemptAt: 0, lastRunId: "" };
}

export function clearGoalRoundState(goalId) {
  goalRoundState.delete(String(goalId || ""));
}

/** 续轮后判定"有没有进展"的签名：产物数 / 完成度 / 验收状态任一变化即算进展。 */
export function progressSignature(run) {
  if (!run || typeof run !== "object") return "";
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts.length : 0;
  const completion = String(run.completion?.status || run.completionStatus || "");
  const verification = String(run.verificationStatus || "");
  const blocked = run.completion?.blocked ? "1" : "0";
  return `${artifacts}|${completion}|${verification}|${blocked}`;
}

/** 记录一次已完成轮次的进展，返回最新计数。 */
export function noteRoundProgress(goalId, run) {
  const key = String(goalId || "");
  const state = goalRoundState.get(key) || { signature: "", count: 0, failures: 0, lastAttemptAt: 0, lastRunId: "" };
  if (run?.id && state.lastRunId === run.id) return state;
  const signature = progressSignature(run);
  if (signature && signature === state.signature) state.count += 1;
  else state.count = 0;
  state.signature = signature;
  state.lastRunId = run?.id || state.lastRunId || "";
  state.failures = 0;
  goalRoundState.set(key, state);
  return state;
}

export function noteRoundAttempt(goalId) {
  const key = String(goalId || "");
  const state = goalRoundState.get(key) || { signature: "", count: 0, failures: 0, lastAttemptAt: 0 };
  state.lastAttemptAt = Date.now();
  goalRoundState.set(key, state);
}

export function noteRoundFailure(goalId) {
  const key = String(goalId || "");
  const state = goalRoundState.get(key) || { signature: "", count: 0, failures: 0, lastAttemptAt: 0 };
  state.failures += 1;
  goalRoundState.set(key, state);
  return state.failures;
}

/** 失败退避毫秒；已达上限返回 null（调用方应停止自动并标 blocked）。 */
export function roundBackoffMs(failures) {
  const count = Math.max(0, Number(failures) || 0);
  if (count >= GOAL_ROUND_DEFAULTS.maxFailures) return null;
  const table = GOAL_ROUND_DEFAULTS.failureBackoffMs;
  return table[Math.min(count, table.length - 1)] || table[table.length - 1];
}

/** 有效轮次上限：Goal 自身 maxTurns 优先，0 表示用全局硬顶。 */
export function effectiveMaxTurns(goal, globalMaxTurns = 0) {
  const own = Number(goal?.maxTurns) || 0;
  if (own > 0) return own;
  const global = Number(globalMaxTurns) || 0;
  return global > 0 ? global : 0;
}

/**
 * 决定这一 tick 该做什么。
 *
 * @returns {{action: "none"|"advance"|"resume"|"block", reason: string, round: number}}
 *   - advance：新开 Run 推进目标（上一轮 completed 且仍有进展空间）
 *   - resume：走既有恢复通道（上一轮 failed/aborted，或 grace 之后的 recovering）
 *   - block：停止自动推进，需把 goal 标成对应状态（max_turns / budget_limited / blocked）
 *   - none：本轮不动（含各种 skip 原因）
 */
export function decideGoalRound({
  goal = null,
  lastRun = null,
  sessionBusy = false,
  pendingApprovals = 0,
  pendingAsks = 0,
  enabled = false,
  globalMaxTurns = 0,
  processStartedAt = 0,
  now = Date.now(),
} = {}) {
  const round = Number(goal?.turns) || 0;
  if (!enabled) return { action: "none", reason: "disabled", round };
  if (!goal) return { action: "none", reason: "no_goal", round };
  if (goal.status !== "active") return { action: "none", reason: `goal_${goal.status}`, round };

  const maxTurns = effectiveMaxTurns(goal, globalMaxTurns);
  if (maxTurns > 0 && round >= maxTurns) return { action: "block", reason: "max_turns", round };
  const budget = Number(goal.budgetTokens) || 0;
  if (budget > 0 && (Number(goal.usedTokens) || 0) >= budget) return { action: "block", reason: "budget_limited", round };

  const state = goalRoundStateOf(goal.goalId);
  if (state.failures >= GOAL_ROUND_DEFAULTS.maxFailures) return { action: "block", reason: "retry_exhausted", round };

  if (pendingApprovals > 0) return { action: "none", reason: "awaiting_approval", round };
  if (pendingAsks > 0) return { action: "none", reason: "awaiting_user", round };
  if (sessionBusy) return { action: "none", reason: "session_busy", round };
  if (!lastRun) return { action: "none", reason: "no_run", round };

  const status = String(lastRun.status || "");
  if (ACTIVE_RUN_STATUSES.has(status)) return { action: "none", reason: "run_active", round };
  // 任何来源的 cancelled（用户取消 / 静默回收 / 取消看门狗）都不自动推进。
  if (status === "cancelled") return { action: "none", reason: "cancelled", round };
  if (status === "recovering") {
    const started = Number(processStartedAt) || 0;
    if (!started || now - started < GOAL_ROUND_DEFAULTS.recoveringGraceMs) {
      return { action: "none", reason: "recovering_grace", round };
    }
    return { action: "resume", reason: "recovering", round };
  }

  const finishedAt = Date.parse(String(lastRun.finishedAt || "")) || 0;
  if (finishedAt && now - finishedAt < GOAL_ROUND_DEFAULTS.cooldownMs) {
    return { action: "none", reason: "cooldown", round };
  }

  if (RESUMABLE_RUN_STATUSES.has(status)) {
    const backoff = roundBackoffMs(state.failures);
    if (backoff == null) return { action: "block", reason: "retry_exhausted", round };
    if (state.lastAttemptAt && now - state.lastAttemptAt < backoff) {
      return { action: "none", reason: "failure_backoff", round };
    }
    return { action: "resume", reason: `resume_${status}`, round };
  }

  if (status === "completed") {
    const signature = progressSignature(lastRun);
    if (signature && signature === state.signature) {
      const nextCount = state.count + 1;
      if (nextCount >= GOAL_ROUND_DEFAULTS.noProgressRounds) return { action: "block", reason: "no_progress", round };
    }
    return { action: "advance", reason: "goal_incomplete", round };
  }

  return { action: "none", reason: `status_${status || "unknown"}`, round };
}

/** 自动推进轮的提示词：要求先判断目标是否达成，避免重复已完成的工作。 */
export function goalRoundPrompt(goal, lastRun = null, { round = 0, maxTurns = 0 } = {}) {
  const text = String(goal?.text || "").trim();
  const id = String(goal?.goalId || "");
  const finalText = String(lastRun?.finalText || lastRun?.summary || "").replace(/\s+/g, " ").slice(0, 600);
  const artifacts = Array.isArray(lastRun?.artifacts) ? lastRun.artifacts.length : 0;
  const limit = maxTurns > 0 ? `${round + 1}/${maxTurns}` : String(round + 1);
  return [
    `【目标自动推进】第 ${limit} 轮（goal ${id}）。`,
    `目标：${text}`,
    finalText ? `上一轮（Run ${lastRun?.id || "?"}）的结论摘要：${finalText}` : "",
    artifacts ? `上一轮产出 ${artifacts} 个产物，先确认它们是否已经满足目标，不要重复生成。` : "",
    "要求：先核对目标是否已经达成；已达成 → 直接给出结论并调用 goal 工具把目标标为 complete；",
    "未达成 → 只推进剩余部分，不要重做已完成且无必要重复的副作用操作。",
  ].filter(Boolean).join("\n");
}
