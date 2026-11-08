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
   英文 **Inter**（可变字重）；文件在 `src/renderer/src/assets/fonts/`
   （含两份 LICENSE），@font-face 见 globals.css；
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

## 维护纪律

- 架构、约定、目录、路线变更时**必须同步更新对应文档**，地图失效比没有更糟；
- 新主题优先建新文件放进 `docs/`，索引表加一行；单文件超过 ~150 行就考虑再拆。
