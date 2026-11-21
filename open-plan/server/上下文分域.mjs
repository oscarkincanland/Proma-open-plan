/**
 * 上下文分域（计划 2026-11-19-001 批次 C）
 *
 * 背景：技能目录此前"全量注入"（68 条 ≈8KB，截断），其中地图、图表、画布等域与
 * "写一份工可报告"完全无关；已有的 writingLeanContext 只照顾了写作一路。
 *
 * 做法：先判定本轮领域（document / map / canvas / research / all），再按域筛选技能目录；
 * 命中不足 minHit 时**回退全量**（宁可多给，不可漏掉），因此不会出现"模型不知道有这个能力"。
 * 纯函数、无 IO。
 */
import { WRITING_SKILL_RE, selectWritingSkills } from "./写作技能筛选.mjs";

export const CONTEXT_DOMAINS = Object.freeze(["document", "map", "canvas", "research", "all"]);

const MAP_SKILL_RE = /地图|gis|map|图层|路网|od|热力|等时圈|空间分析|矢量瓦片|收费站|枢纽/i;
const CANVAS_SKILL_RE = /画布|canvas|图表|chart|展板|board|演示|ppt|幻灯片|海报|配色|视觉/i;
const RESEARCH_SKILL_RE = /检索|搜索|调研|资料|review|审查|评估|分析报告|知识库/i;

const DOMAIN_SKILL_RE = {
  document: WRITING_SKILL_RE,
  map: MAP_SKILL_RE,
  canvas: CANVAS_SKILL_RE,
  research: RESEARCH_SKILL_RE,
};

/** 文本里的领域线索（地图/画布优先于研究，因为它们的工具面更窄）。 */
export function detectDomainFromText(text = "") {
  const source = String(text || "");
  if (!source.trim()) return "";
  if (MAP_SKILL_RE.test(source)) return "map";
  if (CANVAS_SKILL_RE.test(source)) return "canvas";
  if (RESEARCH_SKILL_RE.test(source)) return "research";
  return "";
}

/**
 * 判定本轮上下文领域。
 * @param {{route?:string, text?:string, mode?:string, capabilityPlan?:object}} input
 * @returns {"document"|"map"|"canvas"|"research"|"all"}
 */
export function resolveContextDomain({ route = "", text = "", mode = "", capabilityPlan = null } = {}) {
  const 写作路由 = ["template", "generate", "edit"].includes(String(route || ""));
  // 只读模式（Chat/Review）不按域裁剪：它们可能同时查多个域的技能。
  if (String(mode || "") === "chat" || String(mode || "") === "review") return 写作路由 ? "document" : "all";
  const fromText = detectDomainFromText(text);
  if (fromText) return fromText;
  if (写作路由) return "document";
  const routeName = String(capabilityPlan?.routing?.skills || "");
  if (routeName === "off") return "all";
  return "all";
}

/**
 * 按域筛选技能目录；命中不足 minHit 回退全量（不改写输入）。
 * @returns {{skills:Array, filtered:boolean, domain:string, matched:number}}
 */
export function selectSkillsForDomain(skills = [], domain = "all", { limit = 24, minHit = 3 } = {}) {
  const list = Array.isArray(skills) ? skills : [];
  const key = CONTEXT_DOMAINS.includes(domain) ? domain : "all";
  if (key === "all" || !list.length) {
    return { skills: list, filtered: false, domain: key, matched: 0 };
  }
  if (key === "document") {
    const picked = selectWritingSkills(list, { limit, minHit });
    return { skills: picked.skills, filtered: picked.filtered, domain: key, matched: picked.matched };
  }
  const pattern = DOMAIN_SKILL_RE[key];
  const matched = pattern ? list.filter((item) => pattern.test(`${item?.name || ""} ${item?.description || ""}`)) : [];
  if (matched.length < Math.max(1, Number(minHit) || 3)) {
    return { skills: list, filtered: false, domain: key, matched: matched.length };
  }
  const max = Math.max(1, Math.min(30, Number(limit) || 24));
  return { skills: matched.slice(0, max), filtered: true, domain: key, matched: matched.length };
}
