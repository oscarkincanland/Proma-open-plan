import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * ChartRenderer：图表工作台的 ECharts 渲染封装（方案 2026-11-19-001 §4.3）。
 *
 * 约束：
 * - 只动态 `import("echarts/core")` 按需注册（Bar/Line/Pie/Scatter/Sankey + 常用组件），
 *   不整包引入 echarts，保证不进主包、perf-budget 不受影响；
 * - 双主题 oaw-chart-light / oaw-chart-dark：颜色全部取自 styles.css 设计令牌
 *   （getComputedStyle），随 [data-theme] / [data-skin] 切换自动重建；
 * - 渲染形态契约（方案 §4.1）：chart.data.kind==="dataset" 时，把数据表行合并进
 *   option.dataset.source 后再 setOption——调用方负责把数据表行传入 `datasetRows`。
 * - 组件只负责渲染与 resize；不做写操作。
 */

// 模块级单例：echarts 按需注册只做一次（动态 import 的 chunk 全局共享）。
let echartsPromise = null;
function loadEcharts() {
  if (!echartsPromise) {
    echartsPromise = import("echarts/core").then(async (echarts) => {
      const { BarChart, LineChart, PieChart, ScatterChart, SankeyChart } = await import("echarts/charts");
      const {
        GridComponent, TooltipComponent, LegendComponent, TitleComponent,
        DataZoomComponent, DatasetComponent, TransformComponent,
      } = await import("echarts/components");
      const { LabelLayout, UniversalTransition } = await import("echarts/features");
      const { CanvasRenderer } = await import("echarts/renderers");
      echarts.use([
        BarChart, LineChart, PieChart, ScatterChart, SankeyChart,
        GridComponent, TooltipComponent, LegendComponent, TitleComponent,
        DataZoomComponent, DatasetComponent, TransformComponent,
        LabelLayout, UniversalTransition,
        CanvasRenderer,
      ]);
      return echarts;
    });
  }
  return echartsPromise;
}

/** 从设计令牌构建 ECharts 主题（暗/亮由 [data-theme] 当前令牌值决定；色板属数据可视化白名单）。 */
function buildThemeFromTokens() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name) => (styles.getPropertyValue(name) || "").trim();
  const text = token("--text");
  const muted = token("--muted");
  const surface = token("--surface");
  const border = token("--border");
  const accent = token("--accent");
  return {
    backgroundColor: "transparent",
    textStyle: { color: text },
    title: { textStyle: { color: text } },
    legend: { textStyle: { color: muted } },
    tooltip: {
      backgroundColor: surface, borderColor: border, textStyle: { color: text },
      extraCssText: "border-radius:8px;",
    },
    categoryAxis: { axisLine: { lineStyle: { color: border } }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: border } } },
    valueAxis: { axisLine: { lineStyle: { color: border } }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: border } } },
    color: [accent, "#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d"],
  };
}

const THEME_LIGHT = "oaw-chart-light";
const THEME_DARK = "oaw-chart-dark";
let themesRegistered = false;
function registerThemes(echarts) {
  if (themesRegistered) return;
  echarts.registerTheme(THEME_DARK, buildThemeFromTokens());
  echarts.registerTheme(THEME_LIGHT, buildThemeFromTokens());
  themesRegistered = true;
}

function currentThemeName() {
  return document.documentElement.getAttribute("data-theme") === "light" ? THEME_LIGHT : THEME_DARK;
}

/**
 * 合并数据形态（方案 §4.1 渲染契约）：
 * - kind=inline：直接使用 inline（数组或 {dimensions,source} 对象）作为 option.dataset.source；
 * - kind=dataset：用调用方传入的 datasetRows（[["k","v"],...]）合并进 option.dataset.source；
 * - option 无 dataset 结构时补一个最小 dataset（dimensions 从数据首行推断）。
 */
function mergeDatasetOption(option, data, datasetRows) {
  const next = { ...option, series: Array.isArray(option.series) ? option.series.map((s) => ({ ...s })) : [] };
  let source = null;
  let dimensions = null;
  if (data?.kind === "dataset") {
    // datasetRows 兼容两种形态：行数组 [[...]] 或服务端/工作台投影 { dimensions, source }
    if (Array.isArray(datasetRows)) source = datasetRows;
    else if (datasetRows && Array.isArray(datasetRows.source)) {
      source = datasetRows.source;
      dimensions = Array.isArray(datasetRows.dimensions) ? datasetRows.dimensions : null;
    }
  } else if (data?.kind === "inline") {
    source = data.inline;
    dimensions = Array.isArray(source) && Array.isArray(source[0])
      ? source[0].map((name, i) => (typeof name === "string" ? name : `字段${i + 1}`))
      : null;
  }
  if (!source) return next;
  next.dataset = { ...(next.dataset || {}), ...(dimensions ? { dimensions } : {}), source };
  return next;
}

export default function ChartRenderer({
  option,
  data,
  datasetRows,
  height = 360,
  style,
  onReady,
  className,
  injectableDebounceMs = 0,
}) {
  const hostRef = useRef(null);
  const chartRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [themeName, setThemeName] = useState(() => (typeof document === "undefined" ? THEME_DARK : currentThemeName()));

  // 主题/皮肤切换监听：重建主题定义并热切换（不整图重初始化）。
  useEffect(() => {
    if (typeof document === "undefined" || !window.MutationObserver) return undefined;
    const observer = new MutationObserver(() => {
      const next = currentThemeName();
      setThemeName((prev) => {
        if (prev === next) return prev;
        return next;
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    loadEcharts().then((echarts) => {
      if (disposed || !hostRef.current) return;
      registerThemes(echarts);
      if (!chartRef.current) {
        chartRef.current = echarts.init(hostRef.current, currentThemeName(), { renderer: "canvas" });
        setReady(true);
        if (onReady) onReady(chartRef.current);
      } else {
        // 主题变化：重新注册主题后热切换
        echarts.registerTheme(THEME_DARK, buildThemeFromTokens());
        echarts.registerTheme(THEME_LIGHT, buildThemeFromTokens());
      }
      const merged = mergeDatasetOption(option || {}, data, datasetRows);
      chartRef.current.setOption(merged, true);
    }).catch(() => {});
    return () => { disposed = true; };
    // 主题名变化也要触发 setOption（registerTheme 后 echarts 需重新套用主题）
  }, [option, data, datasetRows, themeName, onReady]);

  // 容器尺寸自适应
  useEffect(() => {
    if (!ready || !hostRef.current || typeof window === "undefined" || !window.ResizeObserver) return undefined;
    const observer = new ResizeObserver(() => {
      if (chartRef.current) chartRef.current.resize();
    });
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => () => {
    if (chartRef.current) {
      chartRef.current.dispose();
      chartRef.current = null;
      setReady(false);
    }
  }, []);

  const mergedStyle = useMemo(() => ({ width: "100%", height: typeof height === "number" ? `${height}px` : height, ...(style || {}) }), [height, style]);
  void injectableDebounceMs; // 去抖由上层（工作台事件扇出）处理；占位保留可注入口径

  return (
    <div
      ref={hostRef}
      className={className}
      style={mergedStyle}
      data-chart-theme={themeName}
      role="img"
      aria-label={typeof option?.title?.text === "string" ? option.title.text : "图表"}
    />
  );
}
