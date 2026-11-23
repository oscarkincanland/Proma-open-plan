import React, { useEffect, useState } from "react";
import Logo from "./Logo.jsx";
import { isDesktopHost, 桌面窗口控制 } from "../平台/宿主.js";

/**
 * 桌面标题栏（ADR 0044 P5）。
 *
 * Proma 壳主窗口为 frameless（titleBarStyle:"hidden"），原生标题栏控制
 * 由 Proma 自身 renderer 的自绘标题栏承接；嵌入 open-plan 页面后该标题栏
 * 不存在，窗口会失去拖动区与最小化/最大化/关闭按钮。本组件在桌面宿主下
 * 渲染一条顶部标题栏补齐窗口语义：
 *   - 顶栏整体 `-webkit-app-region: drag`（可拖动窗口）
 *   - 右侧三键经宿主桥调用 Proma 既有 window:minimize/maximize/close IPC
 * 浏览器形态（isDesktopHost()===false）不渲染任何 DOM。
 */
export default function 桌面标题栏() {
  const [maximized, setMaximized] = useState(false);
  const controls = 桌面窗口控制();

  useEffect(() => {
    if (!controls) return undefined;
    document.body.classList.add("desktop-host");
    return () => document.body.classList.remove("desktop-host");
  }, [controls]);

  if (!controls) return null;

  const minimize = () => { controls.minimize(); };
  const toggleMaximize = () => {
    controls.toggleMaximize();
    // Proma 未提供 is-maximized 查询的桌面桥，按本地翻转近似渲染图标
    setMaximized((v) => !v);
  };
  const close = () => { controls.close(); };

  return (
    <div className="desktop-titlebar" role="toolbar" aria-label="窗口控制">
      <span className="titlebar-logo" aria-hidden="true">
        <Logo size={16} />
      </span>
      <span className="titlebar-name">Open Plan 规聚</span>
      <span className="titlebar-spacer" />
      <button type="button" className="titlebar-btn" onClick={minimize} aria-label="最小化" title="最小化">
        <svg viewBox="0 0 12 12" width="12" height="12"><path d="M1 6h10" stroke="currentColor" strokeWidth="1.1" /></svg>
      </button>
      <button type="button" className="titlebar-btn" onClick={toggleMaximize} aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"}>
        {maximized ? (
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.1">
            <rect x="1.5" y="3.5" width="7" height="7" />
            <path d="M3.5 3.5v-2h7v7h-2" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.1">
            <rect x="1.5" y="1.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button type="button" className="titlebar-btn close" onClick={close} aria-label="关闭" title="关闭">
        <svg viewBox="0 0 12 12" width="12" height="12"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.1" /></svg>
      </button>
    </div>
  );
}
