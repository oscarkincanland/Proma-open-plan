# 0044 - 桌面端第二形态基座采用 Proma fork 并单仓迁入

> 状态：已采纳　日期：2026-11-21　依据：[计划 2026-11-21-002](../plans/2026-11-21-002-Proma桌面端功能1对1落地计划.md)
> 用户拍板（2026-11-21）：Proma 为壳整体嵌入 / 接受 AGPL 义务 / 全量规划分阶段。

## 背景

open-plan 已有自研桌面壳（[ADR 0024](0044-桌面端第二形态基座采用Proma-fork并单仓迁入.md 引用的前序决策)，壳优先 + 平台适配层）。用户希望在 Proma fork（`oscarkincanland/Proma-open-plan`，上游 proma-ai/Proma，AGPL-3.0，Electron 43.2.0 + Bun monorepo）的桌面端形态上 1:1 落地 open-plan 全部产品能力（PRD R1–R17），得到可分发的「规聚桌面版」。

实测事实（2026-11-21）：
- Electron 43.2.0 内置 Node = 24.18.0（`ELECTRON_RUN_AS_NODE` 实测），满足 Pi SDK `engines.node >= 22.19.0`。
- open-plan 直接依赖无原生编译模块；`server/服务入口.mjs` 仅依赖 Node 内置模块。
- `server/index.mjs` 注册 `uncaughtException → process.exit(1)`（依赖监督循环拉起），不适合进程内 import 进 Electron main。

## 决策

1. **第二形态基座**：桌面端在自研 desktop/ 壳之外，新增 Proma fork 作为第二桌面形态基座；R1–R17 功能迁移而非重写。
2. **单仓迁入**：open-plan 应用树（client/ + server/ + scripts/ + docs/ + tests/ + templates/ + 根配置）迁入 Proma fork 仓库顶层 `open-plan/` 目录；开发主线在 fork 仓库的 `open-plan` 分支（分支创建已获用户确认）。
3. **sidecar 进程模型**：open-plan server 以独立子进程运行——Proma main 用 `ELECTRON_RUN_AS_NODE=1` spawn Electron 自身执行 `open-plan/server/服务入口.mjs`，main 做就绪探测 + restart-on-exit。不做进程内 import（崩溃语义冲突 + CJS 打包与 `import.meta` 冲突）。
4. **ADR 0024 处置**：0024 的「壳优先、业务只问能力不问形态」原则继续有效并被本决策继承；0024 的版本条款（桌面端随 0.13.x 补丁线发布）由**双版本列车**取代——桌面版（Proma 基座）独立版本号 `0.19.x-guiju`，web 版继续 `0.13.x`。
5. **AGPL 合规**：接受 AGPL-3.0；保留 Proma LICENSE 与版权声明；分发时提供完整源码；不复制 Proma 商业版内容。
6. **fork 治理**：`open-plan/` 不加入 Bun workspaces（根 workspaces 仅 `packages/*`、`apps/*`，天然排除），不参与 `bun install`；open-plan 树内验证门禁照旧（`npm run verify` 在 `open-plan/` 内以 npm 运行）。

## 备选方案

- 进程内 import server：被否——`uncaughtException→exit` 会杀死整个壳且无监督循环；Proma main 为 esbuild CJS 产物，open-plan 含 6 处 `import.meta`。
- 双仓（submodule/产物拉取）：被否——AGPL 衍生需整体开源，单仓最简，避免同步负担。
- 以 open-plan 为主体对齐 Proma 特性（不基于其代码）：被否——用户明确选择 Proma 为壳整体嵌入路线。

## 影响

- web 形态（本仓库 develop）不受影响，继续 0.13.x 列车；桌面改造只发生在 fork 仓库。
- Node 24.18（Electron 内置）与开发基线 Node 22 存在跨代差异：verify 与 P1 真机冒烟须在 Node 24 下加验。
- 内置浏览器宿主参考/复用 Proma `browser-controller.ts`（AGPL 允许）；AX 树观察升级列为 P4 候选。
- 首期不做：自动更新（electron-updater 显式禁用）、存量数据自动迁移、macOS/Linux 打包、内核互通。
