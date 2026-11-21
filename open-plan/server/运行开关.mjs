/**
 * 运行开关（优化项统一 feature flag 管道）。
 *
 * 评审 R8 约束：所有优化项的开关统一由本模块读取（env 解析 + 默认值 + 只读快照），
 * 禁止各业务模块直读 process.env，避免开关语义分叉；快照经 /api/status 下发前端。
 *
 * 开关语义：
 *   - 每个开关只影响对应优化项的新路径；off（默认）时代码路径与历史基线行为一致。
 *   - 取值：环境变量命中 "1"/"true"/"on"（不区分大小写）视为开启，其余视为关闭。
 *   - 优先级：**环境变量 > `.oaw/runtime-flags.json` > 代码默认值**。
 *   - 2026-11-19 起按用户决策：新功能开关全部默认打开（含 Qoder/Harness/BrowserAtomic
 *     三个族总开关）；OAW_VISUAL_EFFECTS_OFF 属降级开关仍默认关。任一开关可用 env 或
 *     配置文件显式 0/false/off 关闭回退。
 *   - 2026-11-19-002 起：快照收进 buildRuntimeFlags()，reloadRuntimeFlags() 支持设置页
 *     热更（GET/POST /api/runtime-flags）；「启动时解析一次、不热更」的旧约束被
 *     docs/plans/2026-11-19-002 方案与后续 ADR 取代，管道统一与优先级语义保留。
 *     过去只认启动进程的环境变量：服务重启、换一个终端/快捷方式启动，画布等能力就会
 *     "时有时无"（2026-11-11 实测：10:40 那次重启没带 OAW_CREATIVE_CANVAS → 画布消失）。
 *     `.oaw/` 已被 gitignore，配置文件属于本机用户选择，不进入仓库。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no"]);

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 测试可用 OAW_RUNTIME_FLAGS_FILE 指向临时文件，避免动到本机真实配置。
export const RUNTIME_FLAGS_FILE = process.env.OAW_RUNTIME_FLAGS_FILE
  ? path.resolve(String(process.env.OAW_RUNTIME_FLAGS_FILE))
  : path.join(ROOT_DIR, ".oaw", "runtime-flags.json");

/** OAW_CREATIVE_CANVAS → creativeCanvas：配置文件用语义名，可读性更好。 */
function envToFlagKey(name) {
  return String(name || "")
    .replace(/^OAW_/, "")
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

let persistedFlags = {};
let persistedFlagsLoaded = false;
function loadPersistedFlags() {
  if (persistedFlagsLoaded) return persistedFlags;
  persistedFlagsLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_FLAGS_FILE, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) persistedFlags = raw;
  } catch {
    // 文件缺失/损坏 = 没有持久开关，语义与历史一致
  }
  return persistedFlags;
}

/** 开关取值来源（用于 /api/status 诊断与"为什么这次是关的"排查）。 */
const flagSources = new Map();
function noteSource(name, source) {
  flagSources.set(envToFlagKey(name), source);
  return source;
}
export function flagSource(name) {
  return flagSources.get(envToFlagKey(name)) || "default";
}

function readFlag(name) {
  const raw = String(process.env?.[name] ?? "").trim().toLowerCase();
  if (raw) return noteSource(name, "env"), TRUTHY.has(raw);
  const stored = loadPersistedFlags()[envToFlagKey(name)];
  if (typeof stored === "boolean") return noteSource(name, "file"), stored;
  noteSource(name, "default");
  return false;
}

/**
 * 默认开启的开关：未设置环境变量时返回 defaultValue；
 * 显式 0/false/off 关闭，显式 1/true/on 开启，其它值回落默认值。
 */
export function readFlagDefault(name, defaultValue = true) {
  const raw = String(process.env?.[name] ?? "").trim().toLowerCase();
  if (raw) {
    noteSource(name, "env");
    if (TRUTHY.has(raw)) return true;
    if (FALSY.has(raw)) return false;
    return defaultValue;
  }
  const stored = loadPersistedFlags()[envToFlagKey(name)];
  if (typeof stored === "boolean") return noteSource(name, "file"), stored;
  noteSource(name, "default");
  return defaultValue;
}

/**
 * 读取一个显式关闭值（"0"/"off"/"false"/"no"）：用于"默认开、env 可退出"的开关。
 * 统一走 readFlagDefault，保证「默认开、显式可退出」只有一处语义来源。
 */
function readOffFlag(name) {
  return !readFlagDefault(name, true);
}

function readPositiveInt(name, fallback) {
  const raw = Number.parseInt(String(process.env?.[name] ?? ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** 逗号/分号分隔的字符串列表（B5 域名白名单等配置型开关）。 */
function readStringList(name) {
  return String(process.env?.[name] ?? "")
    .split(/[,，;；\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 只读快照构建（2026-11-19-002 阶段1 热更改造）。
 *
 * 原为模块加载期 `export const RUNTIME_FLAGS = Object.freeze({...})` 一次性求值（服务生命周期内不热更）；
 * 现收进本函数，RUNTIME_FLAGS 绑定改 let，`reloadRuntimeFlags()` 可重建快照（设置页热更）。
 * 各开关行与其注释逐字保留，仅求值时机从「加载一次」变为「构建/热更时」；
 * 优先级语义不变：环境变量 > `.oaw/runtime-flags.json` > 代码默认值。
 */
function buildRuntimeFlags() {
  /* ===== Qoder 对标优化开关族（报告：Qoder对标评审与交通规划Harness方案）=====
     全部默认关 = 与历史基线行为完全一致；OAW_QODER_ALIGN=1 可一键打开整族用于预览，
     关掉即整体回滚，无需改代码、无残留。 */
  const QODER_ALIGN = readFlagDefault("OAW_QODER_ALIGN", true);
  /* ===== ZCode Harness 对标开关族（计划 2026-10-27-004）=====
     全部默认关 = 与历史基线行为一致；OAW_HARNESS_ALIGN=1 可一键打开整族用于预览，
     关掉即整体回滚。任一单项开关也可独立打开。 */
  const HARNESS_ALIGN = readFlagDefault("OAW_HARNESS_ALIGN", true);

  /* 浏览器原子操作族开关（Proma 对标）：默认全关 = 与历史基线行为完全一致；
     OAW_BROWSER_ATOMIC=1 可一键打开整族，关掉即整体回滚，无需改代码、无残留。 */
  const BROWSER_ATOMIC = readFlagDefault("OAW_BROWSER_ATOMIC", true);

  return Object.freeze({
  /** 运行预算：默认无上限（不再按 25/45 回合、80/160 工具、45/90 分钟强制收尾）。
      显式 OAW_RUN_BUDGET_UNLIMITED=0 可恢复旧的限额行为。 */
  runBudgetUnlimited: readFlagDefault("OAW_RUN_BUDGET_UNLIMITED", true),
  /** 目标空闲自动推进（2026-11-19-010 P2，默认关）。开启后目标未达成时按冷却自动续轮；
      任何来源的 cancelled 都不推进，连续无进展两轮或失败三次即停并标记 blocked。 */
  goalAutoContinue: readFlagDefault("OAW_GOAL_AUTO_CONTINUE", false),
  /** 自动推进的全局轮次硬顶（goal.maxTurns 优先；0 = 用本值）。 */
  goalMaxRounds: readPositiveInt("OAW_GOAL_MAX_ROUNDS", 10),
  /** 同一操作连续失败多少次停手（2026-11-19-010 P1，默认 3）。
      第 N-1 次只提醒（放行），第 N 次硬停；破坏性工具另有更严的 2 次阈值（常量，不受此开关影响）。 */
  toolFailureLimit: readPositiveInt("OAW_TOOL_FAILURE_LIMIT", 3),
  /** 写作路由回合预算（2026-11-08 D0-6，默认关）：开启后写作路由使用软 30 / 硬 60 回合，
      并关闭每 6 轮进度播报；其它路由行为不变。 */
  writingBudget: readFlagDefault("OAW_WRITING_BUDGET", true),
  /** ask 默认假设（2026-11-08 D0-7，默认关）：开启后澄清/预览类提问超时缩短为
      askAssumeTimeoutMs，并按模型给出的 assumption 继续；高风险 confirm 不受影响。 */
  askAssumption: readFlagDefault("OAW_ASK_ASSUMPTION", true),
  /** ask 默认假设的等待窗口（毫秒，默认 90 秒；仅 askAssumption 开启时生效）。 */
  askAssumeTimeoutMs: readPositiveInt("OAW_ASK_ASSUME_TIMEOUT_MS", 90_000),
  /** 技能依赖安装（2026-11-08 D1，默认关）：开启后允许用户在技能广场点击「安装依赖」
      写入 `<workspace>/.oaw/skill-deps/`；关闭时只读预检仍可用，安装/卸载接口返回 403。
      Agent 侧任何时候都不得自动安装。 */
  skillDeps: readFlagDefault("OAW_SKILL_DEPS", true),
  /** 人机协作中枢（2026-11-08 D2，默认关）：开启后前端用 InteractionDock/卡片渲染
      由 `/api/interactions` 与 interaction_* 事件驱动的统一交互；关闭时走既有 ask 卡/审批卡路径。 */
  interactionHub: readFlagDefault("OAW_INTERACTION_HUB", true),
  /** 输入区统一面板（2026-11-08 D3，默认关）：开启后 `/ @ # &` 合并为单一候选面板、
      引用 chip 三态、`/` 命令选中即执行；关闭时保持既有四触发器行为。 */
  composerUnified: readFlagDefault("OAW_COMPOSER_UNIFIED", true),
  /** 写作一次成稿（2026-11-08 D4，默认关）：开启后写作路由默认「Markdown 直通 → 预览即终稿」，
      不再要求独立大纲/草稿确认轮，并使用批处理排版与一次验收。 */
  writingOneShot: readFlagDefault("OAW_WRITING_ONESHOT", true),
  /** 写作路由精简上下文（2026-11-08 D5，默认关）：写作路由只注入写作/文档/排版/图表类技能，
      目录预算降到 4KB，降低每轮上下文与 TTFT。 */
  writingLeanContext: readFlagDefault("OAW_WRITING_LEAN_CONTEXT", true),
  /** 专家团队按需触发（2026-11-09，默认开；用户 2026-11-09 拍板）：能力计划对复杂任务给出
      team.suggested + 提示词建议；模型仍可拒绝。OAW_TEAM_SUGGEST=0 可整体回退。 */
  teamSuggest: readFlagDefault("OAW_TEAM_SUGGEST", true),
  /** 团队组队护栏（默认开）：非 required 模式下，没有可认领任务时阻断 team_spawn；
      OAW_TEAM_GUARD=0 可回退。 */
  teamGuard: readFlagDefault("OAW_TEAM_GUARD", true),
  /** /team 显式入口（默认开）：输入区 /team 置 teamIntent=required；OAW_TEAM_REQUIRED_ENTRY=0 隐藏/拒绝。 */
  teamRequiredEntry: readFlagDefault("OAW_TEAM_REQUIRED_ENTRY", true),
  /** 后台任务：长工具调用超过阈值自动转后台（默认开，OAW_BACKGROUND_JOBS=0 可关）。 */
  backgroundJobs: readFlagDefault("OAW_BACKGROUND_JOBS", true),
  /** U2+U6：Pi 把关扩展（ToolCallEvent 单工具拦截 + 压缩生命周期事件增强） */
  piToolGateExtension: readFlagDefault("OAW_PI_TOOL_GATE", true),
  /** U5：bash 侧车执行（operations 派发到子进程） */
  piBashSidecar: readFlagDefault("OAW_PI_SIDECAR", true),
  /** U8：事件规范化管道（normalizePiEvent 接入 emit 前置） */
  eventNormalize: readFlagDefault("OAW_EVENT_NORMALIZE", true),
  /** U9：新工作区首次打开信任位（ProjectTrustStore 薄封装） */
  projectTrustGate: readFlagDefault("OAW_PROJECT_TRUST_GATE", true),
  /** U10：供应商提示词缓存保活（Pi 原生 CacheWarmer，streaming 模式：Run 进行中保活） */
  cacheWarming: readFlagDefault("OAW_CACHE_WARMING", true),
  /** U5 侧车空闲回收时间（毫秒，默认 10 分钟） */
  piBashSidecarIdleMs: readPositiveInt("OAW_PI_SIDECAR_IDLE_MS", 10 * 60 * 1000),
  /** 交互优化 P1：staged 产物在任务运行中即对产物面板可见（默认关：保持 run_finished 后可见） */
  stagedVisible: readFlagDefault("OAW_STAGED_VISIBLE", true),
  /** 交互优化 P2：run_finished 智能自动切产物页签（默认关） */
  autoTab: readFlagDefault("OAW_AUTO_TAB", true),
  /** 交互优化 P3：浏览器手关后对话侧活动徽标（默认关） */
  browserBadge: readFlagDefault("OAW_BROWSER_BADGE", true),
  /** 交互优化 P7：窄屏开浏览器记忆/恢复预览栏状态（默认关） */
  narrowRestore: readFlagDefault("OAW_NARROW_RESTORE", true),
  /** 交互优化 P8：浏览器帧流重连中与工具成功的对账提示（默认关） */
  reconcileHint: readFlagDefault("OAW_RECONCILE_HINT", true),
  /** 前端反馈基座：toast/confirmDialog 替代原生 alert/confirm（默认关=原生回退） */
  feedbackV2: readFlag("OAW_FEEDBACK_V2"),
  /** 浏览器 B3：面板不可见时自适应/暂停 screencast 推流（默认关） */
  browserAdaptiveStream: readFlagDefault("OAW_BROWSER_ADAPTIVE_STREAM", true),
  /** 浏览器 B4：整页截图与 PDF 导出底座（默认关） */
  browserFullpage: readFlagDefault("OAW_BROWSER_FULLPAGE", true),
  /** 浏览器 B5：导航 URL 防护（file:// 拒绝 + 域名白名单，默认关） */
  browserUrlGuard: readFlagDefault("OAW_BROWSER_URL_GUARD", true),
  /** B5 白名单配置：域名列表（留空 = 放行全部 http/https；子域名自动匹配） */
  browserUrlAllowlist: readStringList("OAW_BROWSER_URL_ALLOWLIST"),
  /* ===== 浏览器原子操作（Proma 对标，默认全关；OAW_BROWSER_ATOMIC=1 一键开启整族）===== */
  /** 族开关：浏览器原子操作（等待 / 点击并等待 / 容器滚动 / 区域抽取 / 原生下拉） */
  browserAtomic: BROWSER_ATOMIC,
  /** 原子 A1：按 URL 片段/可见文本/CSS 选择器等待（默认关） */
  browserWaitFor: readFlagDefault("OAW_BROWSER_WAIT_FOR", true) || BROWSER_ATOMIC,
  /** 原子 A2：点击并等待（点击 ref 与等待条件合并为一次串行调用，默认关） */
  browserAct: readFlagDefault("OAW_BROWSER_ACT", true) || BROWSER_ATOMIC,
  /** 原子 A3：内部滚动容器滚动 + 前后滚动指标（默认关） */
  browserScrollContainer: readFlagDefault("OAW_BROWSER_SCROLL_CONTAINER", true) || BROWSER_ATOMIC,
  /** 原子 A4：区域正文抽取（text / 基础 Markdown，默认关） */
  browserExtract: readFlagDefault("OAW_BROWSER_EXTRACT", true) || BROWSER_ATOMIC,
  /** 原子 A5：原生 <select> 选项选择（默认关） */
  browserSelectOption: readFlagDefault("OAW_BROWSER_SELECT_OPTION", true) || BROWSER_ATOMIC,
  /* ===== 子代理增强（Proma 对标，默认全关）===== */
  /** 子代理 A1：委派幂等缓存（同一 toolCallId 重放只执行一次，默认关） */
  subagentIdempotent: readFlagDefault("OAW_SUBAGENT_IDEMPOTENT", true),
  /** 子代理 A2：阻塞事件冒泡（子代理等待审批时向父事件流冒泡 blocked/unblocked，默认关） */
  subagentBlockedBubble: readFlagDefault("OAW_SUBAGENT_BLOCKED_BUBBLE", true),
  /** 会话恢复 A3：busy 看门狗（busy 期间超时无 Pi 事件活动则强制放行，默认关） */
  agentBusyWatchdog: readFlagDefault("OAW_BUSY_WATCHDOG", true),
  /** A3 阈值：busy 无事件活动多久后放行（毫秒，默认 15 分钟） */
  agentBusyWatchdogMs: readPositiveInt("OAW_BUSY_WATCHDOG_MS", 15 * 60 * 1000),
  /** 会话恢复 A2：恢复遇忙时前端自动等待任务结束后重试（默认关） */
  resumeAutoRetry: readFlagDefault("OAW_RESUME_AUTO_RETRY", true),
  /** GIS G1：空间分析算子（buffer/spatial_filter/bbox_clip，默认关） */
  spatialAnalysis: readFlagDefault("OAW_SPATIAL_ANALYSIS", true),
  /** GIS G8：地图分析报告一键成文（/api/map/report + 面板按钮，默认开启；OAW_MAP_REPORT=0 关闭） */
  mapReport: readFlagDefault("OAW_MAP_REPORT", true),
  /** GIS G7：批量导出队列（多项目×多图层×多尺寸×PNG/PDF，默认开启；OAW_MAP_EXPORT=0 关闭） */
  mapExport: readFlagDefault("OAW_MAP_EXPORT", true),
  /** GIS G2：外部数据适配器（live-traffic-api / sql-database，默认关） */
  dataAdapters: readFlagDefault("OAW_DATA_ADAPTERS", true),
  /** GIS G3：高德 MCP 桥（mcp.amap.com 官方 ?key= 协议豁免 + 预置模板，默认关） */
  amapMcpBridge: readFlagDefault("OAW_AMAP_MCP_BRIDGE", true),
  /** GIS G9：地图项目打包 zip 归档导出（默认开启；OAW_MAP_PACK=0 关闭） */
  mapPack: readFlagDefault("OAW_MAP_PACK", true),
  /** GIS G5：场景化分析模板（v1 仅 OD 通勤分析，默认开启；OAW_MAP_TEMPLATES=0 关闭） */
  mapTemplates: readFlagDefault("OAW_MAP_TEMPLATES", true),
  /** GIS G10-v1：视图书签（视角收藏与一键恢复，默认开启；OAW_MAP_BOOKMARKS=0 关闭） */
  mapBookmarks: readFlagDefault("OAW_MAP_BOOKMARKS", true),
  /** 会话恢复 A4：运行中刷新恢复（冷启动探测 LIVE Run + Run 起点整段回放 + 恢复内容新建气泡，默认关） */
  replayRecover: readFlagDefault("OAW_REPLAY_RECOVER", true),
  /** 会话流 v3：行式过程区 + 运行扫光 + 折叠位置补偿（计划 2026-11-14-001；2026-11-19 起随 ADR 0043 默认开，且常驻设置页可切换，ADR 0042） */
  transcriptV3: readFlagDefault("OAW_TRANSCRIPT_V3", true),
  /** Qoder 对标总开关：打开后整族优化项生效（默认关；关掉即整体回滚） */
  qoderAlign: QODER_ALIGN,
  /** Qoder P0-1：SSE 重连退避加入抖动与退避上限放宽（默认关 = 基线固定倍增 500ms→5s 封顶） */
  qoderSseBackoff: readFlagDefault("OAW_QODER_SSE_BACKOFF", true) || QODER_ALIGN,
  /** Qoder P0-4：Qoder/Codex 视觉令牌层（默认关 = pi-dark 基线配色；打开即整站换色，关掉零残留） */
  qoderStyle: readFlagDefault("OAW_QODER_STYLE", true) || QODER_ALIGN,
  /** Qoder P0-2：对话流有界有序背压（默认关 = 基线直接 res.write，写不进去时由 Node 内部无上限缓冲） */
  qoderSseBackpressure: readFlagDefault("OAW_QODER_SSE_BACKPRESSURE", true) || QODER_ALIGN,
  /** Qoder P0-2 队列上限（字节，默认 4 MiB）：排队字节超过即收束连接，交由重连回放补齐 */
  qoderSseQueueMaxBytes: readPositiveInt("OAW_QODER_SSE_QUEUE_MAX_BYTES", 4 * 1024 * 1024),
  /** Qoder P0-3：中断后残余消息排空（默认关 = 基线立即发 aborted，不等在途消息） */
  qoderDrainOnAbort: readFlagDefault("OAW_QODER_DRAIN_ON_ABORT", true) || QODER_ALIGN,
  /** Qoder P0-3 排空上限（毫秒，默认 1500）：超过即强制发 aborted，避免中断收尾被无限拖长 */
  qoderDrainMaxMs: readPositiveInt("OAW_QODER_DRAIN_MAX_MS", 1500),
  /** Qoder P0-3 静默判定（毫秒，默认 300）：通道持续静默这么久即视为在途消息已排空 */
  qoderDrainQuietMs: readPositiveInt("OAW_QODER_DRAIN_QUIET_MS", 300),
  /* ===== P2 打磨层（均为配置型开关，不设环境变量时行为与基线完全一致）===== */
  /** P2-2：对话流 SSE 心跳间隔（毫秒，默认 = 基线 5000；前端看门狗会按它派生） */
  heartbeatChatMs: readPositiveInt("OAW_HEARTBEAT_CHAT_MS", 5000),
  /** P2-2：事件流 SSE 心跳间隔（毫秒，默认 = 基线 15000） */
  heartbeatEventsMs: readPositiveInt("OAW_HEARTBEAT_EVENTS_MS", 15000),
  /** P2-2：浏览器帧流心跳间隔（毫秒，默认 = 基线 15000） */
  heartbeatBrowserMs: readPositiveInt("OAW_HEARTBEAT_BROWSER_MS", 15000),
  /** P2-4：视觉特效降级（默认关 = 保留背景模糊与动画；打开则去模糊、去长动效） */
  visualEffectsOff: readFlag("OAW_VISUAL_EFFECTS_OFF"),
  /** P2-1：SSE 事件缺号告警（默认关 = 不记录游标跳变；打开则在缺号时记入长连接诊断） */
  qoderSeqGapAlert: readFlagDefault("OAW_QODER_SEQ_GAP_ALERT", true) || QODER_ALIGN,
  /* ===== P1 架构收口（可开关化部分）===== */
  /** P1-5：服务端按 path 的连接配额（默认关 = 不检查，行为与基线一致；打开则超限返回 503 + Retry-After） */
  streamQuota: readFlagDefault("OAW_STREAM_QUOTA", true) || QODER_ALIGN,
  /** P1-5 拒绝时的 Retry-After 秒数（默认 5） */
  streamQuotaRetryAfterSeconds: readPositiveInt("OAW_STREAM_QUOTA_RETRY_AFTER_S", 5),
  /** P1-2：事件负载结构校验（默认关 = 不校验；打开则只告警并计数，不改变落盘与投递行为） */
  eventSchemaCheck: readFlagDefault("OAW_EVENT_SCHEMA_CHECK", true) || QODER_ALIGN,
  /** P1-8：右侧对象栏（本轮对象聚合：产出/来源/技能与 MCP/网页查阅/记忆 + 环境信息 + 后台进程） */  qoderObjectBar: readFlagDefault("OAW_QODER_OBJECT_BAR", true) || QODER_ALIGN,
  /** §4：声明式交通规划领域工作流（注册表 + 六个声明 + preflight 硬约束，默认关 = 不加载也不下发） */
  domainWorkflows: readFlagDefault("OAW_DOMAIN_WORKFLOWS", true) || QODER_ALIGN,
  /** Qoder P0-2：超大 tool_output 单帧切分（默认关 = 原样单帧下发，与基线逐字一致） */
  qoderToolOutputSplit: readFlagDefault("OAW_QODER_TOOL_OUTPUT_SPLIT", true) || QODER_ALIGN,
  /** Qoder P0-2 单帧上限（字节，默认 256 KiB）：超过即切为 tool_output_delta 增量帧 */
  qoderToolOutputFrameMaxBytes: readPositiveInt("OAW_QODER_TOOL_OUTPUT_FRAME_MAX_BYTES", 256 * 1024),
  /** P1-4：交互（HITL）归属——ask_user / tool_approval_request 载荷附带 owner{kind,id}（默认关 = 载荷与基线逐字一致） */
  qoderInteractionOwner: readFlagDefault("OAW_QODER_INTERACTION_OWNER", true) || QODER_ALIGN,
  /** Office 写作规范层：模板路由 / 场景参数 / 版式令牌 / 规则闸门（默认关 = 旧行为逐字一致） */
  officeFormat: readFlagDefault("OAW_OFFICE_FORMAT", true),
  /* ===== CAD 能力（2026-10-21 方案评审通过：DXF/DWG 预览 + agent 读取/修改）===== */
  /** CAD 预览：DXF/DWG 进文件树白名单 + /api/doc 预览分支 + CadViewer。
      2026-11-06 起默认开（纯只读 SVG 渲染，用户反馈「图纸点不开」；OAW_CAD_PREVIEW=0 可整体回退基线）。 */
  cadPreview: readFlagDefault("OAW_CAD_PREVIEW", true),
  /** CAD agent 能力：documentRead 读取 CAD + cad_read/cad_edit 工具（默认关，写能力保留显式开启） */
  cadAgent: readFlagDefault("OAW_CAD_AGENT", true),

  /* ===== 创作画布（2026-11-09 计划 2026-11-09-003）===== */
  /** 创作画布：可编辑设计画布（画板/对象编辑、SVG/PNG/PDF/PPTX 导出、canvas_* 工具）。
      2026-11-19 起随 ADR 0043 默认开（此前默认关）；OAW_CREATIVE_CANVAS=0 可整体回退基线。 */
  creativeCanvas: readFlagDefault("OAW_CREATIVE_CANVAS", true),

  /* ===== 图表工作台（2026-11-19 计划 2026-11-19-001，ADR 0041）===== */
  /** 图表工作台：数据表 + ECharts 交互图表 + 展板（chart_* / board_* / data_* 工具）。
      按 ADR 0043 约定默认开；OAW_CHART_WORKBENCH=0 可整体回退基线。 */
  chartWorkbench: readFlagDefault("OAW_CHART_WORKBENCH", true),

  /* ===== ZCode Harness 对标开关族（默认全关）===== */
  /** 总开关：一键打开 H 线整族（仅测试/预览；关闭即整体回滚） */
  harnessAlign: HARNESS_ALIGN,
  /** H1-1 工具能力元数据校验与读取 */
  toolMetadata: readFlagDefault("OAW_TOOL_METADATA", true) || HARNESS_ALIGN,
  /** H1-2 权限决策返回 ruleId 并记录审计 */
  permissionAudit: readFlagDefault("OAW_PERMISSION_AUDIT", true) || HARNESS_ALIGN,
  /** H1-2 allow 决策是否也逐次记录（默认只记 ask/deny） */
  permissionAuditAllow: readFlagDefault("OAW_PERMISSION_AUDIT_ALLOW", true) || HARNESS_ALIGN,
  /** H1-3 超阈值工具结果外置 */
  toolResultArtifact: readFlagDefault("OAW_TOOL_RESULT_ARTIFACT", true) || HARNESS_ALIGN,
  /** H1-3 外置阈值（字节，默认 30KB） */
  /** 2026-11-19-010 P3.1b：新产生的工具结果超过该字节数即落盘、只给模型预览。
      默认从 30KB 下调到 16KB（有效阈值仍取 min(每工具预算, 本值)，见工具元数据）；
      显式 OAW_TOOL_RESULT_MAX_BYTES 可改回。 */
  toolResultMaxBytes: readPositiveInt("OAW_TOOL_RESULT_MAX_BYTES", 16 * 1024),
  /** H1-4 用量归集 */
  usageLedger: readFlagDefault("OAW_USAGE_LEDGER", true) || HARNESS_ALIGN,
  /** H2-1 记忆语义召回 */
  memoryRecall: readFlagDefault("OAW_MEMORY_RECALL", true) || HARNESS_ALIGN,
  /** H2-1 召回注入上限（字节，默认 60KB） */
  memoryRecallMaxBytes: readPositiveInt("OAW_MEMORY_RECALL_MAX_BYTES", 60 * 1024),
  /** H2-2 记忆自动抽取 */
  memoryExtract: readFlagDefault("OAW_MEMORY_EXTRACT", true) || HARNESS_ALIGN,
  /** H2-3 上下文分段组装 */
  contextSections: readFlagDefault("OAW_CONTEXT_SECTIONS", true) || HARNESS_ALIGN,
  /** H2-4 Skill 注入块与预算 */
  skillInjection: readFlagDefault("OAW_SKILL_INJECTION", true) || HARNESS_ALIGN,
  /** H2-4 Skill 注入上限（字节，默认 20KB） */
  skillInjectionMaxBytes: readPositiveInt("OAW_SKILL_INJECTION_MAX_BYTES", 20 * 1024),
  /** H3-1 声明式 Hook 事件层 */
  hookEvents: readFlagDefault("OAW_HOOK_EVENTS", true) || HARNESS_ALIGN,
  /** H3-1 Hook 默认超时（毫秒，默认 3s） */
  hookTimeoutMs: readPositiveInt("OAW_HOOK_TIMEOUT_MS", 3000),
  /** H3-2 子代理 profile 快照与后台/计量 */
  subagentProfile: readFlagDefault("OAW_SUBAGENT_PROFILE", true) || HARNESS_ALIGN,
  /** H3-3 统一工具错误 envelope */
  toolErrorEnvelope: readFlagDefault("OAW_TOOL_ERROR_ENVELOPE", true) || HARNESS_ALIGN,
  /** H3-4 配置来源与资源发现诊断 */
  configSource: readFlagDefault("OAW_CONFIG_SOURCE", true) || HARNESS_ALIGN,
  /** H4-2 工作流阶段 journal 与幂等重跑 */
  workflowJournal: readFlagDefault("OAW_WORKFLOW_JOURNAL", true) || HARNESS_ALIGN,
  /** H4-3 插件清单与完整性校验 */
  pluginManifest: readFlagDefault("OAW_PLUGIN_MANIFEST", true) || HARNESS_ALIGN,
  /** H4-4 计划文件持久化（不做 PlanMode） */
  planPersistence: readFlagDefault("OAW_PLAN_PERSISTENCE", true) || HARNESS_ALIGN,
  /** H4-5 观测导出 */
  observabilityExport: readFlagDefault("OAW_OBSERVABILITY_EXPORT", true) || HARNESS_ALIGN,
});
}

/** 进程内唯一事实：绑定用 let（ESM live binding），热更后所有 import 方可见新快照。 */
export let RUNTIME_FLAGS = buildRuntimeFlags();

/**
 * 热更入口（2026-11-19-002 阶段1）：重置持久化缓存并重建快照。
 * env 优先级语义不变（进程内 env 不变，重建后生效面变化来自 file/default）；
 * 调用方：设置页 POST /api/runtime-flags（server/index.mjs）。
 */
export function reloadRuntimeFlags() {
  persistedFlags = {};
  persistedFlagsLoaded = false;
  RUNTIME_FLAGS = buildRuntimeFlags();
  return RUNTIME_FLAGS;
}

/** 开关取值来源快照（语义名 → "env"|"file"|"default"）：设置页来源徽标与冲突提示用。 */
export function runtimeFlagSourcesSnapshot() {
  return Object.fromEntries(flagSources.entries());
}

/**
 * 设置页可编辑开关白名单（2026-11-19-002 §5）：语义名 + 展示元数据，POST /api/runtime-flags
 * 只接受本清单内的键。group: "常用"（默认展开）| "高级"（默认折叠）。
 *   confirmOnDisable: 关闭前需应用内二次确认（护栏 / 族总开关）。
 *   reverse: 反向语义（开 = 去能力/降级），UI 单独标注。
 *   restartRequired: 写盘生效但需重启服务（模块级注册无法运行中卸载，见 index.mjs 数据适配器注册）。
 */
export const USER_EDITABLE_FLAGS = Object.freeze([
  // ---- 常用组（默认展开）----
  { key: "creativeCanvas", env: "OAW_CREATIVE_CANVAS", group: "常用", label: "创作画布", description: "画板/对象编辑，SVG/PNG/PDF/PPTX 导出" },
  { key: "cadPreview", env: "OAW_CAD_PREVIEW", group: "常用", label: "CAD 图纸预览", description: "DXF/DWG 进文件树并只读渲染" },
  { key: "cadAgent", env: "OAW_CAD_AGENT", group: "常用", label: "CAD agent 能力", description: "agent 读取/修改图纸（cad_read/cad_edit）" },
  { key: "transcriptV3", env: "OAW_TRANSCRIPT_V3", group: "常用", label: "会话流 v3", description: "行式过程区 + 运行扫光 + 折叠位置补偿" },
  { key: "qoderStyle", env: "OAW_QODER_STYLE", group: "常用", label: "Qoder 视觉层", description: "Qoder/Codex 视觉令牌（整站换肤）" },
  { key: "qoderObjectBar", env: "OAW_QODER_OBJECT_BAR", group: "常用", label: "右侧对象栏", description: "本轮对象聚合（产出/来源/技能与 MCP/记忆）" },
  { key: "visualEffectsOff", env: "OAW_VISUAL_EFFECTS_OFF", group: "常用", label: "视觉特效降级", description: "开启 = 去背景模糊与长动效（低性能机）", reverse: true },
  { key: "interactionHub", env: "OAW_INTERACTION_HUB", group: "常用", label: "统一交互中枢", description: "InteractionDock/卡片渲染的统一人机交互" },
  { key: "composerUnified", env: "OAW_COMPOSER_UNIFIED", group: "常用", label: "输入区统一面板", description: "/ @ # & 合并为单一候选面板，/ 命令选中即执行" },
  { key: "writingOneShot", env: "OAW_WRITING_ONESHOT", group: "常用", label: "写作一次成稿", description: "Markdown 直通 → 预览即终稿，不再要求大纲/草稿确认轮" },
  { key: "skillDeps", env: "OAW_SKILL_DEPS", group: "常用", label: "技能依赖安装", description: "技能广场可写入 <workspace>/.oaw/skill-deps/" },
  { key: "teamSuggest", env: "OAW_TEAM_SUGGEST", group: "常用", label: "专家团队按需触发", description: "复杂任务给出 team.suggested 建议（模型可拒绝）" },
  { key: "spatialAnalysis", env: "OAW_SPATIAL_ANALYSIS", group: "常用", label: "空间分析算子", description: "buffer/spatial_filter/bbox_clip" },
  { key: "mapReport", env: "OAW_MAP_REPORT", group: "常用", label: "地图分析报告", description: "一键成文（/api/map/report + 面板按钮）" },
  { key: "mapExport", env: "OAW_MAP_EXPORT", group: "常用", label: "地图批量导出", description: "多项目×多图层×多尺寸×PNG/PDF 队列" },
  { key: "mapTemplates", env: "OAW_MAP_TEMPLATES", group: "常用", label: "场景化分析模板", description: "v1 OD 通勤分析确定性编排" },
  { key: "mapBookmarks", env: "OAW_MAP_BOOKMARKS", group: "常用", label: "地图视图书签", description: "视角收藏与一键恢复" },
  // ---- 高级组（默认折叠）----
  { key: "teamGuard", env: "OAW_TEAM_GUARD", group: "高级", label: "组队护栏", description: "无可认领任务时阻断 team_spawn", confirmOnDisable: true },
  { key: "teamRequiredEntry", env: "OAW_TEAM_REQUIRED_ENTRY", group: "高级", label: "/team 显式入口", description: "输入区 /team 置 required 意图", confirmOnDisable: true },
  { key: "browserUrlGuard", env: "OAW_BROWSER_URL_GUARD", group: "高级", label: "导航 URL 防护", description: "file:// 拒绝 + 域名白名单", confirmOnDisable: true },
  { key: "runBudgetUnlimited", env: "OAW_RUN_BUDGET_UNLIMITED", group: "高级", label: "运行预算无上限", description: "关闭 = 恢复按回合/工具/分钟的旧限额", confirmOnDisable: true, reverse: true },
  { key: "qoderAlign", env: "OAW_QODER_ALIGN", group: "高级", label: "Qoder 对标整族", description: "族总开关：SSE 背压/排空/配额/对象栏等", confirmOnDisable: true },
  { key: "harnessAlign", env: "OAW_HARNESS_ALIGN", group: "高级", label: "ZCode Harness 整族", description: "族总开关：记忆召回/Hook 事件/工作流 journal 等", confirmOnDisable: true },
  { key: "browserAtomic", env: "OAW_BROWSER_ATOMIC", group: "高级", label: "浏览器原子操作整族", description: "族总开关：等待/点击并等待/容器滚动/区域抽取/原生下拉", confirmOnDisable: true },
  { key: "writingLeanContext", env: "OAW_WRITING_LEAN_CONTEXT", group: "高级", label: "写作精简上下文", description: "写作路由只注入写作类技能，目录预算 4KB" },
  { key: "writingBudget", env: "OAW_WRITING_BUDGET", group: "高级", label: "写作回合预算", description: "软 30 / 硬 60 回合，关闭每 6 轮进度播报" },
  { key: "askAssumption", env: "OAW_ASK_ASSUMPTION", group: "高级", label: "ask 默认假设", description: "澄清类提问超时后按模型假设继续（高风险 confirm 不受影响）" },
  { key: "officeFormat", env: "OAW_OFFICE_FORMAT", group: "高级", label: "Office 写作规范层", description: "模板路由/版式令牌/规则闸门（仅写作路由通电，ADR 0012）" },
  { key: "domainWorkflows", env: "OAW_DOMAIN_WORKFLOWS", group: "高级", label: "领域工作流", description: "声明式交通规划工作流注册表 + preflight 硬约束" },
  { key: "mapPack", env: "OAW_MAP_PACK", group: "高级", label: "地图项目打包导出", description: "zip 归档导出" },
  { key: "dataAdapters", env: "OAW_DATA_ADAPTERS", group: "高级", label: "外部数据适配器", description: "live-traffic-api / sql-database（模块级注册，重启后生效）", restartRequired: true },
  { key: "amapMcpBridge", env: "OAW_AMAP_MCP_BRIDGE", group: "高级", label: "高德 MCP 桥", description: "mcp.amap.com 官方 ?key= 协议豁免 + 预置模板" },
  { key: "replayRecover", env: "OAW_REPLAY_RECOVER", group: "高级", label: "运行中刷新恢复", description: "冷启动探测 LIVE Run + 整段回放到新气泡" },
  { key: "resumeAutoRetry", env: "OAW_RESUME_AUTO_RETRY", group: "高级", label: "恢复遇忙自动重试", description: "恢复遇忙时前端等待任务结束自动重试" },
  { key: "agentBusyWatchdog", env: "OAW_BUSY_WATCHDOG", group: "高级", label: "busy 看门狗", description: "busy 超时无事件活动则强制放行（默认 15 分钟）" },
  { key: "stagedVisible", env: "OAW_STAGED_VISIBLE", group: "高级", label: "staged 产物即见", description: "任务运行中即对产物面板可见" },
  { key: "autoTab", env: "OAW_AUTO_TAB", group: "高级", label: "智能切产物页签", description: "run_finished 后自动切到新产物页签" },
  { key: "browserBadge", env: "OAW_BROWSER_BADGE", group: "高级", label: "浏览器活动徽标", description: "浏览器手关后对话侧活动提示" },
  { key: "narrowRestore", env: "OAW_NARROW_RESTORE", group: "高级", label: "窄屏预览栏恢复", description: "窄屏开浏览器记忆/恢复预览栏状态" },
  { key: "reconcileHint", env: "OAW_RECONCILE_HINT", group: "高级", label: "帧流对账提示", description: "浏览器帧流重连中与工具成功的对账提示" },
  { key: "browserAdaptiveStream", env: "OAW_BROWSER_ADAPTIVE_STREAM", group: "高级", label: "自适应推流", description: "面板不可见时自适应/暂停 screencast 推流" },
  { key: "browserFullpage", env: "OAW_BROWSER_FULLPAGE", group: "高级", label: "整页截图与 PDF", description: "浏览器整页截图与 PDF 导出底座" },
  { key: "goalAutoContinue", env: "OAW_GOAL_AUTO_CONTINUE", group: "高级", label: "目标自动推进", description: "目标未达成且会话空闲时自动续轮（默认关；连续无进展或取消即停）" },
]);

/**
 * Office 写作闸门的唯一判定（ADR 0012）。
 *
 * 背景：写作能力（模板路由 / 场景参数 / 版式令牌 / 规则闸门 / 澄清闸门 / 执行闸门）
 * 在 2026-10-27～28 已完整落地，但启用条件是全局开关 `OAW_OFFICE_FORMAT`，出厂即关。
 * 实测 run_05198175 证实：闸门断电时模型完全不知道存在编辑流水线与澄清闸门，
 * 改用 officecli 裸命令试探，88 次工具调用 20 次失败（23%）、55 回合、0 产物。
 *
 * 因此把启用条件从"全局开关"收窄为"路由"：只在真正要写文档的场景通电，
 * 非写作路由与基线逐字一致；`OAW_OFFICE_FORMAT=off` 显式退出即回退。
 *
 * @param {string} route 四路由之一：template / edit / generate / read
 * @param {string} mode  任务模式：agent / chat / review
 * @returns {boolean} 是否启用 Office 写作闸门
 */
export function officeGateActiveFor(route = "", mode = "agent") {
  // 显式退出优先于任何路由判断（ADR 0012 §4 的回滚路径）。
  if (readOffFlag("OAW_OFFICE_FORMAT")) return false;
  const r = String(route || "").trim();
  const m = String(mode || "agent").trim();
  // 只有"要写文档"的路由才通电：模板写作与新生成。
  if (r !== "template" && r !== "generate") return false;
  // Chat 与 Review 是只读模式，任何情况下都不通电。
  if (m === "chat" || m === "review") return false;
  return true;
}

/** /api/status 下发形态：布尔与数值分开，前端只读布尔位。 */
export function runtimeFlagsSnapshot() {
  return {
    piToolGateExtension: RUNTIME_FLAGS.piToolGateExtension,
    piBashSidecar: RUNTIME_FLAGS.piBashSidecar,
    eventNormalize: RUNTIME_FLAGS.eventNormalize,
    projectTrustGate: RUNTIME_FLAGS.projectTrustGate,
    cacheWarming: RUNTIME_FLAGS.cacheWarming,
    stagedVisible: RUNTIME_FLAGS.stagedVisible,
    autoTab: RUNTIME_FLAGS.autoTab,
    browserBadge: RUNTIME_FLAGS.browserBadge,
    narrowRestore: RUNTIME_FLAGS.narrowRestore,
    reconcileHint: RUNTIME_FLAGS.reconcileHint,
    feedbackV2: RUNTIME_FLAGS.feedbackV2,
    browserAdaptiveStream: RUNTIME_FLAGS.browserAdaptiveStream,
    browserFullpage: RUNTIME_FLAGS.browserFullpage,
    browserUrlGuard: RUNTIME_FLAGS.browserUrlGuard,
    browserAtomic: RUNTIME_FLAGS.browserAtomic,
    browserWaitFor: RUNTIME_FLAGS.browserWaitFor,
    browserAct: RUNTIME_FLAGS.browserAct,
    browserScrollContainer: RUNTIME_FLAGS.browserScrollContainer,
    browserExtract: RUNTIME_FLAGS.browserExtract,
    browserSelectOption: RUNTIME_FLAGS.browserSelectOption,
    subagentIdempotent: RUNTIME_FLAGS.subagentIdempotent,
    subagentBlockedBubble: RUNTIME_FLAGS.subagentBlockedBubble,
    agentBusyWatchdog: RUNTIME_FLAGS.agentBusyWatchdog,
    resumeAutoRetry: RUNTIME_FLAGS.resumeAutoRetry,
    spatialAnalysis: RUNTIME_FLAGS.spatialAnalysis,
    mapReport: RUNTIME_FLAGS.mapReport,
    mapExport: RUNTIME_FLAGS.mapExport,
    dataAdapters: RUNTIME_FLAGS.dataAdapters,
    amapMcpBridge: RUNTIME_FLAGS.amapMcpBridge,
    mapPack: RUNTIME_FLAGS.mapPack,
    mapTemplates: RUNTIME_FLAGS.mapTemplates,
    mapBookmarks: RUNTIME_FLAGS.mapBookmarks,
    transcriptV3: RUNTIME_FLAGS.transcriptV3,
    replayRecover: RUNTIME_FLAGS.replayRecover,
    qoderAlign: RUNTIME_FLAGS.qoderAlign,
    qoderSseBackoff: RUNTIME_FLAGS.qoderSseBackoff,
    qoderStyle: RUNTIME_FLAGS.qoderStyle,
    qoderSseBackpressure: RUNTIME_FLAGS.qoderSseBackpressure,
    qoderDrainOnAbort: RUNTIME_FLAGS.qoderDrainOnAbort,
    visualEffectsOff: RUNTIME_FLAGS.visualEffectsOff,
    qoderSeqGapAlert: RUNTIME_FLAGS.qoderSeqGapAlert,
    streamQuota: RUNTIME_FLAGS.streamQuota,
    eventSchemaCheck: RUNTIME_FLAGS.eventSchemaCheck,
    // 2026-11-19-010 P2：目标自动推进开关（布尔位，设置页可热更）。
    goalAutoContinue: RUNTIME_FLAGS.goalAutoContinue,
    qoderObjectBar: RUNTIME_FLAGS.qoderObjectBar,
    domainWorkflows: RUNTIME_FLAGS.domainWorkflows,
    qoderToolOutputSplit: RUNTIME_FLAGS.qoderToolOutputSplit,
    qoderInteractionOwner: RUNTIME_FLAGS.qoderInteractionOwner,
    officeFormat: RUNTIME_FLAGS.officeFormat,
    cadPreview: RUNTIME_FLAGS.cadPreview,
    cadAgent: RUNTIME_FLAGS.cadAgent,
    creativeCanvas: RUNTIME_FLAGS.creativeCanvas,
    chartWorkbench: RUNTIME_FLAGS.chartWorkbench,
    // ZCode Harness 对标开关族
    harnessAlign: RUNTIME_FLAGS.harnessAlign,
    toolMetadata: RUNTIME_FLAGS.toolMetadata,
    permissionAudit: RUNTIME_FLAGS.permissionAudit,
    permissionAuditAllow: RUNTIME_FLAGS.permissionAuditAllow,
    toolResultArtifact: RUNTIME_FLAGS.toolResultArtifact,
    usageLedger: RUNTIME_FLAGS.usageLedger,
    memoryRecall: RUNTIME_FLAGS.memoryRecall,
    memoryExtract: RUNTIME_FLAGS.memoryExtract,
    contextSections: RUNTIME_FLAGS.contextSections,
    skillInjection: RUNTIME_FLAGS.skillInjection,
    // 2026-11-08 交互/技能/写作链路开关（默认关；计划 2026-11-08-001）
    skillDeps: RUNTIME_FLAGS.skillDeps,
    interactionHub: RUNTIME_FLAGS.interactionHub,
    composerUnified: RUNTIME_FLAGS.composerUnified,
    writingOneShot: RUNTIME_FLAGS.writingOneShot,
    writingLeanContext: RUNTIME_FLAGS.writingLeanContext,
    askAssumption: RUNTIME_FLAGS.askAssumption,
    writingBudget: RUNTIME_FLAGS.writingBudget,
    // 2026-11-09 专家团队按需触发
    teamSuggest: RUNTIME_FLAGS.teamSuggest,
    teamGuard: RUNTIME_FLAGS.teamGuard,
    teamRequiredEntry: RUNTIME_FLAGS.teamRequiredEntry,
    hookEvents: RUNTIME_FLAGS.hookEvents,
    subagentProfile: RUNTIME_FLAGS.subagentProfile,
    toolErrorEnvelope: RUNTIME_FLAGS.toolErrorEnvelope,
    configSource: RUNTIME_FLAGS.configSource,
    workflowJournal: RUNTIME_FLAGS.workflowJournal,
    pluginManifest: RUNTIME_FLAGS.pluginManifest,
    planPersistence: RUNTIME_FLAGS.planPersistence,
    observabilityExport: RUNTIME_FLAGS.observabilityExport,
    // 数值位：前端 numberFlag() 读取（心跳间隔需下发前端派生看门狗阈值）。
    // 2026-11-19-010：工具失败停手阈值 / 目标自动推进上限。
    toolFailureLimit: RUNTIME_FLAGS.toolFailureLimit,
    goalMaxRounds: RUNTIME_FLAGS.goalMaxRounds,
    heartbeatChatMs: RUNTIME_FLAGS.heartbeatChatMs,
    heartbeatEventsMs: RUNTIME_FLAGS.heartbeatEventsMs,
    heartbeatBrowserMs: RUNTIME_FLAGS.heartbeatBrowserMs,
  };
}
