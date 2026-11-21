/**
 * 图表工作台（Work 模式）：数据表 / ECharts 图表 / 展板的读写、校验与软删除。
 *
 * 方案：docs/plans/2026-11-19-001-ECharts图表工作台与展板方案.md（v2 已确认，ADR 0041）。
 * 数据模型唯一事实来源是工作区文件：
 *
 *   <workspace>/charts/<slug>/
 *   ├─ project/
 *   │  ├─ manifest.json              # 清单：[{id, kind:"chart"|"dataset"|"board", title, updatedAt}]
 *   │  ├─ datasets/<datasetId>.json  # 数据表 { id, title, fields:[{name,type}], rows:[[..]], note? }
 *   │  ├─ chart-<id>.json            # 图表 { id, title, option, data, note? }
 *   │  ├─ boards/<boardId>.json      # 展板 { id, title, layout:[{chartId,x,y,w,h}], theme? }
 *   │  ├─ assets/                    # 渲染快照（阶段 1a 使用）
 *   │  └─ exports/                   # 导出产物（阶段 1a/2 使用）
 *   ├─ .trash/                       # 软删除回收（对齐 server/创作画布.mjs）
 *   ├─ .history/                     # 时间线（阶段 1a 接入版本留存，先建目录）
 *   └─ operations.jsonl              # 操作日志
 *
 * 约束（与创作画布同款纪律）：
 *   - 所有路径必须在当前工作区 charts/<slug>/project 内（isInside 校验）；
 *   - 写盘一律经 写入协调.mjs 写锁 + 持久化工具.mjs 原子写；读取不加锁；
 *   - 错误统一 `throw Object.assign(new Error(msg), { code })`，code 以 CHART_ 开头；
 *   - 事件（chart_created/chart_changed/chart_exported）由调用方（agent 工具 / API）发射，
 *     本模块只返回结果，保持与创作画布模块同构。
 *   - 渲染形态契约：绑定 datasetId 的图表，option.series 不得直连 data，也不得自带
 *     option.dataset（两种数据形态并存时拒绝写入）——渲染时由前端把数据表行合并进
 *     option.dataset.source；既有技能模板为 series.data 直连形态，须先经 dataset 归一化。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isInside } from "./workspace.mjs";
import { appendJsonLine, atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";
import { withWriteLock } from "./写入协调.mjs";

/** 图表工作台限额（方案 §4.1 建议值；阶段 0 定案，调整须回写方案）。 */
export const CHART_LIMITS = Object.freeze({
  workbenches: 50, // 单工作区工作台数
  charts: 200, // 单工作台图表数
  datasets: 50, // 单工作台数据表数
  boards: 50, // 单工作台展板数
  datasetRows: 5000, // 单数据表行数
  datasetCols: 64, // 单数据表列数
  datasetBytes: 16 * 1024 * 1024, // 单数据表文件大小
  optionBytes: 512 * 1024, // 单图表 option JSON 大小
  boardCharts: 24, // 单展板图表数
  titleChars: 200,
});

const CHARTS_DIR = "charts";
const PROJECT_DIR_NAME = "project";
const MANIFEST_FILE = "manifest.json";
const DATASETS_DIR = "datasets";
const BOARDS_DIR = "boards";
const EXPORTS_DIR = "exports";
const ASSETS_DIR = "assets";
const TRASH_DIR = ".trash";
const HISTORY_DIR = ".history";
const OPERATIONS_FILE = "operations.jsonl";

const SLUG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_TYPES = new Set(["number", "string", "date"]);
const ACTORS = new Set(["ui", "agent", "system"]);

/** 校验失败 / 状态异常统一抛 CHART_* 错误。 */
function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function normalizeActor(actor) {
  const value = String(actor || "").trim().toLowerCase();
  return ACTORS.has(value) ? value : "agent";
}

function normalizeTitle(title, { field = "title" } = {}) {
  const value = String(title || "").trim();
  if (!value) fail("CHART_INVALID", `${field} 必填`);
  if (value.length > CHART_LIMITS.titleChars) fail("CHART_INVALID", `${field} 超长（≤${CHART_LIMITS.titleChars} 字符）`);
  return value;
}

function normalizeId(id, prefix) {
  if (id === undefined || id === null || id === "") {
    return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
  }
  const value = String(id).trim();
  if (!ID_PATTERN.test(value)) fail("CHART_INVALID", `id 不合法（仅字母/数字/_/-，≤64 字符）：${value}`);
  return value;
}

/**
 * 由标题推导工作台 slug。
 *
 * 这是图表工作台 slug 的**唯一**推导规则：`chart_write` 等 agent 工具必须复用本函数，
 * 不得另写一份（否则同一标题会推出两个 slug，生成两张幽灵工作台，与创作画布同款缺陷）。
 */
export function slugifyWorkbench(title) {
  return String(title || "charts")
    .trim().toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "charts";
}

/** 解析图表目录并做工作区边界校验；不存在时按需抛错或创建。 */
function projectDir(ws, slug, { create = false } = {}) {
  const workspace = path.resolve(String(ws || ""));
  if (!slug || !SLUG_PATTERN.test(String(slug))) fail("CHART_INVALID", `slug 不合法：${slug}`);
  const dir = path.join(workspace, CHARTS_DIR, String(slug), PROJECT_DIR_NAME);
  if (!isInside(workspace, dir)) fail("CHART_PATH_OUT", "图表目录越出工作区");
  if (create) {
    for (const sub of [dir, path.join(dir, DATASETS_DIR), path.join(dir, BOARDS_DIR), path.join(dir, ASSETS_DIR), path.join(workspace, CHARTS_DIR, String(slug), EXPORTS_DIR), path.join(workspace, CHARTS_DIR, String(slug), TRASH_DIR), path.join(workspace, CHARTS_DIR, String(slug), HISTORY_DIR)]) {
      ensureDirectory(sub);
    }
  }
  return dir;
}

function workbenchRoot(ws, slug) {
  return path.dirname(projectDir(ws, slug));
}

function readManifest(ws, slug) {
  const dir = projectDir(ws, slug);
  const manifest = readJsonFile(path.join(dir, MANIFEST_FILE));
  if (!manifest) fail("CHART_NOT_FOUND", `图表工作台不存在：${slug}`);
  if (!Array.isArray(manifest.items)) fail("CHART_CORRUPT", "manifest.json 缺少 items 数组");
  return manifest;
}

function manifestEntry(manifest, id) {
  return (manifest.items || []).find((item) => item?.id === id) || null;
}

/** 同步写锁：与创作画布同款纪律——写路径都是秒级，冲突立即抛 CHART_BUSY 由调用方重试。 */
function withChartLock(ws, targetPath, fn) {
  const runId = `chart_${crypto.randomUUID()}`;
  return withWriteLock({ workspace: path.resolve(String(ws || "")), targetPath, runId, kind: "chart" }, fn);
}

async function updateManifest(ws, slug, mutate, actor, action) {
  const dir = projectDir(ws, slug, { create: false });
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const operationsPath = path.join(path.dirname(dir), OPERATIONS_FILE); // <slug>/operations.jsonl
  return withChartLock(ws, manifestPath, async () => {
    const manifest = readJsonFile(manifestPath) || { version: 1, title: slug, items: [] };
    if (!Array.isArray(manifest.items)) manifest.items = [];
    const result = mutate(manifest);
    manifest.updatedAt = new Date().toISOString();
    atomicWriteJson(manifestPath, manifest);
    await appendJsonLine(operationsPath, {
      at: manifest.updatedAt, slug, action, actor, detail: result?.log || {},
    });
    return result;
  });
}

function nextRevision(manifest) {
  return Number(manifest.revision || 0) + 1;
}

/* ============================ 工作台（slug）管理 ============================ */

/** 列出当前工作区全部图表工作台。 */
export function listWorkbenches(ws) {
  const workspace = path.resolve(String(ws || ""));
  const root = path.join(workspace, CHARTS_DIR);
  const out = [];
  let slugs = [];
  try {
    slugs = fs.readdirSync(root).filter((name) => !name.startsWith("."));
  } catch {
    return { workbenches: out };
  }
  for (const slug of slugs) {
    try {
      const manifest = readJsonFile(path.join(root, slug, PROJECT_DIR_NAME, MANIFEST_FILE));
      if (!manifest) continue;
      const items = Array.isArray(manifest.items) ? manifest.items : [];
      out.push({
        slug,
        title: manifest.title || slug,
        charts: items.filter((i) => i.kind === "chart").length,
        datasets: items.filter((i) => i.kind === "dataset").length,
        boards: items.filter((i) => i.kind === "board").length,
        updatedAt: manifest.updatedAt || "",
      });
    } catch {}
  }
  return { workbenches: out };
}

/** 新建图表工作台（幂等：同 slug 已存在且 manifest 完好时直接返回）。 */
export async function createWorkbench(ws, { slug, title, actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const cleanTitle = normalizeTitle(title || slug, { field: "title" });
  const useSlug = String(slug || "").trim() || slugifyWorkbench(cleanTitle);
  const dir = projectDir(ws, useSlug, { create: true });
  const existing = readJsonFile(path.join(dir, MANIFEST_FILE));
  if (existing?.items) {
    return { slug: useSlug, title: existing.title || cleanTitle, created: false, revision: Number(existing.revision || 0) };
  }
  const manifest = { version: 1, title: cleanTitle, items: [], revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await withChartLock(ws, path.join(dir, MANIFEST_FILE), async () => {
    atomicWriteJson(path.join(dir, MANIFEST_FILE), manifest);
    await appendJsonLine(path.join(workbenchRoot(ws, useSlug), OPERATIONS_FILE), { at: manifest.createdAt, slug: useSlug, action: "create", actor: who, detail: { title: cleanTitle } });
  });
  return { slug: useSlug, title: cleanTitle, created: true, revision: 1 };
}

/* ============================ 数据表（datasets） ============================ */

function parseIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return false;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed);
}

function validateDataset({ fields, rows }) {
  if (!Array.isArray(fields) || fields.length === 0) fail("CHART_INVALID", "fields 必填（非空数组）");
  if (fields.length > CHART_LIMITS.datasetCols) fail("CHART_LIMIT", `列数超限（≤${CHART_LIMITS.datasetCols}）`);
  const names = new Set();
  for (const field of fields) {
    const name = String(field?.name || "").trim();
    if (!name) fail("CHART_INVALID", "字段名不能为空");
    if (names.has(name)) fail("CHART_INVALID", `字段名重复：${name}`);
    names.add(name);
    if (!FIELD_TYPES.has(field?.type)) fail("CHART_INVALID", `字段 ${name} 的 type 必须是 number|string|date`);
  }
  if (!Array.isArray(rows) || rows.length === 0) fail("CHART_INVALID", "rows 必填（非空数组）");
  if (rows.length > CHART_LIMITS.datasetRows) fail("CHART_LIMIT", `行数超限（≤${CHART_LIMITS.datasetRows}）`);
  for (const [index, row] of rows.entries()) {
    if (!Array.isArray(row)) fail("CHART_INVALID", `第 ${index + 1} 行不是数组`);
    if (row.length !== fields.length) fail("CHART_INVALID", `第 ${index + 1} 行列数（${row.length}）与 fields（${fields.length}）不一致`);
    for (const [col, field] of fields.entries()) {
      const cell = row[col];
      if (cell === null || cell === undefined || cell === "") continue; // 空单元格允许
      if (field.type === "number") {
        if (typeof cell !== "number" || !Number.isFinite(cell)) fail("CHART_INVALID", `第 ${index + 1} 行「${field.name}」需要 number，收到 ${JSON.stringify(cell)}`);
      } else if (field.type === "date") {
        if (!parseIsoDate(cell)) fail("CHART_INVALID", `第 ${index + 1} 行「${field.name}」需要 ISO 8601 日期，收到 ${JSON.stringify(cell)}`);
      } else if (typeof cell === "object") {
        fail("CHART_INVALID", `第 ${index + 1} 行「${field.name}」不能是对象/数组`);
      }
    }
  }
}

function datasetPayload(dataset) {
  return { id: dataset.id, title: dataset.title, fields: dataset.fields, rows: dataset.rows, note: dataset.note || "" };
}

/** 写入（创建或全量更新）数据表。 */
export async function writeDataset(ws, slug, { id, title, fields, rows, note, actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const cleanTitle = normalizeTitle(title);
  const datasetId = normalizeId(id, "ds");
  validateDataset({ fields, rows });
  const dir = projectDir(ws, slug);
  const manifest = readManifest(ws, slug);
  if (!manifestEntry(manifest, datasetId) && manifest.items.filter((i) => i.kind === "dataset").length >= CHART_LIMITS.datasets) {
    fail("CHART_LIMIT", `数据表数量超限（≤${CHART_LIMITS.datasets}）`);
  }
  const file = path.join(dir, DATASETS_DIR, `${datasetId}.json`);
  const dataset = { id: datasetId, title: cleanTitle, fields, rows, note: String(note || "").trim() };
  const body = JSON.stringify(dataset);
  if (Buffer.byteLength(body) > CHART_LIMITS.datasetBytes) fail("CHART_LIMIT", "数据表文件超限");
  const result = await updateManifest(ws, slug, (manifest2) => {
    const prev = manifestEntry(manifest2, datasetId);
    if (prev) prev.title = cleanTitle;
    else manifest2.items.push({ id: datasetId, kind: "dataset", title: cleanTitle });
    manifest2.revision = nextRevision(manifest2);
    atomicWriteJson(file, dataset);
    return { log: { id: datasetId, rows: rows.length, created: !prev }, revision: manifest2.revision };
  }, who, "dataset_write");
  return { ...result.log, dataset: datasetPayload(dataset), slug, revision: result.revision };
}

/** 读数据表：datasetId 省略时返回清单（不含行数据）。 */
export function readDataset(ws, slug, datasetId) {
  const manifest = readManifest(ws, slug);
  if (!datasetId) {
    return {
      slug,
      datasets: manifest.items.filter((i) => i.kind === "dataset").map((i) => ({ id: i.id, title: i.title, updatedAt: i.updatedAt || "" })),
    };
  }
  const entry = manifestEntry(manifest, datasetId);
  if (!entry || entry.kind !== "dataset") fail("CHART_NOT_FOUND", `数据表不存在：${datasetId}`);
  const file = path.join(projectDir(ws, slug), DATASETS_DIR, `${datasetId}.json`);
  const dataset = readJsonFile(file);
  if (!dataset) fail("CHART_CORRUPT", `数据表文件缺失：${datasetId}`);
  return { slug, dataset: datasetPayload(dataset) };
}

/** 软删除数据表（进 .trash；绑定它的图表渲染时标记 missing）。 */
export async function deleteDataset(ws, slug, datasetId, { actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const manifest = readManifest(ws, slug);
  const entry = manifestEntry(manifest, datasetId);
  if (!entry || entry.kind !== "dataset") fail("CHART_NOT_FOUND", `数据表不存在：${datasetId}`);
  const dir = projectDir(ws, slug);
  const file = path.join(dir, DATASETS_DIR, `${datasetId}.json`);
  const result = await updateManifest(ws, slug, (manifest2) => {
    manifest2.items = manifest2.items.filter((i) => i.id !== datasetId);
    manifest2.revision = nextRevision(manifest2);
    try {
      fs.mkdirSync(path.join(workbenchRoot(ws, slug), TRASH_DIR), { recursive: true });
      fs.renameSync(file, path.join(workbenchRoot(ws, slug), TRASH_DIR, `${Date.now()}-ds-${datasetId}.json`));
    } catch (error) {
      fail("CHART_DELETE_FAILED", `软删除失败：${error?.message || error}`);
    }
    return { log: { id: datasetId }, revision: manifest2.revision };
  }, who, "dataset_delete");
  return { ...result.log, slug, revision: result.revision };
}

/* ============================ 图表（charts） ============================ */

/**
 * 归一化并校验图表 option 与数据绑定：
 * - option 必须是对象且 ≤ optionBytes；
 * - data.kind = "dataset" 时 series 不得直连 data、option.dataset 不得并存（渲染由前端合并）；
 * - data.kind = "inline" 时 inline 必须是对象或数组（ECharts dataset.source 兼容形态）。
 */
function normalizeChartInput({ option, data }) {
  let optionObj = option;
  if (typeof optionObj === "string") {
    try { optionObj = JSON.parse(optionObj); } catch { fail("CHART_INVALID", "option 不是合法 JSON"); }
  }
  if (!optionObj || typeof optionObj !== "object" || Array.isArray(optionObj)) fail("CHART_INVALID", "option 必须是对象");
  if (Buffer.byteLength(JSON.stringify(optionObj)) > CHART_LIMITS.optionBytes) fail("CHART_LIMIT", `option 超限（≤${Math.round(CHART_LIMITS.optionBytes / 1024)} KB）`);

  let dataObj = data || { kind: "inline" };
  if (typeof dataObj === "string") {
    try { dataObj = JSON.parse(dataObj); } catch { fail("CHART_INVALID", "data 不是合法 JSON"); }
  }
  if (!dataObj || typeof dataObj !== "object") fail("CHART_INVALID", "data 必须是对象");
  const kind = dataObj.kind;
  if (kind === "dataset") {
    if (!dataObj.datasetId) fail("CHART_INVALID", "data.kind=dataset 时 datasetId 必填");
    const series = Array.isArray(optionObj.series) ? optionObj.series : [];
    if (series.some((s) => s && Array.isArray(s.data))) fail("CHART_CONFLICT_DATA_FORM", "绑定数据表的图表 series 不得直连 data（请改用 dataset/dimensions 形态或改 kind=inline）");
    if (optionObj.dataset) fail("CHART_CONFLICT_DATA_FORM", "绑定数据表的图表不得自带 option.dataset（渲染时由数据表合并 source）");
  } else if (kind === "csv") {
    // 方案 §4.1：CSV 导入统一落成数据表，chart 仅绑 datasetId；csv 仅为溯源留痕。
    fail("CHART_INVALID", "CSV 导入请使用 importCsvAsDataset 落成数据表后绑定 datasetId（chart.data 不支持 kind=csv）");
  } else if (kind === "inline") {
    if (dataObj.inline === undefined) fail("CHART_INVALID", "data.kind=inline 时 inline 必填");
    if (!Array.isArray(dataObj.inline) && (typeof dataObj.inline !== "object" || dataObj.inline === null)) {
      fail("CHART_INVALID", "inline 必须是数组或对象（ECharts dataset.source 兼容形态）");
    }
  } else {
    fail("CHART_INVALID", `data.kind 仅支持 dataset|inline，收到 ${kind}`);
  }
  return { option: optionObj, data: { ...dataObj } };
}

/** 写入（创建或全量更新）图表。 */
export async function writeChart(ws, slug, { id, title, option, data, note, actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const cleanTitle = normalizeTitle(title);
  const chartId = normalizeId(id, "chart");
  const normalized = normalizeChartInput({ option, data });
  const dir = projectDir(ws, slug);
  const manifest = readManifest(ws, slug);
  if (!manifestEntry(manifest, chartId) && manifest.items.filter((i) => i.kind === "chart").length >= CHART_LIMITS.charts) {
    fail("CHART_LIMIT", `图表数量超限（≤${CHART_LIMITS.charts}）`);
  }
  if (normalized.data.kind === "dataset") {
    const entry = manifestEntry(manifest, normalized.data.datasetId);
    if (!entry || entry.kind !== "dataset") fail("CHART_NOT_FOUND", `绑定的数据表不存在：${normalized.data.datasetId}`);
  }
  const target = path.join(dir, `${chartId.startsWith("chart-") ? chartId : `chart-${chartId}`}.json`);
  const safeId = chartId.startsWith("chart-") ? chartId : `chart-${chartId}`;
  const chart = {
    id: safeId,
    title: cleanTitle,
    option: normalized.option,
    data: normalized.data,
    note: String(note || "").trim(),
    updatedAt: new Date().toISOString(),
  };
  const result = await updateManifest(ws, slug, (manifest2) => {
    const prev = manifestEntry(manifest2, safeId);
    if (prev) prev.title = cleanTitle;
    else manifest2.items.push({ id: safeId, kind: "chart", title: cleanTitle });
    manifest2.revision = nextRevision(manifest2);
    if (prev) {
      // 覆盖前留存上一版（阶段 1a 时间线的种子；只保留最近一份上一版）。
      const old = readJsonFile(target);
      if (old) atomicWriteJson(path.join(workbenchRoot(ws, slug), HISTORY_DIR, `${safeId}.prev.json`), old);
    }
    atomicWriteJson(target, chart);
    return { log: { id: safeId, created: !prev, dataKind: normalized.data.kind }, revision: manifest2.revision };
  }, who, "chart_write");
  return { ...result.log, chart, slug, revision: result.revision };
}

/** 读图表：chartId 省略时返回清单。 */
export function readChart(ws, slug, chartId) {
  const manifest = readManifest(ws, slug);
  if (!chartId) {
    return {
      slug,
      charts: manifest.items.filter((i) => i.kind === "chart").map((i) => ({ id: i.id, title: i.title, updatedAt: i.updatedAt || "" })),
    };
  }
  const wanted = String(chartId).startsWith("chart-") ? String(chartId) : `chart-${chartId}`;
  const entry = manifestEntry(manifest, wanted);
  if (!entry || entry.kind !== "chart") fail("CHART_NOT_FOUND", `图表不存在：${chartId}`);
  const chart = readJsonFile(path.join(projectDir(ws, slug), `${wanted}.json`));
  if (!chart) fail("CHART_CORRUPT", `图表文件缺失：${wanted}`);
  return { slug, chart };
}

/** 仅更新图表的数据绑定/内联数据（不改 option）。 */
export async function setChartData(ws, slug, chartId, { data, actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const existing = readChart(ws, slug, chartId);
  const normalized = normalizeChartInput({ option: existing.chart.option, data });
  const result = await updateManifest(ws, slug, (manifest2) => {
    manifest2.revision = nextRevision(manifest2);
    const target = path.join(projectDir(ws, slug), `${existing.chart.id}.json`);
    const next = { ...existing.chart, data: normalized.data, updatedAt: new Date().toISOString() };
    atomicWriteJson(target, next);
    return { log: { id: existing.chart.id, dataKind: normalized.data.kind }, revision: manifest2.revision };
  }, who, "chart_set_data");
  return { ...result.log, slug, revision: result.revision };
}

/** 软删除图表（进 .trash；展板引用与数据表不删）。 */
export async function deleteChart(ws, slug, chartId, { actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const existing = readChart(ws, slug, chartId);
  const result = await updateManifest(ws, slug, (manifest2) => {
    manifest2.items = manifest2.items.filter((i) => i.id !== existing.chart.id);
    manifest2.revision = nextRevision(manifest2);
    try {
      const trash = path.join(workbenchRoot(ws, slug), TRASH_DIR);
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(path.join(projectDir(ws, slug), `${existing.chart.id}.json`), path.join(trash, `${Date.now()}-${existing.chart.id}.json`));
    } catch (error) {
      fail("CHART_DELETE_FAILED", `软删除失败：${error?.message || error}`);
    }
    return { log: { id: existing.chart.id }, revision: manifest2.revision };
  }, who, "chart_delete");
  return { ...result.log, slug, revision: result.revision };
}

/* ============================ 展板（boards） ============================ */

function validateBoardLayout(layout) {
  if (!Array.isArray(layout)) fail("CHART_INVALID", "layout 必须是数组");
  if (layout.length > CHART_LIMITS.boardCharts) fail("CHART_LIMIT", `展板图表数超限（≤${CHART_LIMITS.boardCharts}）`);
  for (const [index, item] of layout.entries()) {
    if (!item || typeof item !== "object") fail("CHART_INVALID", `layout[${index}] 不是对象`);
    if (!item.chartId) fail("CHART_INVALID", `layout[${index}] 缺 chartId`);
    for (const key of ["x", "y", "w", "h"]) {
      const value = Number(item[key]);
      if (!Number.isFinite(value) || value < 0) fail("CHART_INVALID", `layout[${index}].${key} 必须是非负数字`);
    }
  }
}

/** 写入（创建或全量更新）展板。展板引用不存在的图表不拒绝——渲染时标记 missing。 */
export async function writeBoard(ws, slug, { id, title, layout, theme, actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const cleanTitle = normalizeTitle(title);
  const boardId = normalizeId(id, "board");
  validateBoardLayout(layout);
  const dir = projectDir(ws, slug);
  const manifest = readManifest(ws, slug);
  if (!manifestEntry(manifest, boardId) && manifest.items.filter((i) => i.kind === "board").length >= CHART_LIMITS.boards) {
    fail("CHART_LIMIT", `展板数量超限（≤${CHART_LIMITS.boards}）`);
  }
  const file = path.join(dir, BOARDS_DIR, `${boardId}.json`);
  const board = { id: boardId, title: cleanTitle, layout, theme: theme ? String(theme) : "", updatedAt: new Date().toISOString() };
  const result = await updateManifest(ws, slug, (manifest2) => {
    const prev = manifestEntry(manifest2, boardId);
    if (prev) prev.title = cleanTitle;
    else manifest2.items.push({ id: boardId, kind: "board", title: cleanTitle });
    manifest2.revision = nextRevision(manifest2);
    atomicWriteJson(file, board);
    return { log: { id: boardId, created: !prev, charts: layout.length }, revision: manifest2.revision };
  }, who, "board_write");
  return { ...result.log, board, slug, revision: result.revision };
}

/** 读展板：boardId 省略时返回清单。 */
export function readBoardFile(ws, slug, boardId) {
  const manifest = readManifest(ws, slug);
  if (!boardId) {
    return {
      slug,
      boards: manifest.items.filter((i) => i.kind === "board").map((i) => ({ id: i.id, title: i.title, updatedAt: i.updatedAt || "" })),
    };
  }
  const entry = manifestEntry(manifest, boardId);
  if (!entry || entry.kind !== "board") fail("CHART_NOT_FOUND", `展板不存在：${boardId}`);
  const board = readJsonFile(path.join(projectDir(ws, slug), BOARDS_DIR, `${boardId}.json`));
  if (!board) fail("CHART_CORRUPT", `展板文件缺失：${boardId}`);
  return { slug, board };
}

/** 软删除展板（进 .trash）。 */
export async function deleteBoard(ws, slug, boardId, { actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const manifest = readManifest(ws, slug);
  const entry = manifestEntry(manifest, boardId);
  if (!entry || entry.kind !== "board") fail("CHART_NOT_FOUND", `展板不存在：${boardId}`);
  const result = await updateManifest(ws, slug, (manifest2) => {
    manifest2.items = manifest2.items.filter((i) => i.id !== boardId);
    manifest2.revision = nextRevision(manifest2);
    try {
      const trash = path.join(workbenchRoot(ws, slug), TRASH_DIR);
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(path.join(projectDir(ws, slug), BOARDS_DIR, `${boardId}.json`), path.join(trash, `${Date.now()}-${boardId}.json`));
    } catch (error) {
      fail("CHART_DELETE_FAILED", `软删除失败：${error?.message || error}`);
    }
    return { log: { id: boardId }, revision: manifest2.revision };
  }, who, "board_delete");
  return { ...result.log, slug, revision: result.revision };
}

/* ============================ CSV → 数据表 ============================ */

/** 按 RFC4180 宽松解析 CSV 文本（引号/逗号/CRLF）。 */
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch === "\r") { /* CRLF 容忍 */ }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

/** 编码探测：UTF-8 优先，失败回落 gb18030（复用预览类型.mjs 的先例口径）。 */
export function decodeCsvBuffer(buffer) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text: text.replace(/^\uFEFF/, ""), encoding: "utf-8" };
  } catch {
    const text = new TextDecoder("gb18030").decode(buffer);
    return { text: text.replace(/^\uFEFF/, ""), encoding: "gb18030" };
  }
}

/** 从工作区 CSV 文件导入落成数据表（方案 §4.1：CSV 统一转数据表，chart 仅绑 datasetId）。 */
export async function importCsvAsDataset(ws, slug, { csvPath, title, id, expectRows, note, actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  const workspace = path.resolve(String(ws || ""));
  const absolute = path.resolve(workspace, String(csvPath || ""));
  if (!isInside(workspace, absolute)) fail("CHART_PATH_OUT", "CSV 路径越出工作区");
  const buffer = fs.readFileSync(absolute);
  const { text, encoding } = decodeCsvBuffer(buffer);
  const table = parseCsvText(text);
  if (!table.length) fail("CHART_INVALID", "CSV 无有效行");
  const header = table[0].map((name) => String(name || "").trim() || `列${table[0].indexOf(name) + 1}`);
  const rawRows = table.slice(1);
  if (expectRows !== undefined && Number(expectRows) !== rawRows.length) {
    fail("DATA_INTEGRITY_FAILED", `CSV 记录数不一致：expected=${Number(expectRows)} actual=${rawRows.length}（${absolute}）`);
  }
  // 类型推断：整列可解析为有限数字 → number；否则 string（date 推断保守，不自动）。
  const fields = header.map((name, col) => {
    const values = rawRows.map((row) => row[col]).filter((c) => String(c ?? "").trim() !== "");
    const numeric = values.length > 0 && values.every((c) => Number.isFinite(Number(c)));
    return { name, type: numeric ? "number" : "string" };
  });
  const rows = rawRows.map((row) => fields.map((field, col) => {
    const cell = row[col] === undefined ? "" : String(row[col]).trim();
    if (cell === "") return "";
    return field.type === "number" ? Number(cell) : cell;
  }));
  const written = await writeDataset(ws, slug, { id, title: title || path.basename(absolute, path.extname(absolute)), fields, rows, note: note || `CSV 导入自 ${csvPath}（${encoding}）`, actor: who });
  return { ...written, encoding, expected: expectRows, actual: rawRows.length };
}

/** 展板渲染视图（供前端/工具投影）：把图表、数据表行与 missing 标记合并进展板布局。 */
export function boardView(ws, slug, boardId) {
  const { board } = readBoardFile(ws, slug, boardId);
  const layout = board.layout.map((item) => {
    let chart = null;
    let missing = false;
    let datasetSource = null;
    try {
      chart = readChart(ws, slug, item.chartId).chart;
    } catch {
      missing = true;
    }
    if (chart?.data?.kind === "dataset") {
      try {
        const { dataset } = readDataset(ws, slug, chart.data.datasetId);
        datasetSource = buildDatasetSource(dataset);
      } catch {
        missing = true; // 数据表被删：图表 missing
      }
    }
    return { ...item, chart, missing, datasetSource };
  });
  return { slug, board: { ...board, layout }, revision: Number(readManifest(ws, slug).revision || 0) };
}

/* ============================ SSR 渲染与导出 ============================ */
// 服务端 SVG SSR 导出（技能 echarts-canvas-chart 的 render-chart.mjs 已验证该路径可行）：
// echarts/core 按需注册 + init(null,null,{renderer:"svg",ssr:true})。PNG 无 node-canvas
// 不做服务端渲染（方案 §7：PNG 走前端 getDataURL / 截图链路，阶段 3 收口）。

let echartsSsrPromise = null;
async function loadEchartsSsr() {
  if (!echartsSsrPromise) {
    echartsSsrPromise = (async () => {
      const echarts = await import("echarts/core");
      const { BarChart, LineChart, PieChart, ScatterChart, SankeyChart } = await import("echarts/charts");
      const {
        GridComponent, TooltipComponent, LegendComponent, TitleComponent,
        DataZoomComponent, DatasetComponent, TransformComponent,
      } = await import("echarts/components");
      const { LabelLayout, UniversalTransition } = await import("echarts/features");
      const { SVGRenderer } = await import("echarts/renderers");
      echarts.use([
        BarChart, LineChart, PieChart, ScatterChart, SankeyChart,
        GridComponent, TooltipComponent, LegendComponent, TitleComponent,
        DataZoomComponent, DatasetComponent, TransformComponent,
        LabelLayout, UniversalTransition,
        SVGRenderer,
      ]);
      return echarts;
    })();
  }
  return echartsSsrPromise;
}

/** 数据表 → ECharts dataset（dimensions=字段名，source=行）。 */
export function buildDatasetSource(dataset) {
  return {
    dimensions: dataset.fields.map((f) => f.name),
    source: dataset.rows,
  };
}

/**
 * 服务端渲染单图为 SVG 字符串（SSR，不落盘）。
 * 绑定数据表的图表在此合并 option.dataset.source（与前端 ChartRenderer 同一契约）。
 */
export async function renderChartSvg(ws, slug, chartId, { width = 1280, height = 720 } = {}) {
  const { chart } = readChart(ws, slug, chartId);
  let option = chart.option;
  if (chart.data?.kind === "dataset") {
    const { dataset } = readDataset(ws, slug, chart.data.datasetId);
    option = { ...option, dataset: buildDatasetSource(dataset) };
  }
  const echarts = await loadEchartsSsr();
  const instance = echarts.init(null, null, {
    renderer: "svg", ssr: true,
    width: Math.min(Math.max(200, Math.round(Number(width) || 1280)), 8000),
    height: Math.min(Math.max(200, Math.round(Number(height) || 720)), 8000),
  });
  try {
    instance.setOption(option);
    return { svg: instance.renderToSVGString(), chart };
  } finally {
    instance.dispose();
  }
}

function sanitizeExportName(value, fallback) {
  const name = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return name || fallback;
}

/** 导出单图为 SVG 到 charts/<slug>/exports/（产物台账可见；不写 manifest）。 */
export async function exportChart(ws, slug, chartId, { format = "svg", outputName, width, height, actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  if (format !== "svg") {
    fail("CHART_EXPORT_UNSUPPORTED", `服务端导出仅支持 svg（收到 ${format}）；PNG 走前端截图链路（阶段 3 收口）`);
  }
  const { svg, chart } = await renderChartSvg(ws, slug, chartId, { width, height });
  // exports/ 位于 slug 顶层（与 designs/<slug>/exports/ 同构），保证导出产物可见于产物台账
  // （isChartInternalArtifactPath 只隐藏 project/** 与 operations.jsonl）。
  const dir = ensureDirectory(path.join(workbenchRoot(ws, slug), EXPORTS_DIR));
  const fileName = `${sanitizeExportName(outputName, `${chart.id}-${Date.now()}`)}.svg`;
  const target = path.join(dir, fileName);
  const bytes = Buffer.byteLength(svg, "utf8");
  fs.writeFileSync(target, svg, "utf8");
  await appendJsonLine(path.join(workbenchRoot(ws, slug), OPERATIONS_FILE), {
    at: new Date().toISOString(), slug, action: "chart_export", actor: who,
    detail: { id: chart.id, format, file: path.join(CHARTS_DIR, slug, EXPORTS_DIR, fileName).replace(/\\/g, "/"), bytes },
  });
  return {
    slug,
    format,
    files: [{ path: path.join(CHARTS_DIR, slug, EXPORTS_DIR, fileName).replace(/\\/g, "/"), bytes }],
    chartId: chart.id,
  };
}

/**
 * 导出展板为静态 HTML（阶段 2）：逐图 SSR SVG + 网格布局，绝对定位单元格。
 * 产物落 slug 顶层 exports/，进产物台账；PNG 走前端截图链路（与单图口径一致）。
 */
export async function exportBoard(ws, slug, boardId, { format = "html", outputName, actor = "agent" } = {}) {
  const who = normalizeActor(actor);
  if (format !== "html") {
    fail("CHART_EXPORT_UNSUPPORTED", `服务端展板导出仅支持 html（收到 ${format}）；PNG 走前端截图链路`);
  }
  const view = boardView(ws, slug, boardId);
  const board = view.board;
  if (!board.layout.length) fail("CHART_INVALID", "展板为空，无可导出内容");
  const cells = [];
  for (const cell of board.layout) {
    if (cell.missing || !cell.chart) {
      cells.push(`<div class="cell missing" style="left:${cell.x}px;top:${cell.y}px;width:${cell.w}px;height:${cell.h}px"><span>图表缺失（${cell.chartId}）</span></div>`);
      continue;
    }
    const rendered = await renderChartSvg(ws, slug, cell.chart.id, { width: Math.round(cell.w), height: Math.round(cell.h) });
    cells.push(`<div class="cell" style="left:${cell.x}px;top:${cell.y}px;width:${cell.w}px;height:${cell.h}px"><h3>${escapeHtml(rendered.chart.title || cell.chart.id)}</h3><div class="chart">${rendered.svg}</div></div>`);
  }
  const width = Math.max(...board.layout.map((c) => Number(c.x) + Number(c.w)), 0) || 1280;
  const height = Math.max(...board.layout.map((c) => Number(c.y) + Number(c.h)), 0) || 720;
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(board.title || boardId)} · 展板导出</title>
<style>
  body { margin: 0; padding: 24px; background: #f5f6f8; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
  .board { position: relative; background: #fff; border: 1px solid #d8dbe2; border-radius: 12px; overflow: hidden; width: ${width}px; height: ${height}px; }
  .cell { position: absolute; box-sizing: border-box; padding: 10px 12px; }
  .cell h3 { margin: 0 0 6px; font-size: 14px; color: #333; }
  .cell .chart { width: 100%; height: calc(100% - 26px); }
  .cell.missing { display: flex; align-items: center; justify-content: center; border: 1px dashed #c96a1e; color: #c96a1e; font-size: 12px; background: #fff7f0; }
  .cell svg { width: 100%; height: 100%; }
  footer { margin-top: 10px; color: #8a8a8a; font-size: 12px; }
</style></head>
<body><div class="board">${cells.join("\n")}</div>
<footer>规聚 · 图表工作台展板「${escapeHtml(board.title || boardId)}」导出于 ${new Date().toISOString()}（演示数据请以图表备注为准）</footer>
</body></html>`;
  const dir = ensureDirectory(path.join(workbenchRoot(ws, slug), EXPORTS_DIR));
  const fileName = `${sanitizeExportName(outputName, `board-${boardId}-${Date.now()}`)}.html`;
  const target = path.join(dir, fileName);
  const bytes = Buffer.byteLength(html, "utf8");
  fs.writeFileSync(target, html, "utf8");
  await appendJsonLine(path.join(workbenchRoot(ws, slug), OPERATIONS_FILE), {
    at: new Date().toISOString(), slug, action: "board_export", actor: who,
    detail: { id: boardId, format, file: path.join(CHARTS_DIR, slug, EXPORTS_DIR, fileName).replace(/\\/g, "/"), bytes },
  });
  return {
    slug,
    format,
    files: [{ path: path.join(CHARTS_DIR, slug, EXPORTS_DIR, fileName).replace(/\\/g, "/"), bytes }],
    boardId,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
