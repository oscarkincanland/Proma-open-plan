import React, { useCallback, useEffect, useRef, useState } from "react";
import Icon from "../Icon.jsx";

/**
 * 待处理动作弹窗（2026-11-23-001）。
 *
 * 背景（用户原话）：「ask 和审批的工具 agent 接收不到？显示失败，然后这个卡片就一直留在对话栏？
 * 能否这个卡片就做成这个弹窗形式的把对话栏直接覆盖，点击了或者失败了就收起来呢？」
 *
 * 职责边界：
 *   - 只负责「把待处理动作放大到用户眼前」：覆盖对话栏、强制可见、可键盘操作。
 *   - **不做结算**：onApprove / onDeny / onAnswer / onSkip / onExpire 全部由 ChatPanel 注入，
 *     审批的安全语义（allow / always / deny 与全局规则）仍在 `/api/agent/approval`。
 *   - 不持有跨轮状态：`approval` / `ask` 由 ChatPanel 按消息块推导后传入；结算后两者变 null，
 *     弹窗自然消失（不需要额外关闭动画状态机）。
 *
 * 形态（DESIGN §6.4 弹层规范）：
 *   - `position: fixed; inset: 0`（`--z-confirm`，高于对话栏），点击遮罩**不**关闭——
 *     这是阻塞式动作，误触关闭会让人以为已处理。
 *   - Esc 关闭＝显式放弃本次（审批走 deny，提问走 skip），必须二次确认。
 *   - 顶部标题条给出「谁在等 / 等多久」，正文是可复核的命令或问题，底部是动作区。
 */
export default function PendingActionModal({
  approval = null,
  ask = null,
  now = Date.now(),
  busy = false,
  error = "",
  onApprove,
  onDeny,
  onAnswer,
  onSkip,
  onExpire,
  onOpenFile,
}) {
  const [answer, setAnswer] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const inputRef = useRef(null);

  const isApproval = Boolean(approval);
  const item = isApproval ? approval : ask;
  const id = String(item?.id || "");
  const visible = Boolean(id);

  // 换了一条待处理动作就重置本地输入与二次确认态。
  useEffect(() => {
    setAnswer("");
    setConfirmLeave(false);
  }, [id]);

  // 打开后聚焦输入框（提问）或首个按钮（审批），键盘用户不迷路。
  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setTimeout(() => {
      if (isApproval) inputRef.current?.querySelector("button")?.focus?.();
      else inputRef.current?.focus?.();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [visible, isApproval]);

  // Esc：先确认再放弃，避免误触把阻塞动作当成已处理。
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmLeave) {
        setConfirmLeave(false);
        return;
      }
      setConfirmLeave(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, confirmLeave]);

  const submitAnswer = useCallback(() => {
    const value = String(answer || "").trim();
    if (!value || busy) return;
    onAnswer?.(item, value);
  }, [answer, busy, item, onAnswer]);

  const submitSkip = useCallback(() => {
    if (busy) return;
    onSkip?.(item);
  }, [busy, item, onSkip]);

  if (!visible) return null;

  const remain = Number(item.expiresAt || 0) ? Math.max(0, Number(item.expiresAt) - now) : null;
  const countdown = remain == null ? "" : `${Math.ceil(remain / 1000)}s 后失效`;
  const toolName = String(item.tool || "");
  const title = isApproval ? `需要你审批：${toolName || "工具"}` : "Agent 需要你确认";

  return (
    <div className="pending-modal-mask" role="presentation">
      <div
        className="pending-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby="pending-modal-body"
        ref={inputRef}
      >
        <div className="pending-modal-head">
          <Icon name={isApproval ? "shield" : "comment"} size={14} />
          <strong className="pending-modal-title">{title}</strong>
          {countdown && <span className="pending-modal-countdown" role="timer">{countdown}</span>}
        </div>

        <div className="pending-modal-body" id="pending-modal-body">
          {isApproval ? (
            <>
              <div className="pending-modal-command" title={String(item.input || "")}>{String(item.input || "")}</div>
              <div className="pending-modal-note">
                「总是允许」会把规则写入本机全局配置（跨会话、跨项目、跨工作区生效），可在「设置 → 审批与权限」随时撤销。
                自动批准不会覆盖显式拒绝。
              </div>
            </>
          ) : (
            <>
              <div className="pending-modal-question">{String(item.question || item.text || "请补充信息")}</div>
              {String(item.previewFile || "") && (
                <button type="button" className="btn-xs" onClick={() => onOpenFile?.(item.previewFile)}>
                  <Icon name="eye" size={12} /> 查看草稿预览
                </button>
              )}
              {String(item.assumption || "") && (
                <div className="pending-modal-note">默认假设：{item.assumption}（不回答将按此继续）</div>
              )}
              {Array.isArray(item.options) && item.options.length > 0 && (
                <div className="pending-modal-options">
                  {item.options.map((option) => (
                    <button
                      type="button"
                      key={String(option)}
                      className="btn-xs"
                      disabled={busy}
                      onClick={() => onAnswer?.(item, String(option))}
                    >
                      {String(option)}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                className="pending-modal-input"
                rows={3}
                value={answer}
                placeholder="输入回答后按 Ctrl+Enter 提交…"
                aria-label="回答内容"
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    submitAnswer();
                  }
                }}
              />
            </>
          )}

          {error && <div className="pending-modal-error" role="alert">{error}</div>}
          {confirmLeave && (
            <div className="pending-modal-confirm" role="alert">
              关闭会放弃本次{isApproval ? "审批（等于拒绝，Agent 不会执行该操作）" : "提问（按默认假设继续）"}，确认？
              <button
                type="button"
                className="btn-xs danger"
                disabled={busy}
                onClick={() => { setConfirmLeave(false); (isApproval ? onDeny : onSkip)?.(item); }}
              >
                确认放弃
              </button>
              <button type="button" className="btn-xs" onClick={() => setConfirmLeave(false)}>继续处理</button>
            </div>
          )}
        </div>

        <div className="pending-modal-actions">
          {isApproval ? (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => onApprove?.(item, "allow")}>允许一次</button>
              <button type="button" className="btn" disabled={busy} onClick={() => onApprove?.(item, "always")}>总是允许</button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => onDeny?.(item)}>拒绝</button>
            </>
          ) : (
            <>
              <button type="button" className="btn primary" disabled={busy || !answer.trim()} onClick={submitAnswer}>
                {busy ? "…" : "提交回答"}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={submitSkip}>跳过（按专业判断继续）</button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => onExpire?.(item)}>放弃本次</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
