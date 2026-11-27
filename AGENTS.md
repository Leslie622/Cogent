# AGENTS.md — Cogent

Cogent 是 Electron + pi 的本地优先桌面 Agent 客户端。开发从对应的模块入口开始。

## 项目概览

- 技术栈：Electron 40 + electron-vite 6（ESM、TypeScript ~5.9）；渲染层 React 19 + Tailwind CSS 4 + Zustand；Agent 内核为 pi（`@earendil-works/pi-*`）；测试 Vitest 5，lint 用 ESLint 10 flat config（`eslint.config.mjs`）。
- 本地开发建议使用与 CI 一致的 Node 24；安装用 `npm ci`（postinstall 走 patch-package，补丁在 `patches/`）。
- 源码在 `src/`：`electron/`（main、preload）、`host/`（独立 Node 引擎进程，另有对外 MCP Server 入口）、`node/`、`protocol/`、`renderer/`、`shared/`。构建产物在 `out/`；路径别名 `@` → `src/renderer/src`、`@shared` → `src/shared`（tsconfig 与 vitest 保持一致）。
- 测试统一在 `tests/`，按环境分三个 project：`node`（host/shared/electron）、`web`（renderer，jsdom）、`integration`（mock SSE + 真构建产物，串行运行，缺失或过期会先自动 build）。
- `packaging/` 打包脚本，`scripts/` 各类检查脚本，`docs/` 项目文档，`licenses/` 许可清单，`resources/` 资源（含官方 node22 runtime）。

## 按任务找入口

| 要做的事 | 先读 |
| --- | --- |
| 改功能、排查问题 | [模块索引](docs/模块/索引.md)，沿源码入口核对调用链和验收 |
| 改进程、协议、存储或构建边界 | [架构](docs/架构.md)（现状）、[全局架构](docs/计划/全局架构.md)（目标、当前队列） |
| 看目标接线、画流程图、查优化进度 | [架构地图](docs/架构地图/README.md)、[流程图指南](docs/架构地图/流程图指南.md)、[优化修复清单](docs/计划/优化修复清单.md) |
| 改界面 | [UI 布局](docs/UI布局.md)，同时读对应模块页 |
| 验证行为 | [测试命令与分层](docs/模块/测试.md)、[手测入口](docs/模块/测试.md#手测入口) |
| 查设计依据 | [决定](docs/决定.md)、[技术笔记](docs/技术笔记/索引.md) |

## 怎么改

- 写代码或文档前读[约定](docs/约定.md)。局部 UI、小功能、常规修复直接做，可沿现有模式跨协议、Host 和 store 接线。遇到新的机制或技术路线按下一条处理。
- 新架构、能力座、出口、跨模块机制重构或重要技术选型，先与用户对齐调研深度。默认实读 `reference/` 下 pi、deepseek-harness、zcode 的同主题源码，按需补 Pi-meme。重大架构判断再查主流产品公开资料。给出实读版本、文件与行号，旧结论只用于原范围。
- 上述大块实现先在 `docs/计划/` 写目标、对照、方案、边界和验收，用户批准后写实现代码。排除项须说明实际依赖、安全或成本约束，低成本且有收益的功能纳入首发。
- 实现变化同步负责该事实的文档，核对模块页的「验收：」。完成模块时更新对应技术笔记，附同主题 `reference/` 源码对照和出处。同类问题回填原规则和代表场景。
- 日常改动默认定向验证；验证范围、四关触发条件与结果复用按[约定](docs/约定.md#14-验证范围)。报告真实结果，分别说明通过项、已知失败和待验证项。归因须有证据。

## 常用命令

- 安装与启动：`npm ci`（Node 24）；`npm run dev` 由用户启动。
- 完整四关（仅在[触发条件](docs/约定.md#14-验证范围)满足时）：`npm run lint && npm run typecheck && npm run build && npm test`
- 定向单测：`npx vitest run <path>` 或 `node tests/run-tests.mjs run --project node|web|integration`；全量监听 `npm run test:watch`，覆盖率 `npm run coverage`。
- 打包：`npm run pack`（可选 `--win-only` / `--deb-only`）。
- 环境前提（Windows 沙箱 `TEMP` 隐藏目录、`tools.test.ts` 的 `rg`/`fd` 路径）见[测试边界](docs/模块/测试.md#测试边界)。

## 协作与工作区

- 回答简洁直接。提问先回答再动手，回应审查先表明同意或不同意，再说处理结果。
- `reference/` 只读。`npm run dev` 由用户启动。`git add` 只加显式路径，用户未要求时不提交。
- 用户指令与本文件冲突时，先确认。
