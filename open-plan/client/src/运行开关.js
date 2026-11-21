/**
 * 前端运行开关（与服务端 运行开关.mjs 对应的只读消费端）。
 *
 * 服务端经 /api/status 的 runtimeFlags 快照下发（评审 R8 管道）；
 * 快照到达前所有开关按「关闭」处理 —— 关闭即基线行为，因此早期渲染天然安全。
 * 2026-11-19-002：新增事件驱动热更通道——设置页保存 / 其他标签页切换开关后，
 * 经 runtime_flags_changed 事件整体替换快照（applyRuntimeFlagsSnapshot），
 * 组件经 useRuntimeFlagsVersion 订阅版本号触发重渲染。
 */

import { useEffect, useState } from "react";

let snapshot = {};

let flagsReadyResolve;
/** 快照就绪信号：initRuntimeFlags 完成（成功或失败）后 resolve，供 mount 期依赖开关的逻辑重试。 */
export const flagsReady = new Promise((resolve) => { flagsReadyResolve = resolve; });

let version = 0;
const versionListeners = new Set();

export async function initRuntimeFlags() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" }).then((x) => x.json());
    if (r && typeof r === "object" && r.runtimeFlags && typeof r.runtimeFlags === "object") {
      snapshot = r.runtimeFlags;
    }
  } catch {
    // 拉取失败保持全关 = 基线行为，无需降级逻辑
  } finally {
    try { flagsReadyResolve?.(); } catch {}
  }
}

/** 只读访问；未知开关名一律视为关闭。 */
export function flag(name) {
  return snapshot[name] === true;
}

/**
 * 只读数值开关（如心跳间隔）：快照缺失或值非法时返回 fallback。
 * 与 flag() 共用同一份快照，避免各模块各自解析环境变量造成语义分叉。
 */
export function numberFlag(name, fallback = 0) {
  const value = Number(snapshot[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 全量快照只读访问（设置页分区用它同步本地草稿）。 */
export function allFlags() {
  return snapshot;
}

/**
 * 事件驱动的快照整体替换：runtime_flags_changed 事件携带服务端 reload 后的
 * 全量生效快照（非 POST 子集），整体替换防止其余键被清为关。version 单调递增。
 */
export function applyRuntimeFlagsSnapshot(next) {
  if (!next || typeof next !== "object" || Array.isArray(next)) return;
  snapshot = next;
  version += 1;
  for (const cb of versionListeners) {
    try { cb(version); } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/** 订阅快照版本号；返回退订函数。 */
export function subscribeRuntimeFlags(cb) {
  versionListeners.add(cb);
  return () => versionListeners.delete(cb);
}

/** React hook：订阅版本号，热更后触发组件重渲染（flag() 内联读取自然生效）。 */
export function useRuntimeFlagsVersion() {
  const [value, setValue] = useState(version);
  useEffect(() => subscribeRuntimeFlags((next) => setValue(next)), []);
  return value;
}
