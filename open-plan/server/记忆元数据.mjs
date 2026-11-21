/**
 * 记忆元数据（计划 2026-11-19-001 批次 C）
 *
 * 背景：MEMORY.md 自己标着"记忆可能过时"，但每条记忆没有**置信度 / 最后核验时间 / 适用范围**，
 * 模型只能靠比对判断新旧，越攒越乱。
 *
 * 约定：
 *   - 条目仍是一行 Markdown 列表项，元数据以固定后缀写在行尾，人读友好、机器可解析：
 *       - 内容（置信度 0.7 · 核验 2026-11-19 · 适用 workspace）
 *   - 没有后缀的旧条目视为"未核验"（stale），召回时加提示但不删除——迁移不破坏历史数据；
 *   - 纯函数、无 IO，Node 可直测。
 */

/** 适用范围枚举：工作区通用 / 项目专属 / 用户个人偏好。 */
export const MEMORY_SCOPES = Object.freeze(["workspace", "project", "user"]);

export const MEMORY_META_DEFAULTS = Object.freeze({
  scope: "workspace",
  confidence: null,
  lastVerified: null,
});

const META_PATTERN = /（(?:置信度\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*·\s*)?核验\s*(\d{4}-\d{2}-\d{2})\s*·\s*适用\s*([A-Za-z_-]+)）\s*$/;

function 今天(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** 归一化置信度：非法值返回 null（表示未标注），合法值夹在 0~1。 */
export function normalizeConfidence(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(1, Math.max(0, Math.round(num * 100) / 100));
}

export function normalizeScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  return MEMORY_SCOPES.includes(scope) ? scope : MEMORY_META_DEFAULTS.scope;
}

/**
 * 格式化一条记忆（带元数据后缀）。
 * @param {{content:string, scope?:string, confidence?:number|null, lastVerified?:string|null, now?:Date}} input
 */
export function formatMemoryEntry({ content, scope, confidence, lastVerified, now } = {}) {
  const body = String(content || "").replace(/\s+/g, " ").trim();
  if (!body) return "";
  const conf = normalizeConfidence(confidence);
  const verified = /^\d{4}-\d{2}-\d{2}$/.test(String(lastVerified || "")) ? String(lastVerified) : 今天(now);
  const scopeValue = normalizeScope(scope);
  // 无置信度时不写"置信度"字段，避免伪造精度（只在有值时出现）。
  if (conf === null) return `- ${body}（核验 ${verified} · 适用 ${scopeValue}）`;
  return `- ${body}（置信度 ${conf} · 核验 ${verified} · 适用 ${scopeValue}）`;
}

/**
 * 解析一行记忆。
 * @returns {{content:string, scope:string, confidence:number|null, lastVerified:string|null, hasMeta:boolean, raw:string}}
 */
export function parseMemoryEntry(line) {
  const raw = String(line || "").trim();
  const body = raw.replace(/^[-*]\s*/, "");
  const hit = META_PATTERN.exec(body);
  if (!hit) {
    return { content: body, ...MEMORY_META_DEFAULTS, hasMeta: false, raw: body };
  }
  const content = body.slice(0, hit.index).trim();
  return {
    content,
    scope: normalizeScope(hit[3]),
    confidence: normalizeConfidence(hit[1]),
    lastVerified: hit[2],
    hasMeta: true,
    raw: body,
  };
}

/** 距最后核验的天数；未标注返回 null。 */
export function memoryAgeDays(entry, now = new Date()) {
  const verified = String(entry?.lastVerified || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verified)) return null;
  const then = Date.parse(`${verified}T00:00:00Z`);
  if (!Number.isFinite(then)) return null;
  const base = now instanceof Date ? now : new Date(now);
  const diff = base.getTime() - then;
  if (!Number.isFinite(diff)) return null;
  return Math.max(0, Math.floor(diff / 86400000));
}

/**
 * 是否"可能过时"：未标注核验时间，或超过 maxAgeDays 未核验。
 * @param {object} entry parseMemoryEntry 的结果
 * @param {{now?:Date, maxAgeDays?:number}} [options]
 */
export function isMemoryStale(entry, { now = new Date(), maxAgeDays = 90 } = {}) {
  const age = memoryAgeDays(entry, now);
  if (age === null) return true;
  return age > Math.max(1, Number(maxAgeDays) || 90);
}

/** 过时原因（人类可读，用于召回提示）。 */
export function staleReason(entry, { now = new Date(), maxAgeDays = 90 } = {}) {
  const age = memoryAgeDays(entry, now);
  if (age === null) return "未标注核验时间";
  if (age <= Math.max(1, Number(maxAgeDays) || 90)) return "";
  return `已 ${age} 天未核验`;
}

/**
 * 给 MEMORY.md 正文加"可能过时"标注（不删除、不改写原条目文本）。
 * 只处理 `- ` 列表项；小节标题与正文段落原样保留。
 * @returns {{text:string, total:number, stale:number, staleContents:string[]}}
 */
export function annotateMemoryBody(text, { now = new Date(), maxAgeDays = 90 } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  let total = 0;
  let stale = 0;
  const staleContents = [];
  const 已标注 = "（可能过时：";
  const out = lines.map((line) => {
    if (!/^\s*[-*]\s+\S/.test(line)) return line;
    if (line.includes(已标注)) return line;
    total += 1;
    const entry = parseMemoryEntry(line);
    if (!isMemoryStale(entry, { now, maxAgeDays })) return line;
    stale += 1;
    staleContents.push(entry.content.slice(0, 60));
    return `${line.trimEnd()}（可能过时：${staleReason(entry, { now, maxAgeDays })}）`;
  });
  return { text: out.join("\n"), total, stale, staleContents };
}

/** 记忆健康度摘要（供诊断/前端展示）。 */
export function summarizeMemoryHealth(text, { now = new Date(), maxAgeDays = 90 } = {}) {
  const entries = String(text || "").split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line)).map(parseMemoryEntry);
  const withConfidence = entries.filter((entry) => entry.confidence !== null);
  const stale = entries.filter((entry) => isMemoryStale(entry, { now, maxAgeDays }));
  return {
    total: entries.length,
    stale: stale.length,
    fresh: entries.length - stale.length,
    withMeta: entries.filter((entry) => entry.hasMeta).length,
    avgConfidence: withConfidence.length
      ? Math.round((withConfidence.reduce((sum, entry) => sum + entry.confidence, 0) / withConfidence.length) * 100) / 100
      : null,
    maxAgeDays,
  };
}
