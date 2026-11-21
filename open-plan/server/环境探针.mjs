/**
 * 环境探针（计划 2026-11-19-001 批次 A）
 *
 * 目的：让 Agent 在动手前**一次**拿到环境事实（时间/时区、工作区可写性、bash 与 Office
 * 可用性、联网与浏览器等能力开关），而不是靠"调一次失败一次"去撞能力边界。
 * 现场证据：产品内 Agent 自评为取一个日期付出 4 次无效调用（bash 两次被守卫拦截、
 * officecli 对 .md 不支持、raw 在只读路由被拒）。
 *
 * 约束：
 *   - 只读：不写文件、不建目录、**不发起网络请求**（联网只回报能力开关，避免离线卡顿）；
 *   - 复用既有探测与其缓存：bash 走 `probeBashAvailability()` 的进程级缓存，
 *     Office 走 `checkOfficecli()` 的 60s TTL，不新增第二套探测实现；
 *   - 纯函数式可测：探测函数通过参数注入，单测不需要真的 spawn 进程。
 */
import fs from "node:fs";

import { probeBashAvailability, bashEnvironmentInfo } from "./环境能力.mjs";
import { checkOfficecli } from "./office.mjs";

function pad(value) {
  return String(value).padStart(2, "0");
}

/** 本地时间串（避免模型自己换算时区出错）。 */
export function formatLocalTime(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return "";
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 工作区可写性：只看已存在的目录，不做任何写操作。 */
export function probeWorkspace(workspace = "") {
  const target = String(workspace || "").trim();
  if (!target) return { path: "", exists: false, writable: false, reason: "未指定工作区" };
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return { path: target, exists: false, writable: false, reason: "工作区不是目录" };
    fs.accessSync(target, fs.constants.W_OK);
    return { path: target, exists: true, writable: true, reason: "" };
  } catch (error) {
    return {
      path: target,
      exists: Boolean(error && error.code !== "ENOENT"),
      writable: false,
      reason: String(error?.message || error).slice(0, 160),
    };
  }
}

/**
 * 汇总环境事实。
 *
 * @param {object} [options]
 * @param {string} [options.workspace] 当前工作区绝对路径
 * @param {string[]} [options.toolNames] 本轮白名单工具名（据此判断能力是否真的可调）
 * @param {Function} [options.shellProbe] 注入的 bash 探测（默认 probeBashAvailability）
 * @param {Function} [options.shellInfo] 注入的 bash 详情（默认 bashEnvironmentInfo）
 * @param {Function} [options.officeProbe] 注入的 Office 探测（默认 checkOfficecli）
 * @param {Date} [options.now] 注入的当前时间（测试可固定）
 */
export async function collectEnvironmentFacts({
  workspace = "",
  toolNames = [],
  shellProbe = probeBashAvailability,
  shellInfo = bashEnvironmentInfo,
  officeProbe = checkOfficecli,
  allowOfficeProbe = true,
  now = new Date(),
} = {}) {
  const tools = [...new Set((Array.isArray(toolNames) ? toolNames : []).map((name) => String(name || "").trim()).filter(Boolean))];
  const has = (name) => tools.includes(name);
  const hasPrefix = (prefix) => tools.some((name) => name.startsWith(prefix));

  // bash：既有探测已带缓存；异常也不抛出，改为可读原因。
  let shell = { available: false, shell: null, kind: null, reason: "未能探测" };
  try {
    const info = shellInfo() || {};
    const probe = shellProbe() || {};
    shell = {
      available: Boolean(probe.available ?? info.available),
      shell: probe.shell || info.shell || null,
      kind: probe.shellKind || info.shellKind || null,
      reason: probe.reason || info.reason || "",
      toolAvailable: has("bash"),
    };
  } catch (error) {
    shell = { available: false, shell: null, kind: null, reason: `探测异常：${String(error?.message || error).slice(0, 120)}`, toolAvailable: has("bash") };
  }

  // Office CLI：复用 checkOfficecli 的 TTL 缓存；只读模式（Chat）不主动 spawn，
  // 否则会越过「Chat 不调用 Office CLI」的边界，还要为一个探测等 8 秒。
  let office = { available: null, version: null, message: "该模式下不主动探测 Office CLI（只读边界）", toolAvailable: has("officecli") };
  if (allowOfficeProbe) {
    office = { ...office, available: false, message: "未探测" };
    try {
      const result = await officeProbe();
      office = {
        available: Boolean(result?.available),
        version: result?.version || null,
        message: result?.message || "",
        toolAvailable: has("officecli"),
      };
    } catch (error) {
      office = { available: false, version: null, message: `探测异常：${String(error?.message || error).slice(0, 120)}`, toolAvailable: has("officecli") };
    }
  }

  return {
    now: now.toISOString(),
    localTime: formatLocalTime(now),
    timeZone: (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
    })(),
    platform: process.platform,
    node: process.versions.node,
    workspace: probeWorkspace(workspace),
    shell,
    office,
    capabilities: {
      network: has("web_search") || has("web_fetch"),
      browser: hasPrefix("browser_"),
      map: hasPrefix("map_"),
      canvas: hasPrefix("canvas_"),
      chart: hasPrefix("chart_"),
      cad: has("cad_read") || has("cad_edit"),
      editorial: has("editorial_pipeline"),
      subagent: has("run_subagent"),
      team: has("team_spawn"),
    },
    tools: { count: tools.length },
    hint: "以上为只读事实；不要再为「能不能跑命令 / 能不能写 / Office 能不能用 / 现在几点」试错。",
  };
}

/** 工具输出的紧凑文本（模型侧阅读）。 */
export function renderEnvironmentFacts(facts) {
  try {
    return JSON.stringify(facts, null, 2);
  } catch {
    return "{}";
  }
}
