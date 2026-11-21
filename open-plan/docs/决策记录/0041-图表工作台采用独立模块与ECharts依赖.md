# 0041 图表工作台采用独立模块与ECharts依赖

- 状态：已采纳
- 记录日期：2026-11-19
- 决策者：用户（方案 [2026-11-19-001](../plans/2026-11-19-001-ECharts图表工作台与展板方案.md) v2 批准 + 当轮拍板：形态=独立工作台+展板 / 首版带数据表编辑视图 / 分期 0→1a→1b-1→1b-2→2→3）
- 基线：v0.13.26（`develop`）
- 关联：`REQUIREMENTS.md` R18、ADR 0005（本地文件持久化）、ADR 0031（创作画布可编辑文档）、ADR 0033（画布事件板级增量刷新）、ADR 0035（结构化引用）、ADR 0043（新功能运行开关默认打开）、[Office 排版规范]（Office CLI 不承担图表渲染）

## 1. 背景

ECharts 图表此前只能靠 `echarts-canvas-chart` 技能（007）服务端 SSR 渲染成静态 SVG 上画布：不可交互、不能在会话中持续调优、agent 没有一等公民的图表工具。用户提出「agent 版多维表格」形态：结构化数据 + 图表视图 + 展板 + agent 全链路操作。画布前端 SVG 以静态 `img` 承载（防脚本），天然不支持交互式图表；把交互图表硬塞进画布对象模型需重写渲染分支并引入脚本安全面，属高侵入改造。

## 2. 决策

1. **独立图表工作台模块**（`server/图表工作台.mjs` + 前端工作台/展板/数据表面板），落盘 `charts/<slug>/`（manifest + datasets/ + chart JSON + boards/ + assets/exports/.trash/.history + operations.jsonl），与 `designs/<slug>/` 同构；不进画布对象模型。画布只收静态 SVG/PNG（导出后经既有 `canvas_write` 上板），交互调优只在工作台——两模块职责硬边界，避免双事实源。
2. **引入 `echarts` 运行时依赖**（6.1.0，Apache-2.0，与技能 007 实测版本一致）：前端动态 `import("echarts/core")` 按需注册（Bar/Line/Pie/Scatter/Sankey + CanvasRenderer），不整包引入、不新增 React 包装库；**服务端同样引入 echarts 用于 SSR 导出**（`init(null,null,{renderer:"svg",ssr:true})` + SVGRenderer，技能 007 的 render-chart.mjs 已验证该路径）——agent 导出工具运行在服务端、前端无法参与，实施期把初稿"服务端不做 ECharts 渲染"修订为此口径并在此留痕。
3. **agent 工具族 12 个**：`chart_read/write/set_data/export/delete` + `board_read/write/export/delete` + `data_read/write/delete`，仅在 Work 开放；审批对齐 canvas_*（读写 allow、删除/导出 ask，delete destructive+forceConfirm）。
4. **数据表**：`data_write` 全量写（行数/行宽/类型校验）为主通道，CSV 导入统一落成数据表（gb18030/BOM 先例复用、expectRows 校验 → `data_integrity_failed`）；不做跨表关联/公式列/多视图/字段级权限（后续单独立项）。
5. **渲染形态契约**：绑定 datasetId 的图表 series 不得直连 data、option 不得自带 dataset（并存拒绝写入），渲染时由前端把数据表行合并进 `option.dataset.source`——化解既有技能模板（series.data 直连形态）与数据表联动的兼容冲突。
6. **事件**：`chart_created/chart_changed/chart_exported` 按 canvas 同款登记事件注册表；单一聚合事件 + 细分字段（chartId/datasetId/boardId），不拆细分事件名（对齐 ADR 0033 收敛方向）。
7. **运行开关** `OAW_CHART_WORKBENCH`：按 ADR 0043 约定**默认开**，env/`.oaw/runtime-flags.json` 显式 0 回退基线；设置面板提供逐会话开关。方案 v2 拍板时曾按"creativeCanvas 默认关"的过时认知推荐默认关，实施时依 ADR 0043（用户已拍板的现行约定）与功能本体已获确认改为默认开，在此留痕。
8. `chart.js ^4.4.9` 保留不动：它是 pptxviewjs 的 optional peer，缺失曾致构建失败/生产崩溃（变更日志 2026-11-10 记录）。

## 3. 备选与取舍

- **方案 C（采纳）**：独立工作台+展板为主，静态导出上画布。代价：新模块与一条导出链；收益：交互完整、与画布零冲突、复用画布全部交付链。
- 方案 A：画布新增 chart 元素类型。代价：扩 ELEMENT_TYPES、重写渲染分支、脚本安全面、导出降级逻辑全动；收益：入口集中。不可交互的静态形态无法满足"会话调优"诉求，否决。
- 方案 B：纯独立（不做上画布导出）。代价：PPT/排版交付断链；收益：少一条链。用户明确要求"渲染在画布或展板上"，否决。

## 4. 落地（阶段 0–3 全量）

- 服务端：`server/图表工作台.mjs`（落盘/校验/限额/软删除/CSV 导入/missing 投影/SSR SVG 导出/展板 HTML 导出）；`server/task.mjs` 白名单与能力计划；`server/审批策略.mjs` 规则；`server/工具元数据.mjs` 门控元数据；`server/agent.mjs` 12 工具；`server/runs.mjs` 显示名与 `isChartInternalArtifactPath` 产物台账排除；`server/事件注册表.mjs` 3 事件；`server/context.mjs` @图表 引用解析与读取。
- 前端：`client`/root 引入 echarts 6.1.0；`ChartRenderer.jsx`（动态按需注册 + 双主题 + dataset 合并）；`图表工作台.jsx` 三分区工作台；App/画布标签栏/画布状态接线（lazy 加载、chart_changed 去抖刷新、chart_created 自动开标签）；`引用标记.js` chart 引用；`api.js` chart API。
- 文档：`REQUIREMENTS.md` R18；《会话流渲染通道清单》§5 增补渲染决策；分期实施与验收见方案 2026-11-19-001 与[实施记录](../plans/2026-11-19-001-实施记录.md)。
- 测试：`scripts/图表工作台模型测试.mjs`（test:chart-model）、`scripts/图表工作台界面接线测试.mjs`（test:chart-ui）；`test:capability-contract` 增 chartWorkbench 声明；ui-smoke 增开签检查。

## 5. 验证

- `npm run test:chart-model`：15 用例（工作台/数据表校验/CSV 编码/形态契约/限额/软删除/missing/SSR 与展板导出/事件 schema/ChartRenderer 契约）全绿。
- `npm run test:chart-ui`：26 用例（App 接线与事件管线/api 11 函数/@图表 两端 parity/路由 flag 门控/事件发射/台账排除）全绿。
- `test:capability-contract` / `test:event-registry` / `test:event-emission` / `test:tool-metadata` / `test:tool-presentation` / `test:ref-parser` / `test:composer-refs` / `test:approval` / `test:canvas-model` / `test:run-view` 全绿；`npm --prefix client run build` 通过（echarts 按需分包生效）；`npm run verify` 通过。
