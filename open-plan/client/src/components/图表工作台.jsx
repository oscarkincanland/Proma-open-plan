import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import ChartRenderer from "./ChartRenderer.jsx";
import { notifySuccess, notifyError, askConfirm } from "./Feedback.jsx";
import {
  createChartWorkbench, getChartWorkbenchSummary, getChart, saveChart, patchChart, deleteChart, exportChartSvg,
  getDataset, saveDataset, deleteDataset,
  getChartBoard, saveChartBoard, deleteChartBoard, exportBoardHtml,
} from "../api.js";

/**
 * 图表工作台（方案 docs/plans/2026-11-19-001 §4.3，ADR 0041）。
 *
 * 三层结构（对齐创作画布的浏览器式标签模型）：
 *   左侧：图表清单 + 数据表清单（可切换分区）
 *   中间：ChartRenderer 渲染区 / 数据表编辑网格
 *   右侧：option JSON 与数据绑定面板 / 字段定义面板
 *
 * 联动刷新（1b-2）：App 全局流 chart_changed → refreshToken 递增；本组件按需重拉。
 * dirty 冲突保护：本地未保存修改遇到远端变更 → 提示条（刷新读取 / 覆盖保存），不静默覆盖。
 * 展板分区（阶段 2 交付）：本版不渲染展板编辑，仅保留清单展示。
 */

const OPTION_PLACEHOLDER = `{
  "xAxis": { "type": "category" },
  "yAxis": {},
  "series": [{ "type": "bar" }]
}`;
const INLINE_PLACEHOLDER = `[
  ["城市", "客流"],
  ["杭州", 1200],
  ["义乌", 800]
]`;
const FIELD_TYPES = ["string", "number", "date"];
const GRID_PREVIEW_ROWS = 100;
// 侧栏收起状态记忆（2026-11-19-011）：单键存 map，按 工作区:slug 分位；默认收起。
const SIDE_PREF_KEY = "oaw_chart_side_v1";
function readSidePrefs() {
  try { return JSON.parse(localStorage.getItem(SIDE_PREF_KEY) || "{}") || {}; } catch { return {}; }
}
function readSideCollapsed(workspace, slug) {
  try { return readSidePrefs()[`${workspace}:${slug || "new"}`] !== false; } catch { return true; }
}
function writeSideCollapsed(workspace, slug, collapsed) {
  try {
    const prefs = readSidePrefs();
    prefs[`${workspace}:${slug || "new"}`] = collapsed;
    localStorage.setItem(SIDE_PREF_KEY, JSON.stringify(prefs));
  } catch {}
}

function parseJsonSafe(text, fallback = null) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e?.message || "JSON 解析失败", value: fallback };
  }
}

export default function 图表工作台({
  slug = "",
  workspace = "",
  refreshToken = 0,
  onDirtyChange,
  onTitleChange,
  onCreated,
  onAddToChat,
  onClose,
}) {
  const [summary, setSummary] = useState(null); // { charts, datasets, boards }
  const [section, setSection] = useState("chart"); // chart | data | board
  const [sideCollapsed, setSideCollapsed] = useState(() => readSideCollapsed(workspace, slug)); // 默认隐藏（2026-11-19-011）
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 展板编辑（阶段 2）
  const [activeBoardId, setActiveBoardId] = useState("");
  const [boardTitle, setBoardTitle] = useState("");
  const [boardLayout, setBoardLayout] = useState([]); // [{chartId,x,y,w,h,chart?,missing?}]
  const [boardSnapshot, setBoardSnapshot] = useState("");

  // 新建占位（slug 为空）
  const [newTitle, setNewTitle] = useState("");

  // 图表编辑
  const [activeChartId, setActiveChartId] = useState("");
  const [chartTitle, setChartTitle] = useState("");
  const [optionText, setOptionText] = useState("");
  const [dataKind, setDataKind] = useState("inline");
  const [inlineText, setInlineText] = useState(INLINE_PLACEHOLDER);
  const [datasetId, setDatasetId] = useState("");
  const [chartNote, setChartNote] = useState("");
  const [chartSnapshot, setChartSnapshot] = useState(""); // 原始 JSON 快照（dirty 判定）

  // 数据表编辑（1b-1）
  const [activeDatasetId, setActiveDatasetId] = useState("");
  const [datasetTitle, setDatasetTitle] = useState("");
  const [datasetFields, setDatasetFields] = useState([]); // [{name,type}]
  const [datasetRows, setDatasetRows] = useState([]); // [[...]]
  const [datasetSnapshot, setDatasetSnapshot] = useState("");

  // 1b-2：远端变更 vs 本地 dirty
  const [remoteNotice, setRemoteNotice] = useState(""); // "" | "chart" | "dataset"
  const [reloadTick, setReloadTick] = useState(0); // 静默刷新触发器（ refreshToken 变化时 +1）
  const [boundDatasetRows, setBoundDatasetRows] = useState(null); // 绑定数据表的行（渲染用）
  const dirtyRef = useRef(false);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  // 侧栏收起/展开（记忆到 localStorage；工作区/slug 切换时重读）
  useEffect(() => {
    setSideCollapsed(readSideCollapsed(workspace, slug));
  }, [workspace, slug]);
  const toggleSide = useCallback(() => {
    setSideCollapsed((prev) => {
      writeSideCollapsed(workspace, slugRef.current, !prev);
      return !prev;
    });
  }, [workspace]);

  const loadSummary = useCallback(async () => {
    if (!slugRef.current) return;
    try {
      const r = await getChartWorkbenchSummary(workspace, slugRef.current);
      setSummary({ charts: r.charts || [], datasets: r.datasets || [], boards: r.boards || [] });
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [workspace]);

  // 首次进入：拉清单并选第一张图
  useEffect(() => {
    let alive = true;
    setError("");
    if (!slug) {
      setSummary(null);
      return undefined;
    }
    (async () => {
      try {
        const r = await getChartWorkbenchSummary(workspace, slug);
        if (!alive) return;
        setSummary({ charts: r.charts || [], datasets: r.datasets || [], boards: r.boards || [] });
        const first = (r.charts || [])[0];
        if (first && !activeChartId) setActiveChartId(first.id);
        const firstDs = (r.datasets || [])[0];
        if (firstDs && !activeDatasetId) setActiveDatasetId(firstDs.id);
        const firstBoard = (r.boards || [])[0];
        if (firstBoard && !activeBoardId) setActiveBoardId(firstBoard.id);
      } catch (e) {
        if (alive) setError(String(e?.message || e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, workspace]);

  // 载入选中图表
  useEffect(() => {
    let alive = true;
    if (!slug || !activeChartId) return undefined;
    (async () => {
      try {
        const r = await getChart(workspace, slug, activeChartId);
        if (!alive) return;
        const chart = r.chart || {};
        setChartTitle(chart.title || "");
        setOptionText(JSON.stringify(chart.option || {}, null, 2));
        setDataKind(chart.data?.kind === "dataset" ? "dataset" : "inline");
        setDatasetId(chart.data?.datasetId || "");
        setInlineText(chart.data?.inline !== undefined ? JSON.stringify(chart.data.inline, null, 2) : INLINE_PLACEHOLDER);
        setChartNote(chart.note || "");
        const snapshot = JSON.stringify({
          title: chart.title || "", option: chart.option || {}, data: chart.data || {}, note: chart.note || "",
        });
        setChartSnapshot(snapshot);
        setRemoteNotice("");
      } catch (e) {
        if (alive) setError(String(e?.message || e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, workspace, activeChartId, reloadTick]);

  // 绑定数据表的图表：拉取行数据供渲染合并（与 SSR 导出同一契约）
  useEffect(() => {
    let alive = true;
    if (!slug || dataKind !== "dataset" || !datasetId) {
      setBoundDatasetRows(null);
      return undefined;
    }
    (async () => {
      try {
        const r = await getDataset(workspace, slug, datasetId);
        if (!alive) return;
        const d = r.dataset || {};
        setBoundDatasetRows({ dimensions: (d.fields || []).map((f) => f.name), source: d.rows || [] });
      } catch {
        if (alive) setBoundDatasetRows(null); // 数据表缺失：渲染为空图，不阻塞
      }
    })();
    return () => { alive = false; };
  }, [slug, workspace, dataKind, datasetId, reloadTick]);

  // 载入选中数据表（1b-1）
  useEffect(() => {
    let alive = true;
    if (!slug || section !== "data" || !activeDatasetId) return undefined;
    (async () => {
      try {
        const r = await getDataset(workspace, slug, activeDatasetId);
        if (!alive) return;
        const d = r.dataset || {};
        setDatasetTitle(d.title || "");
        setDatasetFields((d.fields || []).map((f) => ({ name: String(f.name || ""), type: String(f.type || "string") })));
        setDatasetRows((d.rows || []).map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? "" : cell)) : [])));
        setDatasetSnapshot(JSON.stringify({ title: d.title || "", fields: d.fields || [], rows: d.rows || [] }));
        setRemoteNotice("");
      } catch (e) {
        if (alive) setError(String(e?.message || e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, workspace, section, activeDatasetId, reloadTick]);

  // 载入选中展板（阶段 2）：boardView 投影含每格 chart 与 missing 标记
  useEffect(() => {
    let alive = true;
    if (!slug || section !== "board" || !activeBoardId) return undefined;
    (async () => {
      try {
        const r = await getChartBoard(workspace, slug, activeBoardId);
        if (!alive) return;
        const b = r.board || {};
        setBoardTitle(b.title || "");
        setBoardLayout((b.layout || []).map((cell) => ({ ...cell })));
        setBoardSnapshot(JSON.stringify({ title: b.title || "", layout: b.layout || [] }));
        setRemoteNotice("");
      } catch (e) {
        if (alive) setError(String(e?.message || e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, workspace, section, activeBoardId, reloadTick]);

  // dirty 判定（图表 + 数据表共用一个 dirtyRef）
  const computeDirty = useCallback(() => {
    if (section === "chart" && activeChartId) {
      const current = JSON.stringify({
        title: chartTitle, option: parseJsonSafe(optionText).value ?? {}, data: buildData(), note: chartNote,
      });
      return current !== chartSnapshot;
    }
    if (section === "data" && activeDatasetId) {
      const current = JSON.stringify({ title: datasetTitle, fields: datasetFields, rows: datasetRows });
      return current !== datasetSnapshot;
    }
    if (section === "board" && activeBoardId) {
      const current = JSON.stringify({ title: boardTitle, layout: boardLayout.map(({ chart, missing, ...rest }) => rest) });
      return current !== boardSnapshot;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, activeChartId, chartTitle, optionText, dataKind, inlineText, datasetId, chartNote, chartSnapshot, activeDatasetId, datasetTitle, datasetFields, datasetRows, datasetSnapshot, activeBoardId, boardTitle, boardLayout, boardSnapshot]);

  useEffect(() => {
    const dirty = Boolean(computeDirty());
    if (dirtyRef.current !== dirty) {
      dirtyRef.current = dirty;
      onDirtyChange?.(dirty);
    }
  }, [computeDirty, onDirtyChange]);

  const buildData = useCallback(() => {
    if (dataKind === "dataset") return { kind: "dataset", datasetId };
    const parsed = parseJsonSafe(inlineText);
    return { kind: "inline", inline: parsed.ok ? parsed.value : inlineText };
  }, [dataKind, datasetId, inlineText]);

  // 联动刷新（1b-2）：refreshToken 变化 = 远端有变更（agent 或其他标签写盘）
  useEffect(() => {
    if (!refreshToken || !slug) return;
    if (dirtyRef.current) {
      setRemoteNotice(section === "data" ? "dataset" : section === "board" ? "board" : "chart");
      return;
    }
    // 无本地修改：静默重拉当前视图
    setReloadTick((tick) => tick + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleCreateWorkbench = useCallback(async () => {
    if (!newTitle.trim()) { notifyError("请填写工作台标题"); return; }
    setBusy(true);
    try {
      const r = await createChartWorkbench(workspace, { title: newTitle.trim() });
      notifySuccess(`工作台「${r.title || r.slug}」已创建`);
      onCreated?.(r.slug, r.title || r.slug);
    } catch (e) {
      notifyError(`创建失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [newTitle, workspace, onCreated]);

  const handleSaveChart = useCallback(async ({ force = false } = {}) => {
    if (!slug || !activeChartId) return;
    const optionParsed = parseJsonSafe(optionText);
    if (!optionParsed.ok) { notifyError(`option JSON 不合法：${optionParsed.error}`); return; }
    let dataPayload;
    if (dataKind === "dataset") {
      dataPayload = { kind: "dataset", datasetId: datasetId.trim() };
      if (!datasetId.trim()) { notifyError("请选择要绑定的数据表"); return; }
    } else {
      const inlineParsed = parseJsonSafe(inlineText);
      if (!inlineParsed.ok) { notifyError(`内联数据 JSON 不合法：${inlineParsed.error}`); return; }
      dataPayload = { kind: "inline", inline: inlineParsed.value };
    }
    setBusy(true);
    try {
      if (force) setRemoteNotice("");
      const r = await patchChart(workspace, slug, activeChartId, {
        title: chartTitle.trim() || activeChartId, option: optionParsed.value, data: dataPayload, note: chartNote,
      });
      notifySuccess(`图表已保存（rev ${r.revision ?? ""}）`);
      setChartSnapshot(JSON.stringify({
        title: chartTitle.trim() || activeChartId, option: optionParsed.value, data: dataPayload, note: chartNote,
      }));
      onTitleChange?.(`${chartTitle.trim() || activeChartId}`);
      await loadSummary();
    } catch (e) {
      notifyError(`保存失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, activeChartId, optionText, dataKind, datasetId, inlineText, chartTitle, chartNote, chartSnapshot, workspace, loadSummary, onTitleChange]);

  const handleCreateChart = useCallback(async () => {
    if (!slug) return;
    setBusy(true);
    try {
      const parsed = parseJsonSafe(OPTION_PLACEHOLDER);
      const r = await saveChart(workspace, slug, {
        title: `图表 ${(summary?.charts?.length || 0) + 1}`,
        option: parsed.value,
        data: { kind: "inline", inline: [] },
      });
      notifySuccess(`图表 ${r.chart.id} 已创建`);
      setActiveChartId(r.chart.id);
      await loadSummary();
    } catch (e) {
      notifyError(`创建失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, workspace, summary, loadSummary]);

  const handleDeleteChart = useCallback(async () => {
    if (!slug || !activeChartId) return;
    if (!(await askConfirm(`确认删除图表「${chartTitle || activeChartId}」？（移入 .trash，可恢复）`))) return;
    setBusy(true);
    try {
      await deleteChart(workspace, slug, activeChartId, { confirmed: true });
      notifySuccess("图表已删除");
      setActiveChartId("");
      await loadSummary();
    } catch (e) {
      notifyError(`删除失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, activeChartId, chartTitle, workspace, loadSummary]);

  const handleExportSvg = useCallback(async () => {
    if (!slug || !activeChartId) return;
    setBusy(true);
    try {
      const r = await exportChartSvg(workspace, slug, activeChartId, { format: "svg" });
      notifySuccess(`已导出：${(r.files || []).map((f) => f.path).join(", ")}`);
    } catch (e) {
      notifyError(`导出失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, activeChartId, workspace]);

  const handleAddToChat = useCallback(() => {
    if (!slug || !activeChartId) return;
    onAddToChat?.(`@图表[charts/${slug}/project/${activeChartId}.json]`);
  }, [slug, activeChartId, onAddToChat]);

  // ---- 数据表编辑（1b-1） ----
  const handleSaveDataset = useCallback(async ({ force = false } = {}) => {
    if (!slug || !activeDatasetId) return;
    if (!datasetTitle.trim()) { notifyError("请填写数据表标题"); return; }
    if (!datasetFields.length) { notifyError("至少需要一个字段"); return; }
    setBusy(true);
    try {
      if (force) setRemoteNotice("");
      const r = await saveDataset(workspace, slug, {
        id: activeDatasetId, title: datasetTitle.trim(), fields: datasetFields, rows: datasetRows,
      });
      notifySuccess(`数据表已保存（${r.dataset.rows.length} 行，rev ${r.revision ?? ""}）`);
      setDatasetSnapshot(JSON.stringify({ title: datasetTitle.trim(), fields: datasetFields, rows: datasetRows }));
      onTitleChange?.(datasetTitle.trim());
      await loadSummary();
    } catch (e) {
      notifyError(`保存失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, activeDatasetId, datasetTitle, datasetFields, datasetRows, datasetSnapshot, workspace, loadSummary, onTitleChange]);

  const handleCreateDataset = useCallback(async () => {
    if (!slug) return;
    setBusy(true);
    try {
      const r = await saveDataset(workspace, slug, {
        title: `数据表 ${(summary?.datasets?.length || 0) + 1}`,
        fields: [{ name: "名称", type: "string" }, { name: "数值", type: "number" }],
        rows: [["示例", 0]],
        note: "",
      });
      notifySuccess(`数据表 ${r.dataset.id} 已创建`);
      setActiveDatasetId(r.dataset.id);
      await loadSummary();
    } catch (e) {
      notifyError(`创建失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, workspace, summary, loadSummary]);

  const handleDeleteDataset = useCallback(async () => {
    if (!slug || !activeDatasetId) return;
    if (!(await askConfirm("确认删除该数据表？绑定它的图表将标记 missing（数据表移入 .trash）。"))) return;
    setBusy(true);
    try {
      await deleteDataset(workspace, slug, activeDatasetId, { confirmed: true });
      notifySuccess("数据表已删除");
      setActiveDatasetId("");
      await loadSummary();
    } catch (e) {
      notifyError(`删除失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, activeDatasetId, workspace, loadSummary]);

  const gridFields = datasetFields;
  const gridRows = useMemo(() => datasetRows.slice(0, GRID_PREVIEW_ROWS), [datasetRows]);

  // ---- 展板编辑（阶段 2） ----
  const nextBoardCellPos = useCallback((layout) => {
    // 列优先摆放：找最低空位（简单 2 列网格）
    const cellW = 640;
    const cellH = 420;
    const col = layout.length % 2;
    const row = Math.floor(layout.length / 2);
    return { x: col * (cellW + 24) + 24, y: row * (cellH + 24) + 24, w: cellW, h: cellH };
  }, []);

  const handleCreateBoard = useCallback(async () => {
    if (!slug) return;
    setBusy(true);
    try {
      const layout = (summary?.charts || []).slice(0, 24).map((chart, index) => ({
        chartId: chart.id,
        ...(() => {
          const col = index % 2;
          const row = Math.floor(index / 2);
          return { x: col * 664 + 24, y: row * 444 + 24, w: 640, h: 420 };
        })(),
      }));
      const r = await saveChartBoard(workspace, slug, {
        title: `展板 ${(summary?.boards?.length || 0) + 1}`,
        layout,
      });
      notifySuccess(`展板 ${r.board.id} 已创建（${layout.length} 格）`);
      setActiveBoardId(r.board.id);
      await loadSummary();
    } catch (e) {
      notifyError(`创建失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, workspace, summary, loadSummary]);

  const handleSaveBoard = useCallback(async ({ force = false } = {}) => {
    if (!slug || !activeBoardId) return;
    if (!boardTitle.trim()) { notifyError("请填写展板标题"); return; }
    if (boardLayout.length > 24) { notifyError("展板图表数超限（≤24）"); return; }
    setBusy(true);
    try {
      if (force) setRemoteNotice("");
      const r = await saveChartBoard(workspace, slug, {
        id: activeBoardId, title: boardTitle.trim(),
        layout: boardLayout.map(({ chartId, x, y, w, h }) => ({ chartId, x: Number(x), y: Number(y), w: Number(w), h: Number(h) })),
      });
      notifySuccess(`展板已保存（${r.board.layout.length} 格，rev ${r.revision ?? ""}）`);
      setBoardSnapshot(JSON.stringify({ title: boardTitle.trim(), layout: r.board.layout }));
      onTitleChange?.(boardTitle.trim());
      await loadSummary();
    } catch (e) {
      notifyError(`保存失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, activeBoardId, boardTitle, boardLayout, boardSnapshot, workspace, loadSummary, onTitleChange]);

  const handleDeleteBoard = useCallback(async () => {
    if (!slug || !activeBoardId) return;
    if (!(await askConfirm(`确认删除展板「${boardTitle || activeBoardId}」？（移入 .trash）`))) return;
    setBusy(true);
    try {
      await deleteChartBoard(workspace, slug, activeBoardId, { confirmed: true });
      notifySuccess("展板已删除");
      setActiveBoardId("");
      await loadSummary();
    } catch (e) {
      notifyError(`删除失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, activeBoardId, boardTitle, workspace, loadSummary]);

  const handleExportBoard = useCallback(async () => {
    if (!slug || !activeBoardId) return;
    setBusy(true);
    try {
      const r = await exportBoardHtml(workspace, slug, activeBoardId, { format: "html" });
      notifySuccess(`已导出：${(r.files || []).map((f) => f.path).join(", ")}`);
    } catch (e) {
      notifyError(`导出失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [slug, activeBoardId, workspace]);

  const handleAddBoardCell = useCallback(() => {
    const available = (summary?.charts || []).filter((c) => !boardLayout.some((cell) => cell.chartId === c.id));
    const chart = available[0];
    if (!chart) { notifyError("没有可加入的图表（全部已加入或工作台还没有图表）"); return; }
    setBoardLayout((prev) => [...prev, { chartId: chart.id, ...nextBoardCellPos(prev) }]);
  }, [summary, boardLayout, nextBoardCellPos]);

  const handleRemoveBoardCell = useCallback((index) => {
    setBoardLayout((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleCellCoord = useCallback((index, key, value) => {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return;
    setBoardLayout((prev) => prev.map((cell, i) => (i === index ? { ...cell, [key]: num } : cell)));
  }, []);

  // ---- 渲染 ----
  if (!slug) {
    return (
      <div className="chart-workbench chart-workbench-empty">
        <div className="chart-empty-card">
          <Icon name="chart" size={28} />
          <h2>新建图表工作台</h2>
          <p>数据表 + ECharts 交互图表 + 展板；agent 可在会话中直接建图与调优。</p>
          <div className="chart-empty-form">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="工作台标题，如：客流分析"
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateWorkbench(); }}
            />
            <button type="button" className="btn-xs chart-btn" disabled={busy} onClick={handleCreateWorkbench}>创建</button>
          </div>
          {error ? <div className="chart-error">{error}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`chart-workbench ${sideCollapsed ? "chart-side-collapsed" : ""}`}>
      <aside className="chart-side" aria-label="图表与数据表清单">
        <div className="chart-side-head">
          <button type="button" className={`chart-side-tab ${section === "chart" ? "active" : ""}`} onClick={() => setSection("chart")}>
            <Icon name="chart" size={13} /> 图表（{summary?.charts?.length ?? 0}）
          </button>
          <button type="button" className={`chart-side-tab ${section === "data" ? "active" : ""}`} onClick={() => setSection("data")}>
            <Icon name="layers" size={13} /> 数据表（{summary?.datasets?.length ?? 0}）
          </button>
          <button type="button" className={`chart-side-tab ${section === "board" ? "active" : ""}`} onClick={() => setSection("board")}>
            <Icon name="grid" size={13} /> 展板（{summary?.boards?.length ?? 0}）
          </button>
          <button type="button" className="btn-xs chart-side-collapse" title="收起侧栏" aria-label="收起侧栏" onClick={toggleSide}>
            <Icon name="chevronLeft" size={13} />
          </button>
        </div>
        <div className="chart-side-list">
          {section === "chart" && (summary?.charts || []).map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chart-list-item ${c.id === activeChartId ? "active" : ""}`}
              onClick={() => setActiveChartId(c.id)}
              title={c.title}
            >
              <Icon name="chart" size={12} />
              <span className="chart-list-title">{c.title || c.id}</span>
            </button>
          ))}
          {section === "data" && (summary?.datasets || []).map((d) => (
            <button
              key={d.id}
              type="button"
              className={`chart-list-item ${d.id === activeDatasetId ? "active" : ""}`}
              onClick={() => setActiveDatasetId(d.id)}
              title={d.title}
            >
              <Icon name="layers" size={12} />
              <span className="chart-list-title">{d.title || d.id}</span>
            </button>
          ))}
          {section === "board" && (summary?.boards || []).map((b) => (
            <button
              key={b.id}
              type="button"
              className={`chart-list-item ${b.id === activeBoardId ? "active" : ""}`}
              onClick={() => setActiveBoardId(b.id)}
              title={b.title}
            >
              <Icon name="grid" size={12} />
              <span className="chart-list-title">{b.title || b.id}</span>
            </button>
          ))}
          {({
            chart: summary?.charts,
            data: summary?.datasets,
            board: summary?.boards,
          })[section]?.length ? null : (
            <div className="chart-side-empty">（空）</div>
          )}
        </div>
        {section === "chart" ? (
          <div className="chart-side-editor">
            {activeChartId ? (
              <>
                <div className="chart-field">
                  <label>数据来源</label>
                  <div className="chart-seg">
                    <button type="button" className={dataKind === "inline" ? "active" : ""} onClick={() => setDataKind("inline")}>内联数据</button>
                    <button type="button" className={dataKind === "dataset" ? "active" : ""} onClick={() => setDataKind("dataset")}>绑定数据表</button>
                  </div>
                </div>
                {dataKind === "inline" ? (
                  <div className="chart-field">
                    <label>内联数据 JSON（dataset.source 兼容形态）</label>
                    <textarea value={inlineText} onChange={(e) => setInlineText(e.target.value)} rows={6} spellCheck={false} />
                  </div>
                ) : (
                  <div className="chart-field">
                    <label>绑定数据表（series 不得直连 data / 自带 dataset）</label>
                    <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                      <option value="">（选择数据表）</option>
                      {(summary?.datasets || []).map((d) => (
                        <option key={d.id} value={d.id}>{d.title || d.id}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="chart-field">
                  <label>option JSON（ECharts）</label>
                  <textarea value={optionText} onChange={(e) => setOptionText(e.target.value)} rows={12} spellCheck={false} />
                </div>
                <div className="chart-field">
                  <label>备注（演示数据必须标注「演示数据」）</label>
                  <input value={chartNote} onChange={(e) => setChartNote(e.target.value)} placeholder="备注" />
                </div>
              </>
            ) : (
              <div className="chart-side-editor-hint">选中图表后在此编辑 option 与数据绑定</div>
            )}
          </div>
        ) : (
          <div className="chart-side-editor chart-side-editor-hint">
            {section === "data" ? "数据表在中间网格编辑" : "展板在中间画布编辑"}
          </div>
        )}
        <div className="chart-side-foot">
          {section === "chart" ? (
            <button type="button" className="btn-xs chart-btn" disabled={busy} onClick={handleCreateChart}>新建图表</button>
          ) : section === "data" ? (
            <button type="button" className="btn-xs chart-btn" disabled={busy} onClick={handleCreateDataset}>新建数据表</button>
          ) : (
            <button type="button" className="btn-xs chart-btn" disabled={busy} onClick={handleCreateBoard}>新建展板</button>
          )}
          <button type="button" className="btn-xs" onClick={onClose}>关闭</button>
        </div>
      </aside>

      <div className="chart-main">
        {sideCollapsed ? (
          <div className="chart-side-toggle" role="toolbar" aria-label="侧栏控制">
            <button type="button" className="btn-xs" title="展开侧栏" aria-label="展开侧栏" onClick={toggleSide}>
              <Icon name="chevronRight" size={13} />
            </button>
            <button
              type="button"
              className="btn-xs chart-btn"
              title={section === "chart" ? "新建图表" : section === "data" ? "新建数据表" : "新建展板"}
              aria-label="新建"
              disabled={busy}
              onClick={section === "chart" ? handleCreateChart : section === "data" ? handleCreateDataset : handleCreateBoard}
            >
              <Icon name="plus" size={13} />
            </button>
          </div>
        ) : null}
        {remoteNotice ? (
          <div className="chart-remote-banner" role="alert">
            <span>远端已有新变更（agent 或其他标签页）。本地有未保存修改。</span>
            <button type="button" className="btn-xs" onClick={() => setRemoteNotice("")}>忽略</button>
            <button
              type="button"
              className="btn-xs"
              onClick={() => {
                if (remoteNotice === "chart") setActiveChartId((id) => id);
                else setActiveDatasetId((id) => id);
                setRemoteNotice("");
              }}
            >
              刷新读取（放弃本地）
            </button>
            <button
              type="button"
              className="btn-xs chart-btn"
              onClick={() => (remoteNotice === "chart" ? handleSaveChart({ force: true }) : handleSaveDataset({ force: true }))}
            >
              覆盖保存
            </button>
          </div>
        ) : null}

        {section === "chart" ? (
          activeChartId ? (
            <div className="chart-editor">
              <div className="chart-canvas-area">
                <div className="chart-canvas-head">
                  <input
                    className="chart-title-input"
                    value={chartTitle}
                    onChange={(e) => setChartTitle(e.target.value)}
                    placeholder="图表标题"
                  />
                  <button type="button" className="btn-xs chart-btn" disabled={busy} onClick={() => handleSaveChart()}>保存</button>
                  <button type="button" className="btn-xs" disabled={busy} onClick={handleExportSvg}>导出 SVG</button>
                  <button type="button" className="btn-xs" onClick={handleAddToChat} title="把图表引用加入对话，让 agent 继续调优">加入对话</button>
                  <button type="button" className="btn-xs chart-danger" disabled={busy} onClick={handleDeleteChart}>删除</button>
                </div>
                <ChartRenderer
                  option={parseJsonSafe(optionText).value ?? undefined}
                  data={buildData()}
                  datasetRows={dataKind === "dataset" ? boundDatasetRows : null}
                  height={420}
                />
              </div>
            </div>
          ) : (
            <div className="chart-placeholder">从左侧选择或新建一张图表</div>
          )
        ) : section === "board" ? (
          activeBoardId ? (
            <div className="chart-dataset chart-board">
              <div className="chart-canvas-head">
                <input
                  className="chart-title-input"
                  value={boardTitle}
                  onChange={(e) => setBoardTitle(e.target.value)}
                  placeholder="展板标题"
                />
                <button type="button" className="btn-xs" disabled={busy} onClick={handleAddBoardCell} title="把未加入的图表追加到展板">+图格</button>
                <button type="button" className="btn-xs chart-btn" disabled={busy} onClick={() => handleSaveBoard()}>保存</button>
                <button type="button" className="btn-xs" disabled={busy} onClick={handleExportBoard}>导出 HTML</button>
                <button type="button" className="btn-xs chart-danger" disabled={busy} onClick={handleDeleteBoard}>删除</button>
              </div>
              <div className="chart-board-canvas" style={{ minWidth: Math.max(...boardLayout.map((c) => Number(c.x) + Number(c.w)), 0) + 24, minHeight: Math.max(...boardLayout.map((c) => Number(c.y) + Number(c.h)), 0) + 24 }}>
                {boardLayout.map((cell, index) => (
                  <div key={`${cell.chartId}:${index}`} className={`chart-board-cell ${cell.missing ? "missing" : ""}`} style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h }}>
                    <div className="chart-board-cell-head">
                      <span className="chart-board-cell-title">{cell.missing ? `缺失：${cell.chartId}` : (cell.chart?.title || cell.chartId)}</span>
                      <button type="button" className="chart-grid-x" title="移除该格" onClick={() => handleRemoveBoardCell(index)}>×</button>
                    </div>
                    <div className="chart-board-cell-body">
                      {!cell.missing && cell.chart ? (
                        <ChartRenderer
                          option={cell.chart.option}
                          data={cell.chart.data}
                          datasetRows={cell.chart.data?.kind === "dataset" ? cell.datasetSource : null}
                          height="100%"
                        />
                      ) : null}
                    </div>
                    <div className="chart-board-cell-coords">
                      {["x", "y", "w", "h"].map((key) => (
                        <label key={key}>
                          {key}
                          <input
                            type="number"
                            min={0}
                            value={cell[key]}
                            onChange={(e) => handleCellCoord(index, key, e.target.value)}
                            aria-label={`第 ${index + 1} 格 ${key}`}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                {!boardLayout.length ? <div className="chart-placeholder">空展板：点「+图格」把图表摆进来</div> : null}
              </div>
            </div>
          ) : (
            <div className="chart-placeholder">从左侧选择或新建一块展板</div>
          )
        ) : activeDatasetId ? (
          <div className="chart-dataset">
            <div className="chart-canvas-head">
              <input
                className="chart-title-input"
                value={datasetTitle}
                onChange={(e) => setDatasetTitle(e.target.value)}
                placeholder="数据表标题"
              />
              <button type="button" className="btn-xs chart-btn" disabled={busy} onClick={() => handleSaveDataset()}>保存</button>
              <button type="button" className="btn-xs" disabled={busy} onClick={handleDeleteDataset}>删除</button>
            </div>
            {datasetRows.length > GRID_PREVIEW_ROWS ? (
              <div className="chart-grid-note">仅渲染前 {GRID_PREVIEW_ROWS} 行（共 {datasetRows.length} 行），保存时提交全部行。</div>
            ) : null}
            <div className="chart-grid-wrap">
              <table className="chart-grid">
                <thead>
                  <tr>
                    <th className="chart-grid-index">#</th>
                    {gridFields.map((field, col) => (
                      <th key={col}>
                        <input
                          value={field.name}
                          onChange={(e) => setDatasetFields((prev) => prev.map((f, i) => (i === col ? { ...f, name: e.target.value } : f)))}
                          aria-label={`第 ${col + 1} 列字段名`}
                        />
                        <select
                          value={field.type}
                          onChange={(e) => setDatasetFields((prev) => prev.map((f, i) => (i === col ? { ...f, type: e.target.value } : f)))}
                          aria-label={`第 ${col + 1} 列类型`}
                        >
                          {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <button
                          type="button"
                          className="chart-grid-x"
                          title="删除该列"
                          disabled={gridFields.length <= 1}
                          onClick={() => {
                            setDatasetFields((prev) => prev.filter((_, i) => i !== col));
                            setDatasetRows((prev) => prev.map((row) => row.filter((_, i) => i !== col)));
                          }}
                        >
                          ×
                        </button>
                      </th>
                    ))}
                    <th className="chart-grid-add">
                      <button
                        type="button"
                        className="btn-xs"
                        disabled={gridFields.length >= 64}
                        title="新增列（≤64）"
                        onClick={() => setDatasetFields((prev) => [...prev, { name: `字段${prev.length + 1}`, type: "string" }])}
                      >
                        +列
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {gridRows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      <td className="chart-grid-index">{rowIndex + 1}</td>
                      {gridFields.map((field, col) => (
                        <td key={col}>
                          <input
                            value={row[col] ?? ""}
                            onChange={(e) => {
                              const value = e.target.value;
                              setDatasetRows((prev) => prev.map((r, i) => {
                                if (i !== rowIndex) return r;
                                const next = [...r];
                                while (next.length <= col) next.push("");
                                next[col] = field.type === "number" && value !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
                                return next;
                              }));
                            }}
                            aria-label={`第 ${rowIndex + 1} 行 ${field.name}`}
                          />
                        </td>
                      ))}
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="chart-grid-foot">
              <button
                type="button"
                className="btn-xs"
                disabled={datasetRows.length >= 5000}
                onClick={() => setDatasetRows((prev) => [...prev, gridFields.map(() => "")])}
              >
                +行（≤5000）
              </button>
              <button
                type="button"
                className="btn-xs chart-danger"
                disabled={datasetRows.length <= 1}
                onClick={() => setDatasetRows((prev) => prev.slice(0, -1))}
              >
                -末行
              </button>
              <span className="chart-grid-note">{datasetRows.length} 行 × {gridFields.length} 列</span>
            </div>
          </div>
        ) : (
          <div className="chart-placeholder">从左侧选择或新建一张数据表</div>
        )}
        {error ? <div className="chart-error chart-error-inline">{error}</div> : null}
      </div>
    </div>
  );
}
