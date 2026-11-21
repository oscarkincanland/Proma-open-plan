#!/usr/bin/env node
/**
 * 图表工作台模型测试（阶段 0，方案 docs/plans/2026-11-19-001 §7）。
 * 覆盖：slug/manifest 落盘、数据表校验（行数/行宽/类型/空表/ISO 8601）、图表写入
 * 形态契约（dataset 绑定互斥 series.data / option.dataset）、CSV 导入（gb18030/BOM/
 * expectRows）、限额、软删除与 missing 投影、ChartRenderer 前端契约（按需注册/双主题）。
 *
 * 用法: node scripts/图表工作台模型测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const charts = await import("../server/图表工作台.mjs");
const { CHART_LIMITS } = charts;

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed = 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oaw-chart-test-"));
}
async function expectFail(code, fn) {
  try {
    await fn();
  } catch (e) {
    assert.equal(e?.code, code, `期望错误码 ${code}，实际 ${e?.code}: ${e?.message}`);
    return;
  }
  assert.fail(`期望抛出 ${code}，但调用成功`);
}

console.log("\n▶ 工作台与数据表");
{
  const ws = tempWorkspace();
  await test("createWorkbench 幂等创建 slug 目录与 manifest", async () => {
    const first = await charts.createWorkbench(ws, { title: "客流分析", actor: "agent" });
    assert.equal(first.created, true);
    const again = await charts.createWorkbench(ws, { slug: first.slug, title: "客流分析", actor: "agent" });
    assert.equal(again.created, false);
    const list = charts.listWorkbenches(ws);
    assert.equal(list.workbenches.length, 1);
    assert.ok(fs.existsSync(path.join(ws, "charts", first.slug, "project", "manifest.json")));
    assert.ok(fs.existsSync(path.join(ws, "charts", first.slug, ".trash")));
  });
  const slug = charts.listWorkbenches(ws).workbenches[0].slug;
  await test("data_write 直写通过 + 类型/行宽校验拒绝", async () => {
    const result = await charts.writeDataset(ws, slug, {
      title: "分区客流",
      fields: [{ name: "城市", type: "string" }, { name: "客流", type: "number" }],
      rows: [["杭州", 1200], ["义乌", 800]],
      actor: "agent",
    });
    assert.equal(result.dataset.rows.length, 2);
    await expectFail("CHART_INVALID", () => charts.writeDataset(ws, slug, { title: "坏表", fields: [{ name: "a", type: "number" }], rows: [["文本"]], actor: "agent" }));
    await expectFail("CHART_INVALID", () => charts.writeDataset(ws, slug, { title: "坏表", fields: [{ name: "a", type: "string" }], rows: [["x", "y"]], actor: "agent" }));
    await expectFail("CHART_INVALID", () => charts.writeDataset(ws, slug, { title: "坏表", fields: [{ name: "d", type: "date" }], rows: [["2026/01/01"]], actor: "agent" }));
    await expectFail("CHART_INVALID", () => charts.writeDataset(ws, slug, { title: "坏表", fields: [{ name: "a", type: "string" }], rows: [], actor: "agent" }));
  });
  const dsId = charts.readDataset(ws, slug).datasets[0].id;
  await test("CSV 导入：expectRows 校验 + 类型推断 + gb18030/BOM 解码", async () => {
    const csvPath = path.join(ws, "客流.csv");
    fs.writeFileSync(path.join(ws, "客流-utf8.csv"), "\uFEFF城市,客流\n杭州,1200\n义乌,800\n", "utf-8");
    const imported = await charts.importCsvAsDataset(ws, slug, { csvPath: "客流-utf8.csv", title: "导入表", expectRows: 2, actor: "agent" });
    assert.equal(imported.encoding, "utf-8");
    assert.equal(imported.dataset.rows[0][1], 1200);
    // gb18030 编码字节（「城市」= 0xB3C7 0xCAD0）在 UTF-8 fatal 解码下必须回落成功
    const gbBuffer = Buffer.from([0xb3, 0xc7, 0xca, 0xd0, 0x2c, 0xbf, 0xcd, 0xc1, 0xf7, 0x0d, 0x0a, 0xba, 0xbc, 0xd6, 0xdd, 0x2c, 0x39, 0x39, 0x0d, 0x0a]);
    const decoded = charts.decodeCsvBuffer(gbBuffer);
    assert.equal(decoded.encoding, "gb18030");
    assert.ok(decoded.text.includes("杭州"));
    await expectFail("DATA_INTEGRITY_FAILED", () => charts.importCsvAsDataset(ws, slug, { csvPath: "客流-utf8.csv", title: "错数", expectRows: 5, actor: "agent" }));
    void csvPath; void dsId;
  });
  await test("data_delete 软删除 + 绑定图表 missing 投影", async () => {
    const ds = charts.readDataset(ws, slug).datasets.find((d) => d.title === "导入表");
    const chart = await charts.writeChart(ws, slug, {
      title: "导入柱状图",
      option: { xAxis: { type: "category" }, yAxis: {}, series: [{ type: "bar" }] },
      data: { kind: "dataset", datasetId: ds.id },
      actor: "agent",
    });
    await charts.deleteDataset(ws, slug, ds.id, { actor: "agent" });
    // 图表仍在，但数据表没了：boardView 中标记 missing
    const board = await charts.writeBoard(ws, slug, { title: "看板", layout: [{ chartId: chart.chart.id, x: 0, y: 0, w: 640, h: 480 }], actor: "agent" });
    const view = charts.boardView(ws, slug, board.board.id);
    assert.equal(view.board.layout[0].missing, true);
  });
}

console.log("\n▶ 图表形态契约与限额");
{
  const ws = tempWorkspace();
  const slug = (await charts.createWorkbench(ws, { title: "形态契约", actor: "agent" })).slug;
  await charts.writeDataset(ws, slug, { title: "表", fields: [{ name: "k", type: "string" }], rows: [["a"]], actor: "agent" });
  const dsId = charts.readDataset(ws, slug).datasets[0].id;
  await test("dataset 绑定 + series 直连 data → CHART_CONFLICT_DATA_FORM", async () => {
    await expectFail("CHART_CONFLICT_DATA_FORM", () => charts.writeChart(ws, slug, {
      title: "冲突图",
      option: { series: [{ type: "bar", data: [1, 2] }] },
      data: { kind: "dataset", datasetId: dsId },
      actor: "agent",
    }));
    await expectFail("CHART_CONFLICT_DATA_FORM", () => charts.writeChart(ws, slug, {
      title: "冲突图",
      option: { dataset: { source: [["k"], ["a"]] }, series: [{ type: "bar" }] },
      data: { kind: "dataset", datasetId: dsId },
      actor: "agent",
    }));
  });
  await test("inline 与 dataset 合法形态写入成功", async () => {
    const inline = await charts.writeChart(ws, slug, {
      title: "内联图",
      option: { xAxis: { type: "category", data: ["a", "b"] }, yAxis: {}, series: [{ type: "line", data: [1, 2] }] },
      data: { kind: "inline", inline: [["k", "v"], ["a", 1], ["b", 2]] },
      actor: "agent",
    });
    assert.equal(inline.chart.data.kind, "inline");
    const bound = await charts.writeChart(ws, slug, {
      title: "绑定图",
      option: { xAxis: { type: "category" }, yAxis: {}, series: [{ type: "bar" }] },
      data: { kind: "dataset", datasetId: dsId },
      actor: "agent",
    });
    assert.equal(bound.chart.data.kind, "dataset");
  });
  await test("绑定不存在的数据表 → CHART_NOT_FOUND；kind=csv 被引导走导入", async () => {
    await expectFail("CHART_NOT_FOUND", () => charts.writeChart(ws, slug, {
      title: "坏绑定",
      option: { series: [{ type: "bar" }] },
      data: { kind: "dataset", datasetId: "ds-ghost" },
      actor: "agent",
    }));
    await expectFail("CHART_INVALID", () => charts.writeChart(ws, slug, {
      title: "csv 直绑",
      option: { series: [{ type: "bar" }] },
      data: { kind: "csv", csvPath: "x.csv" },
      actor: "agent",
    }));
  });
  await test("option 超限与行数限额", async () => {
    const big = { series: [{ type: "bar", markArea: { label: "x".repeat(CHART_LIMITS.optionBytes) } }] };
    await expectFail("CHART_LIMIT", () => charts.writeChart(ws, slug, { title: "大图", option: big, actor: "agent" }));
    const manyRows = Array.from({ length: CHART_LIMITS.datasetRows + 1 }, (_, i) => [`r${i}`]);
    await expectFail("CHART_LIMIT", () => charts.writeDataset(ws, slug, { title: "大表", fields: [{ name: "a", type: "string" }], rows: manyRows, actor: "agent" }));
  });
  await test("chart_delete 软删除后 readChart 报 NOT_FOUND 且展板 missing", async () => {
    const c = await charts.writeChart(ws, slug, { title: "待删图", option: { series: [{ type: "pie", radius: "50%" }] }, data: { kind: "inline", inline: [["k", "v"], ["a", 1]] }, actor: "agent" });
    const b = await charts.writeBoard(ws, slug, { title: "删除看板", layout: [{ chartId: c.chart.id, x: 0, y: 0, w: 320, h: 240 }], actor: "agent" });
    await charts.deleteChart(ws, slug, c.chart.id, { actor: "agent" });
    await expectFail("CHART_NOT_FOUND", () => charts.readChart(ws, slug, c.chart.id));
    const view = charts.boardView(ws, slug, b.board.id);
    assert.equal(view.board.layout[0].missing, true);
    const trashDir = path.join(ws, "charts", slug, ".trash");
    assert.ok(fs.readdirSync(trashDir).some((f) => f.includes(c.chart.id)));
  });
  await test("setChartData 只改数据不改 option", async () => {
    const c = await charts.writeChart(ws, slug, { title: "数据切换", option: { series: [{ type: "bar" }] }, data: { kind: "inline", inline: [1, 2] }, actor: "agent" });
    await charts.setChartData(ws, slug, c.chart.id, { data: { kind: "inline", inline: [3, 4, 5] }, actor: "agent" });
    const after = charts.readChart(ws, slug, c.chart.id).chart;
    assert.deepEqual(after.data.inline, [3, 4, 5]);
    assert.deepEqual(after.option.series, [{ type: "bar" }]);
  });
  await test("SSR 导出：SVG 落 exports/ + dataset 合并 + PNG 拒绝", async () => {
    const ds = await charts.writeDataset(ws, slug, {
      title: "导出用表",
      fields: [{ name: "城市", type: "string" }, { name: "客流", type: "number" }],
      rows: [["杭州", 1200], ["义乌", 800]],
      actor: "agent",
    });
    const c = await charts.writeChart(ws, slug, {
      title: "SSR 图",
      option: { xAxis: { type: "category" }, yAxis: {}, series: [{ type: "bar" }] },
      data: { kind: "dataset", datasetId: ds.dataset.id },
      actor: "agent",
    });
    const rendered = await charts.renderChartSvg(ws, slug, c.chart.id, { width: 800, height: 600 });
    assert.ok(rendered.svg.includes("<svg"), "SSR 产出 SVG");
    assert.ok(rendered.svg.includes("杭州"), "数据表行已合并进渲染");
    const exported = await charts.exportChart(ws, slug, c.chart.id, { format: "svg", outputName: "OD-柱状图", actor: "agent" });
    assert.equal(exported.files.length, 1);
    assert.ok(exported.files[0].path.startsWith("charts/"), "导出路径位于工作区 charts/ 下");
    assert.ok(fs.existsSync(path.join(ws, exported.files[0].path)));
    assert.ok(exported.files[0].bytes > 0);
    await expectFail("CHART_EXPORT_UNSUPPORTED", () => charts.exportChart(ws, slug, c.chart.id, { format: "png", actor: "agent" }));
  });
  await test("展板导出：HTML 汇总各图 SSR SVG + missing 占位", async () => {
    const c1 = await charts.writeChart(ws, slug, { title: "板图一", option: { xAxis: { type: "category" }, yAxis: {}, series: [{ type: "bar" }] }, data: { kind: "inline", inline: [["k", "v"], ["a", 1]] }, actor: "agent" });
    const b = await charts.writeBoard(ws, slug, {
      title: "导出看板",
      layout: [
        { chartId: c1.chart.id, x: 0, y: 0, w: 640, h: 480 },
        { chartId: "chart-ghost", x: 660, y: 0, w: 640, h: 480 },
      ],
      actor: "agent",
    });
    const exported = await charts.exportBoard(ws, slug, b.board.id, { format: "html", actor: "agent" });
    assert.equal(exported.files.length, 1);
    const html = fs.readFileSync(path.join(ws, exported.files[0].path), "utf8");
    assert.ok(html.includes("<svg"), "HTML 内嵌 SSR SVG");
    assert.ok(html.includes("板图一"), "含图题");
    assert.ok(html.includes("图表缺失"), "missing 占位渲染");
    assert.ok(html.includes("演示数据"), "页脚演示数据提示");
    await expectFail("CHART_EXPORT_UNSUPPORTED", () => charts.exportBoard(ws, slug, b.board.id, { format: "png", actor: "agent" }));
  });
  await test("越界路径与非法 slug 拒绝", async () => {
    await expectFail("CHART_INVALID", () => charts.readChart(ws, "../evil"));
    await expectFail("CHART_PATH_OUT", () => charts.importCsvAsDataset(ws, slug, { csvPath: "../outside.csv", title: "越界", actor: "agent" }));
  });
}

console.log("\n▶ 事件注册表与前端契约");
{
  const registry = await import("../server/事件注册表.mjs");
  await test("chart_created/chart_changed/chart_exported 已登记且 schema 可校验", () => {
    for (const type of ["chart_created", "chart_changed", "chart_exported"]) {
      assert.ok(registry.isRegisteredEvent(type), `事件未登记：${type}`);
    }
    const bad = registry.validateEventPayload("chart_changed", { slug: "s" });
    assert.equal(bad.ok, false); // 缺 action
    const good = registry.validateEventPayload("chart_changed", { slug: "s", action: "update" });
    assert.equal(good.ok, true);
  });
  await test("ChartRenderer.jsx：echarts/core 动态按需注册 + 双主题，不整包引入", async () => {
    const source = fs.readFileSync(path.join("client", "src", "components", "ChartRenderer.jsx"), "utf-8");
    assert.ok(source.includes('import("echarts/core")'), "必须动态引入 echarts/core（分包）");
    assert.ok(!/\bfrom ["']echarts["']/.test(source), "不得整包 import echarts");
    assert.ok(source.includes("BarChart") && source.includes("LineChart") && source.includes("PieChart"), "按需注册图表类型");
    assert.ok(source.includes("registerTheme"), "必须注册双主题");
    assert.ok(source.includes("oaw-chart-light") && source.includes("oaw-chart-dark"), "主题名对齐双主题");
  });
}

console.log(failed ? "\n✗ 存在失败用例" : "\n✓ 全部通过");
process.exit(failed);
