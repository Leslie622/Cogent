# AGENTS.md — Cogent 项目地图（入口）

> Cogent：基于 Electron + [pi](https://github.com/earendil-works/pi) 的桌面 Agent 客户端。
> 完整地图按主题拆在 `docs/`，**本文件只做索引** —— 内容多了不再往这里堆。

## 项目性质与工作方式（每位 AI 动手前必读）

1. **这是学习项目**：作者此前用 DeepAgent 做过桌面 Agent 应用；本项目一半做产品，
   一半是借 pi 逐模块搞懂 Agent 引擎的原理。因此**代码必须小步走**：按 路线.md 的空位
   一项一项实现，每步保持可运行，不一次性铺大摊子；
2. **技术必须沉淀文档**：每实现一个技术模块（工具、MCP、skill、上下文压缩、流式/steering、
   审批……），完成后在 [docs/技术笔记/](docs/技术笔记/README.md) 写一篇该模块的笔记（一模块一文件），
   **必须包含与 DeepAgent 及其他主流 Agent 同主题实现的对比** ——
   这是本项目的核心产出之一，与代码同等重要：**没写笔记 = 没完成**；
3. **所有代码写清晰注释**：中文，讲"为什么"与"边界"，不复述代码（细则见 约定.md §3）。

## UI 设计方针（2026-11-06 起，取代 v0 复刻路线）

1. **协作方式**：不用 v0、不照搬外部成品 —— 用户出「描述 + 截图」，AI 直接实现；
   **写一点、验收一点**，每步保持三关全绿可运行；
2. **技术栈**：React + Tailwind + shadcn。组件风格 = **base-luma**（2026-11-08 用户
   澄清，此前文档误记 Rhea）：存量 `components/ui/` 即该版，新组件经 base-luma
   registry（`r/styles/base-luma/`）安装，配方汇总见
   [docs/UI布局.md](docs/UI布局.md)；**图标 @tabler/icons-react**（2026-11-08
   转正：实心 Filled 变体成对选型，用前 node require 验证存在；lucide 仅存于
   shadcn 原语内部小图标）；
3. **字体随包分发**（不依赖系统安装）：中文 **HarmonyOS Sans SC**（400/500/700）、
   英文 **Inter**（可变字重）、代码等宽 **JetBrains Mono**（可变字重，2026-11-10
   随 Markdown 渲染加入，走 `--font-mono`）；文件在 `src/renderer/src/assets/fonts/`
   （各含 LICENSE），@font-face 见 globals.css；
   **文字色一律实色 token，禁透明度文字色**（`text-x/75` 之类）—— Chromium 对
   半透明文字降级光栅化，笔画发糊发灰、叠不到深黑（2026-11-08 用户对比 ChatGPT
   发现"鸿蒙字体发虚"的根因，字形/字体文件无关）；层级靠实色深浅（次级文字用
   muted-foreground），透明度只许用在背景/hover 底色；
4. **旧界面**：v0 定稿版移入 `legacy/renderer/` 仅作借鉴（引擎接线 stores / IPC /
   main 未动）；2026-11-08 布局收官后**已删除**（git 历史可考），配方沉淀见
   [docs/UI布局.md](docs/UI布局.md)；
5. **UI 文字默认不可选中**（globals.css body `user-select: none`）：chrome/侧栏/
   菜单文字在拖窗、拖分栏、划列表时会蓝底成片选中，纯噪音；正文类内容
   （聊天消息等）到件时在**容器**上 `select-text` 逐处放开。input/textarea
   不受影响（UA 样式表强制可编辑控件内部可选）。

### 区域代号（2026-11-07 定，件 1 布局的叫法 —— 描述/注释/组件命名统一用代号）

```
shell
├─ header            头部：40px 拖拽区，chrome 底色（菜单/窗口按钮属后续件）
└─ body              主体：header 下方全部
   ├─ app-sidebar    应用侧边栏：固定 50px 图标栏，chrome 底色与 header 融合
   └─ content        内容区：白卡（左上圆角 --shell-radius + border-l 自描边 +
      │              紧投影），浮在 chrome 上
      ├─ content-sidebar  内容区侧边栏：240–360px 可拖可折叠（折成 0），微灰底
      └─ content-main     内容区主体：纯白
```

## 地图索引（动手前按需读）

| 文件 | 内容 | 什么时候读 |
| --- | --- | --- |
| [docs/架构.md](docs/架构.md) | 定位、既定决策、进程图、目录地图、依赖方向、构建 | 第一次接触项目 / 要动结构时 |
| [docs/约定.md](docs/约定.md) | 硬规则：防御代码政策（AI 行为规则 + 高频反模式清单）、协议纪律、其他约定 | **每次写代码前**；交付前过一遍 §1.3 产出义务 |
| [docs/技术笔记/](docs/技术笔记/README.md) | 按技术模块一文件的原理笔记 + DeepAgent/主流 Agent 对比（学习项目核心产出） | **实现一个模块后必须写**；做某模块设计前先查有没有前人笔记 |
| [docs/开发.md](docs/开发.md) | 命令、引擎冒烟、dev 自检、环境排障 | 开发 / 验证时 |
| [docs/UI布局.md](docs/UI布局.md) | UI 布局结构、视觉配方、组件配方、技术坑（布局阶段收官总结） | **动任何 UI 前必读** |
| [docs/Agent引擎.html](docs/Agent引擎.html) | Agent 引擎（pi）图文手册：架构、协议方法/事件表、对话时序、模块详解、能力接线、维护指南（单文件零依赖 HTML，改引擎须同步对应节） | **动 agent-service / protocol 前**；了解 Agent 能力现状时 |
| [docs/路线.md](docs/路线.md) | 已实现清单、路线空位、建议实现顺序 | 接到新任务、找该做的事时 |
| [docs/计划-工作区与会话真实化.md](docs/计划-工作区与会话真实化.md) | ~/.cogent 存储根 / 项目（目录绑定）/ 会话持久化与侧栏真实化的分步计划（含决策 D1–D7） | 做存储、项目域、侧栏真实化、创建项目弹窗前必读 |
| [docs/计划-工具系统与审批.md](docs/计划-工具系统与审批.md) | 工具注册 / ToolKind×权限矩阵 / 审批挂起 / 工具卡与审批卡 UI 的分步计划（含决策 D1–D9；批次 1+2 已完成；**已归档**，遗留件并入 计划-pi借鉴.md） | 动现有工具/审批代码时回查决策 |
| [docs/计划-审批交互升级.md](docs/计划-审批交互升级.md) | 审批交互升级（批次 2.5，对照主流三图）：确认面板五件套 / 工作区级允许规则 / 权限模式下拉菜单（自主模式置灰占位）/ 侧栏等待确认 tag（决策 D1–D7；**五步已全部落地** 2026-11-11） | 做审批 UI、权限菜单、审批规则表、侧栏 tag 前必读 |
| [docs/计划-回合过程折叠.md](docs/计划-回合过程折叠.md) | ZCode 式回合两态呈现（过程直播 → 完成收进「已工作」轨迹）+ 用量聚合 + 已停止/出错了头条的分步计划（决策 D1–D8；批次 A 已落地、批次 B 并入 计划-pi借鉴.md，**已归档**） | 动消息流呈现（TurnGroup / MessageRow / run-trace）时回查决策 |
| [docs/计划-pi借鉴.md](docs/计划-pi借鉴.md) | pi-coding-agent 借鉴总纲 + 全部旧计划遗留件归并：**批次 3 工具终章**（2026-11-11，六步全过：截断护栏/并发写队列/edit+bash/自主模式/gitignore 加固）与**批次 4 上下文压缩**（2026-11-12，两步全过：阈值/手动双路 + 折叠条与指示器回落）已落地；后续批次 5 技能命令 / 6 MCP / 7 小件与归并件 / 8 存量对照审计（§1.5 全量过堂）+ 远期池、已封印与不偷清单（决策 D1–D10 已定稿，用户授权按倾向执行） | **唯一活跃主计划，所有新工作按它走**；每批完成回填状态列与 §1.5 销账 |
| [docs/方案-上下文压缩.md](docs/方案-上下文压缩.md) | 上下文压缩完备方案（2026-11-12）：五家全景对比双表（pi / dsh 源码级 / Claude Code / Codex / DeepAgent × 现状 / 方案）+ 小窗输出预算饿死死锁复盘 + 决策 D1–D9（触发公式 `min(占比, 绝对余量)`、双检查点、L1 prune 分层、溢出恢复、思考预算通道；**D9 保留式呈现**：压缩条原位插入、影子区投影裁剪、历史不因压缩消失）| **动压缩相关任何代码前必读**（调研与决策依据） |
| [docs/计划-上下文压缩完备化.md](docs/计划-上下文压缩完备化.md) | 压缩完备化**执行计划**（2026-11-12 立项，批次 4 完结篇）：十维路线选择（每条选项/优缺点/否决理由）+ S1–S8 步骤分解 + 冒烟扩至 14 场景 + 风险边界与否决项汇总；用户定调一步到位不设远期、以 pi 与 dsh 源码为主；**验收修正批次（D9 保留式呈现）已落地**（2026-11-12 GUI 验收后补，见 §2 第四轮） | 做批次 4 完结篇（完备化）任何一步前必读；挂在 计划-pi借鉴.md 批次 4 名下 |
| [docs/计划-测试体系.md](docs/计划-测试体系.md) | 测试体系（2026-11-13 **已一步落地**）：Vitest 三层 —— 单元/组件 70 项（co-located，回归钉为主）+ 集成 98 项（tmp 四冒烟正名迁入 tests/integration，跑构建产物，global-setup 自动补 build）+ Actions CI（windows 单 job）；决策 D1–D9（不做 E2E、覆盖率不设门槛、可测性最小改动） | **动测试 / 加测试命令 / 迁移或新增集成场景 / 动 CI 前必读** |
| `reference/pi/` | pi 上游源码本地参照（sparse clone：agent / ai / coding-agent 三包，MIT；已 gitignore + eslint ignore，**不入库 —— 新机器按 开发.md「reference/pi 上游源码参照」节重新拉**，当前锚点 74dcca7d4） | 写工具、对照官方实现、查引擎源码时；更新走 `git -C reference/pi pull`（仓库级代理已配） |
| `reference/deepseek-harness/` | DeepSeek-Harness 源码本地参照（2026-11-12 浅克隆；同在 gitignore `reference/` 与 eslint `reference/**` 覆盖下，不入库） | 做上下文压缩（方案-上下文压缩.md 的对照源）时查 compaction 包：compaction-basic（触发公式 0.8/64K、8 节摘要模板、KV cache 前缀复用）与 compaction-tool-result-pruner（8192/4096/1024 裁剪）；做浏览器能力调研时查 packages/browser-use（独占注册 seam）与 experimental 三 provider（见 技术笔记/browser-and-panels.md）；更新走 `git -C reference/deepseek-harness pull`（同代理） |
| `reference/zcode/` | ZCode 桌面客户端全家桶源码本地参照（2026-11-12 浅克隆 github.com/zai-org/ZCode，Apache-2.0 + NOTICE；含 desktop / web / server / cli 与全部官方插件源码；同在 gitignore `reference/` 覆盖下，不入库） | 做内置浏览器 / panel 系统 / 插件市场 / provider 配置前看"官方怎么做"：`packages/desktop/src/main/browserView/`、`apps/zcode-cli/packages/browser-use-plugin/`（官方市场插件的源码，含 node-repl-host）、`UI_PLUGIN.md`、`docs/` 数百篇设计文档（external-agent-*-import 的 14 家生态导入兼容）；更新走 `git -C reference/zcode pull`（同代理） |

## 维护纪律

- 架构、约定、目录、路线变更时**必须同步更新对应文档**，地图失效比没有更糟；
- 新主题优先建新文件放进 `docs/`，索引表加一行；单文件超过 ~150 行就考虑再拆。
