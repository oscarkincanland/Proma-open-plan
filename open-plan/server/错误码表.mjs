/**
 * 错误码 → 动作 表（计划 2026-11-19-001 批次 B）
 *
 * 背景：officecli 与 bash 的常见失败此前以**散文**形式写在工具描述里
 * （"KNOWN ERRORS (avoid loops): (a) … (f) …"），模型只能逐句比对措辞；每遇到一类
 * 新失败就再加一句，文本只会越来越长且覆盖不全。
 *
 * 这里改成机器可读的登记表：code / 触发特征 / 含义 / 立即动作 / 禁止动作。
 *   - 提示词里渲染成紧凑表格（渲染函数唯一，避免多处漂移）；
 *   - 运行期可用 `lookupErrorCode()` 把真实错误文本映射成 code（供后续诊断/测试）；
 *   - 新增失败类型只加一条数据，不再改提示词正文。
 *
 * 约束：纯数据 + 纯函数，无 IO、无副作用，Node 可直测。
 */

/** @typedef {{code:string, scope:"officecli"|"bash"|"fs"|"any", match:string|RegExp, meaning:string, action:string, forbid:string}} ErrorCodeEntry */

const RAW = [
  {
    code: "OFFICE_STYLE_MISSING",
    scope: "officecli",
    match: "Style Normal not found",
    meaning: "文档里没有该样式",
    action: "先 'create' 预注册样式，或 add <file> /styles --type style --prop id=Normal --prop name=Normal --prop type=paragraph",
    forbid: "不要对 styles.xml 用 raw-set 手写样式",
  },
  {
    code: "OFFICE_TABLE_PATH",
    scope: "officecli",
    match: "table path",
    meaning: "表格路径只支持 /body/tbl[N] 形式",
    action: "用 /body/tbl[1] 逐行逐格 set",
    forbid: "不要用 tbl[*]、//p 或通配路径",
  },
  {
    code: "OFFICE_TABLE_SIZE",
    scope: "officecli",
    match: "does not accept 'size'",
    meaning: "表格元素本身不接受字号属性",
    action: "对单元格内的段落 set --prop size=…",
    forbid: "不要对 tbl 节点设置 size",
  },
  {
    code: "IMAGE_NOT_FOUND",
    scope: "officecli",
    match: "Image file not found",
    meaning: "引用的图片尚未落盘（write 工具刚写的文件可能还在暂存）",
    action: "先用 write 落盘，或把内容经本工具参数传入以自动物化",
    forbid: "不要原样重试同一命令",
  },
  {
    code: "OOXML_MALFORMED",
    scope: "officecli",
    match: "Malformed XML in document part",
    meaning: "raw/raw-set 编辑把 OOXML 改坏了",
    action: "停止编辑该文件，用 create + add --type markdown 重建",
    forbid: "不要试图手工修复 XML",
  },
  {
    code: "MARKDOWN_SOURCE_MISSING",
    scope: "officecli",
    match: "markdown source file not found",
    meaning: "add --type markdown 引用的 .md 不存在",
    action: "先写 .md，或把 Markdown 经本工具参数传入",
    forbid: "不要连续重试",
  },
  {
    code: "OFFICE_DECOMPRESSION_BOMB",
    scope: "officecli",
    match: "decompression_bomb",
    meaning: "工作簿 XML 元素超过上限（约 3,000,000）",
    action: "告知用户拆分文件，或改用脚本读数据",
    forbid: "不要重试同一命令",
  },
  {
    code: "OFFICE_DOTNET_BROKEN",
    scope: "officecli",
    match: "System.Private.Xml",
    meaning: "officecli 安装处于半更新状态",
    action: "重试一次；仍失败则让用户重跑 officecli 安装器",
    forbid: "不要循环重试",
  },
  {
    code: "BASH_GUARD_DENIED",
    scope: "bash",
    match: /guarded|工作区守卫|denied by guard/i,
    meaning: "该命令被工作区/只读守卫拦截",
    action: "改用产品工具（read/officecli/env_probe）或在 Work 模式且工作区内执行",
    forbid: "不要换写法绕过守卫",
  },
  {
    code: "FS_SHARING_VIOLATION",
    scope: "fs",
    match: /sharing violation|EBUSY|另一个进程/i,
    meaning: "文件被 WPS/Word/Excel 占用",
    action: "让用户关闭该文件后重试一次",
    forbid: "不要重试超过两次",
  },
  {
    code: "FS_ACCESS_DENIED",
    scope: "fs",
    match: /EPERM|EACCES|access denied/i,
    meaning: "服务进程没有该路径写权限（沙箱/挂载/目录权限）",
    action: "说明权限原因，请用户改权限或换工作区",
    forbid: "不要当成文件锁反复重试",
  },
];

/** 冻结后的登记表（顺序即渲染顺序）。 */
export const ERROR_CODES = Object.freeze(RAW.map((item) => Object.freeze({ ...item })));

/**
 * 把错误文本映射到登记项（用于诊断与测试；模型侧仍以表格为准）。
 * @param {string} message
 * @returns {object|null}
 */
export function lookupErrorCode(message) {
  const text = String(message || "");
  if (!text) return null;
  for (const entry of ERROR_CODES) {
    const pattern = entry.match instanceof RegExp ? entry.match : new RegExp(escapeRegExp(String(entry.match)), "i");
    if (pattern.test(text)) return entry;
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 渲染成提示词用的紧凑表格（一行一条，便于模型直接照做）。
 * @param {{scope?: string, header?: string}} [options]
 */
export function renderErrorCodeTable({ scope = "", header = "ERROR CODES (命中即按「actions」执行，不要临场推理):" } = {}) {
  const wanted = scope ? ERROR_CODES.filter((entry) => entry.scope === scope) : ERROR_CODES;
  if (!wanted.length) return "";
  const lines = wanted.map((entry) => `${entry.code} [${entry.scope}] 触发: ${entry.meaning} → 动作: ${entry.action} ｜ 禁止: ${entry.forbid}`);
  return `${header} ` + lines.join("; ") + ". ";
}

/** 供测试与前端展示的统计。 */
export function errorCodeStats() {
  const byScope = {};
  for (const entry of ERROR_CODES) byScope[entry.scope] = (byScope[entry.scope] || 0) + 1;
  return { total: ERROR_CODES.length, byScope };
}
