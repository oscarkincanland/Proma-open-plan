#!/usr/bin/env node
/**
 * 图表工作台界面接线测试（test:chart-ui，方案 2026-11-19-001 §7）。
 * 断言前端接线完整性（源码契约）：App 挂载/入口/事件管线、画布状态标签、api.js、
 * ChartRenderer 契约、@图表 引用两端 parity、index.mjs 路由与事件发射。
 *
 * 用法: node scripts/图表工作台界面接线测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed = 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};

console.log("\n▶ App 接线（挂载 / 入口 / 事件管线）");
{
  const app = read("client/src/App.jsx");
  test("图表工作台 lazy 按需加载（不进主包）", () => {
    assert.ok(app.includes('lazy(() => import("./components/图表工作台.jsx"))'), "缺 lazy import");
    assert.ok(!app.includes('from "./components/图表工作台.jsx"') || app.match(/from "\.\/components\/图表工作台\.jsx"/g).length === 0, "不得静态 import");
  });
  test("chartWorkbench 标签挂载分支 + refreshToken 注入", () => {
    assert.ok(app.includes('tab.kind === "chartWorkbench"'), "缺挂载分支");
    assert.ok(app.includes("canvas-body-chart"), "缺容器 class");
    assert.ok(/<图表工作台[\s\S]*?refreshToken=\{chartRefresh\[/.test(app), "缺 chartRefresh 注入");
  });
  test("菜单/开始页入口受 flag 门控", () => {
    assert.ok(app.includes('showChartWorkbench={flag("chartWorkbench")}'), "标签栏 + 菜单缺 flag prop");
    assert.ok(app.includes('if (action === "chartWorkbench") { openChartWorkbench'), "onPlusAction 缺分支");
    assert.ok(/id: "chartWorkbench", title: "图表工作台"/.test(app), "开始页缺入口卡");
  });
  test("chart_changed 去抖刷新管线（镜像 canvas_changed）", () => {
    assert.ok(app.includes('event.type === "chart_changed"'), "全局流缺 chart_changed 处理");
    assert.ok(app.includes("chartRefreshTimerRef"), "缺去抖 timer");
    assert.ok(app.includes('setTimeout(() => {\n                chartRefreshTimerRef.current = null;') || /chartRefreshTimerRef\.current = window\.setTimeout/.test(app), "去抖实现不完整");
  });
  test("chart_created 自动开标签（pending 状态消化，与画布同款）", () => {
    assert.ok(app.includes("setPendingChartOpen"), "缺 pending 状态");
    assert.ok(/pendingChartOpen[\s\S]*openChartWorkbench\(slug, title \|\| slug\)/.test(app), "缺 pending 消费 effect");
  });
  test("画布状态.js：chartWorkbench 标签元数据与恢复", () => {
    const state = read("client/src/画布状态.js");
    assert.ok(state.includes('chartWorkbench: { title: "图表工作台", icon: "chart" }'), "VIEW_META 缺条目");
    assert.ok(state.includes("export function createChartTab"), "缺 createChartTab");
    assert.ok(state.includes("export function chartTabId"), "缺 chartTabId");
    assert.ok(/kind === "chartWorkbench"[\s\S]{0,400}createChartTab\(/.test(state), "sanitizeTab 缺恢复分支");
  });
  test("画布标签栏.jsx：+ 菜单含图表工作台入口", () => {
    const bar = read("client/src/components/画布标签栏.jsx");
    assert.ok(bar.includes("showChartWorkbench"), "缺 prop");
    assert.ok(/showChartWorkbench && <button[^>]*>[\s\S]*?图表工作台/.test(bar), "缺菜单项");
  });
}

console.log("\n▶ api.js 与组件契约");
{
  const api = read("client/src/api.js");
  for (const name of ["listChartWorkbenches", "getChartWorkbenchSummary", "saveChart", "patchChart", "deleteChart", "exportChartSvg", "saveDataset", "deleteDataset", "getChartBoard", "saveChartBoard"]) {
    test(`api.js 暴露 ${name}`, () => {
      assert.ok(new RegExp(`export const ${name} =`).test(api), `缺 ${name}`);
    });
  }
  const bench = read("client/src/components/图表工作台.jsx");
  test("工作台组件：新建占位 + 三分区 + dirty 上报", () => {
    assert.ok(bench.includes("chart-workbench-empty"), "缺新建占位");
    assert.ok(bench.includes('setSection("data")'), "缺数据表分区");
    assert.ok(bench.includes("onDirtyChange?.("), "缺 dirty 上报");
    assert.ok(bench.includes("@图表[charts/"), "缺加入对话引用");
  });
  test("工作台组件：dirty 冲突提示（不静默覆盖）", () => {
    assert.ok(bench.includes("chart-remote-banner"), "缺远端变更提示条");
    assert.ok(bench.includes("覆盖保存"), "缺覆盖保存选项");
    assert.ok(bench.includes("刷新读取"), "缺刷新读取选项");
  });
  test("工作台组件：展板分区（阶段 2）", () => {
    assert.ok(bench.includes('setSection("board")'), "缺展板分区");
    assert.ok(bench.includes("exportBoardHtml"), "缺展板导出调用");
    assert.ok(bench.includes("chart-board-canvas"), "缺展板画布");
    assert.ok(bench.includes("datasetSource"), "展板格缺数据表行投影");
  });
  test("单侧栏整合：编辑面板并入侧栏 + 收起态悬浮钮组（2026-11-19-011）", () => {
    assert.ok(bench.includes("chart-side-editor"), "缺侧栏编辑器区");
    assert.ok(!bench.includes('className="chart-inspector"'), "中间区不得再渲染独立右面板");
    assert.ok(bench.includes("chart-side-toggle"), "缺收起态悬浮钮组");
    assert.ok(bench.includes("chart-side-collapsed"), "缺收起态类");
    assert.ok(bench.includes("chevronLeft") && bench.includes("chevronRight"), "缺收起/展开图标");
    assert.ok(bench.includes("新建图表") && bench.includes("新建数据表") && bench.includes("新建展板"), "悬浮钮组须保留新建入口");
  });
  test("侧栏收起状态记忆：单键 map + try/catch + 读写两处", () => {
    assert.ok(bench.includes('const SIDE_PREF_KEY = "oaw_chart_side_v1"'), "缺记忆键常量");
    const prefsReads = bench.split("readSidePrefs()").length - 1;
    assert.ok(prefsReads >= 2, `readSidePrefs 应在 read+write 两处被调用，实际 ${prefsReads}`);
    assert.ok(bench.includes("readSideCollapsed") && bench.includes("writeSideCollapsed"), "缺读写 helper");
    assert.ok(/catch \{\}/.test(bench) || /catch \{ return/.test(bench), "localStorage 读写缺 try/catch 兜底");
    assert.ok(bench.includes("!== false"), "默认收起口径缺失");
  });
  test("api.js 暴露 exportBoardHtml", () => {
    assert.ok(new RegExp("export const exportBoardHtml =").test(api), "缺 exportBoardHtml");
  });
  test("ChartRenderer：动态按需 + 双主题 + dataset 合并", () => {
    const renderer = read("client/src/components/ChartRenderer.jsx");
    assert.ok(renderer.includes('import("echarts/core")'), "缺动态 echarts/core");
    assert.ok(renderer.includes('import("echarts/renderers")'), "缺渲染器注册");
    assert.ok(renderer.includes("registerTheme"), "缺双主题注册");
    assert.ok(renderer.includes("mergeDatasetOption"), "缺 dataset 合并");
    assert.ok(!/from ["']echarts["']/.test(renderer), "不得整包 import echarts");
  });
  test("样式：图表工作台区块使用设计令牌", () => {
    const css = read("client/src/styles.css");
    assert.ok(css.includes("图表工作台（2026-11-19-001"), "缺样式区块");
    assert.ok(css.includes(".chart-workbench {"), "缺主样式");
    assert.ok(css.includes("[data-theme=\"light\"] .chart-canvas-area"), "缺亮色适配");
    assert.ok(css.includes(".chart-side-editor {") && css.includes(".chart-side-collapsed .chart-side { display: none; }"), "单侧栏整合样式缺失");
    assert.ok(css.includes(".chart-side-toggle {"), "缺悬浮钮样式");
    assert.ok(!/\.chart-inspector \{ width: 300px/.test(css), "inspector 旧固定宽度未清理");
    assert.ok(css.includes(".chart-side-foot {"), "缺 foot 样式");
  });
}

console.log("\n▶ @图表 引用两端 parity");
{
  const client = read("client/src/引用标记.js");
  const server = read("server/context.mjs");
  test("客户端 chart 引用登记齐全", () => {
    assert.ok(client.includes('"chart"'), "REFERENCE_KINDS 缺 chart");
    assert.ok(client.includes("chart: { label: \"图表\""), "META 缺 chart");
    assert.ok(client.includes("chart: (target) => `@图表[${target}]`"), "BUILDER 缺 chart");
    assert.ok(client.includes('["chart", /@图表\\[([^\\]]+)\\]/g]'), "STRUCTURED_MARKERS 缺 chart");
    assert.ok(client.includes('const KNOWN_MARKER_TYPES = ["知识库目录", "模板目录", "知识库", "模板", "文件", "技能", "插件", "会话", "智能体", "画布", "图表"]'), "KNOWN 缺 图表");
  });
  test("服务端 chart 引用解析与读取", () => {
    assert.ok(server.includes('/@图表\\[([^\\]]+)\\]/g'), "parseReferences 缺 chart");
    assert.ok(server.includes("function resolveChartReference"), "缺 resolveChartReference");
    assert.ok(server.includes('if (ref.kind === "chart") return resolveChartReference'), "resolveReference 缺分支");
    assert.ok(server.includes('if (resolved.kind === "chart")'), "readReference 缺 chart 分支");
    assert.ok(server.includes("【图表引用】") && server.includes("【数据表引用】"), "读取文本缺投影");
  });
  test("会话流渲染通道清单登记图表工作台", () => {
    const channels = read("docs/规范/会话流渲染通道清单.md");
    assert.ok(channels.includes("图表工作台") || channels.includes("chart_changed"), "渲染通道清单未登记图表工作台相关通道");
  });
}

console.log("\n▶ 服务端路由与事件发射");
{
  const index = read("server/index.mjs");
  test("/api/charts/* 路由段齐备且受 flag 门控", () => {
    for (const route of ["/api/charts/workbenches", "/api/charts/:slug/chart", "/api/charts/:slug/chart/:chartId/export", "/api/charts/:slug/dataset", "/api/charts/:slug/board", "/api/charts/:slug/board/:boardId/export"]) {
      assert.ok(index.includes(`"${route}"`) || index.includes(`'${route}'`) || index.includes(route.replace(/:[^/]+/g, ":x")), `缺路由 ${route}`);
    }
    assert.ok(/app\.get\("\/api\/charts\/workbenches", async \(req, res\) => \{\s*\n\s*if \(!RUNTIME_FLAGS\.chartWorkbench\) return chartFeature\(res\);/.test(index), "路由缺 flag 门控");
  });
  test("UI 写路径发 chart_changed / chart_exported", () => {
    assert.ok(/chartEvent\("chart_changed"/.test(index), "缺 chart_changed 广播");
    assert.ok(/chartEvent\("chart_exported"/.test(index), "缺 chart_exported 广播");
  });
  test("runs.mjs 内部文件判定含 charts/<slug>/project/**", () => {
    const runs = read("server/runs.mjs");
    assert.ok(runs.includes("export function isChartInternalArtifactPath"), "缺判定函数");
    assert.ok(/!isCanvasInternalArtifactPath\(item\?\.path\) && !isChartInternalArtifactPath\(item\?\.path\)/.test(runs), "产物过滤未接入 chart 内部判定");
  });
}

console.log(failed ? "\n✗ 存在失败用例" : "\n✓ 全部通过");
process.exit(failed);
