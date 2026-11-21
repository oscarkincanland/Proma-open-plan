import React, { useEffect, useRef, useState } from "react";
import Icon from "../Icon.jsx";
import TextShimmer from "../../会话流/TextShimmer.jsx";

let rowSeq = 0;

/**
 * 时间线一行条目（落地文档 2026-10-31-001 §5.2 + 精修计划 2026-10-31-002 F1/F2-b）：
 * chevron + 语义图标 + 动作词 + 对象摘要 + 耗时 + 状态点，点击平滑展开明细。
 * - obj 可传 ReactNode（如思考的跑马灯滚动预览），配 objTitle 提供悬停原文；
 * - locked=true：不可收起（ask/审批交互块），头部无按钮语义、明细常开。
 * 明细内容由调用方以 children 传入（避免与 ChatPanel 内部组件形成循环依赖）。
 */
export default function TimelineRow({ icon, verb, obj = "", objTitle = "", timeText = "", state = "", defaultOpen = false, showState = true, locked = false, shimmer = false, className = "", children }) {
  const [open, setOpen] = useState(defaultOpen);
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = `tl-row-${++rowSeq}`;
  if (locked) {
    return (
      <div className={`tl-row locked open ${state ? `is-${state}` : ""} ${className}`.trim()}>
        <div className="tl-row-head no-toggle">
          {icon && <span className="tl-icon" aria-hidden="true"><Icon name={icon} size={13} /></span>}
          <span className="tl-verb">{shimmer ? <TextShimmer active>{verb}</TextShimmer> : verb}</span>
          {obj && <span className="tl-obj" title={objTitle || (typeof obj === "string" ? obj : undefined)}>{obj}</span>}
          {timeText && <span className="tl-time">{timeText}</span>}
          {showState && state && <span className={`tl-state ${state}`} aria-hidden="true" />}
        </div>
        <div className="tl-detail-wrap">
          <div className="tl-detail">{children}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`tl-row ${state ? `is-${state}` : ""} ${open ? "open" : ""} ${className}`.trim()}>
      <button
        type="button"
        className="tl-row-head"
        aria-expanded={open}
        aria-controls={idRef.current}
        onClick={() => {
          setOpen((value) => !value);
          // 跟底修复（2026-11-20）：展开/收起明细会改变行高——若用户正在跟尾，
          // 高度变化会把视口顶离底部、跟随被判定中断（实测反馈"展开思考/命令行
          // 后滚动就不奏效"）。经 oaw:follow-repin 通知 ChatPanel 在过渡期间重挂底部。
          window.dispatchEvent(new CustomEvent("oaw:follow-repin"));
        }}
      >
        <span className="tl-chev" aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
        {icon && <span className="tl-icon" aria-hidden="true"><Icon name={icon} size={13} /></span>}
        <span className="tl-verb">{shimmer ? <TextShimmer active>{verb}</TextShimmer> : verb}</span>
        {obj && <span className="tl-obj" title={objTitle || (typeof obj === "string" ? obj : undefined)}>{obj}</span>}
        {timeText && <span className="tl-time">{timeText}</span>}
        {showState && state && <span className={`tl-state ${state}`} aria-hidden="true" />}
      </button>
      <div className="tl-detail-wrap" aria-hidden={!open}>
        <div className="tl-detail" id={idRef.current}>{children}</div>
      </div>
    </div>
  );
}
