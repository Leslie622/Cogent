# Markdown 渲染（助手消息）

> 落点：`src/renderer/src/components/ui/markdown.tsx`、`src/renderer/src/features/home/HomeChat.tsx`、
> `src/renderer/src/globals.css`（--font-mono / --color-chrome-accent / @source）、`eslint.config.mjs`、
> `package.json`（streamdown 全家桶）—— 2026-11-10，路线空位 4 前半（toolcall 呈现半边仍空）。

## 1. 问题

模型的回答本质是 **Markdown 文本流**（标题/列表/表格/代码围栏），不渲染等于丢掉一半信息量；
渲染它对 Agent 客户端有三个流式特有难点：

- **未闭合块**：流到一半的 ``` 围栏、`$$` 公式在纯 react-markdown 下按普通段落渲染，
  闭合瞬间整段跳变（"闪纯文本"）；
- **高频重解析**：chat store 每 delta 全量 setState（`stores/chat.ts` 的 message.delta 分支），
  渲染组件每个 token 都被要求重新解析整条消息；
- **安全与 CJK**：模型输出可含原始 HTML（rehype-sanitize 的必要性）；中文标点紧贴
  `**加粗**`/`~~删除线~~` 时 CommonMark 的 emStrong 边界判定会失效。

## 2. pi 的做法（源码为准，1.5.0）

**引擎层完全不渲染**：`node_modules/@earendil-works/pi-agent-core/dist/` 只有
agent-loop/stream/types 等模块，assistant 内容就是 text block —— 渲染归消费端。

pi 自家消费端是终端（pi 仓库 `packages/tui/src/components/markdown.ts`，约 40KB，tui 包最大组件）：

- **marked.lexer 词法解析 + 自研 token→ANSI 遍历**（不走 marked 的 HTML renderer）：
  `renderToken()` 按块类型分派，行内 token 映射到主题函数（strong→bold、link→OSC 8 超链接）；
- **两级缓存抗流式**：token 树用 `WeakRef` 缓存（树约为源文本十倍大，弱引用防长对话驻留）；
  顶层块按 `token.raw` 为 key 缓存渲染结果 —— 流式时只有最后一个块在变，只重渲染它；
- **防闪细节**：`trimPartialClosingFences` 修剪流到一半的围栏闭合；未闭合 LaTeX 标记
  `pending` 保持原文，避免半截公式被吞；
- **代码高亮可插拔**：`theme.highlightCode?: (code, lang) => string[]`，缺省退回逐行着色；
- **CJK**：`marked-cjk-friendly`（`packages/tui/package.json`）只取其 emStrong tokenizer，
  另自研裸 URL 在 CJK 标点截断、严格删除线正则。

注意与我们的呼应：pi 选 marked 生态 + cjk-friendly 插件；Streamdown 核心同样依赖
marked ^18（remend 的流式修复基础），CJK 走同一 "friendly" 家族的 remark 移植版。

## 3. 对比

| 实现 | 渲染栈 | 流式策略 | 出处 |
| --- | --- | --- | --- |
| pi CLI | marked.lexer → 自研 ANSI 遍历 | WeakRef token 缓存 + 顶层块缓存 + 修剪半截围栏 | `packages/tui/src/components/markdown.ts`（GitHub） |
| DeepAgent (LangChain) | **无 UI 层**，引擎只产 text；其开发态 UI 由 LangGraph Studio 消费 | —— | DeepAgent 为纯 Python agent 库 |
| Claude Code（闭源） | 终端 ANSI 渲染，代码块带语言色 | 行为观察：流式中围栏即时代码渲染 | 闭源，仅行为观察 |
| ChatGPT / Claude Web（闭源） | react-markdown 系组件树 | 整条重渲染（体感有节流） | 行为观察 |
| LobeChat | react-markdown + remark/rehype + **Shiki**（组件在 @lobehub/ui） | rehypeStreamAnimated 等插件 | [lobehub/lobe-ui](https://github.com/lobehub/lobe-ui) `src/Markdown/` |
| Cherry Studio | react-markdown + **Shiki** | 整条重渲染 | [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)（2026-11 仍有 shiki 主题修复提交） |
| **Streamdown 2.7（Cogent）** | 自研渲染器（marked+remark 双栈，hast→JSX） | **remend 修复未闭合块** + 块级 memo + isIncomplete 不缓存高亮 | npm `streamdown@2.7.1`，`dist/chunk-7TTQLYRW.js` |

共同点：Web 端清一色 **react-markdown 范式（组件树输出，无 dangerouslySetInnerHTML）+ Shiki**；
分野在流式策略 —— 自研块缓存（pi、Streamdown）或整条重渲染赌它够快（多数产品）。

## 4. 取舍

- **Streamdown vs react-markdown 自组合**：自组合要自己解决未闭合块（remend）、块级 memo、
  代码块 chrome（复制/下载/语言标签）、sanitize —— Streamdown 全部内置且按 shadcn token
  体系写样式（border-border/bg-muted/font-mono，自动吃本项目主题）。代价是依赖面大
  （15 个直接依赖）；路线空位 4 调研时已定向它，本笔记补齐论证。
- **shiki 重引入 vs 卸载史**：2026-11-08 布局收官清扫时卸过 shiki —— 但那是删未使用的
  code-block 死代码（路线.md 记录在案）。如今：① `@lobehub/icons → @lobehub/ui` 传递依赖
  **本来就在树里带了一份 shiki 4.6.0**（npm ls 实证，dedupe 共享）；② @streamdown/code
  按语言懒加载，build 实测每语言独立 async chunk（cpp 838KB、emacs-lisp 793KB……），
  不用的语言不进启动路径。体积顾虑已不成立。
- **CJK 方案**：`@streamdown/cjk`（remark-cjk-friendly 全家）vs pi 的"只取 emStrong tokenizer"。
  终端场景 pi 精打细割；Web 端整插件代价可忽略，直接用。
- **构建代价（实测）**：渲染图从数千模块涨到 **14909**（shiki 语言生态），构建内存峰值高 ——
  首次 build 曾在 Tailwind oxide 扫描阶段内存分配失败一次，重跑即过。属环境瞬态，
  但 CI/低配机器上值得留意。

## 5. 在 Cogent 的落点

- `components/ui/markdown.tsx`：Streamdown 封装。base-luma registry 无 markdown 件
  （逐名核实 404），按 约定.md §3 手写，同 reasoning.tsx 先例。偏离包默认的三处：
  **① 链接**重写 —— 色走 `--color-chrome-accent`（UI 方针"文内链接专用色"，包默认
  text-primary 在本项目是近黑）；点击 preventDefault 后 `window.open(href)`：主进程只有
  `setWindowOpenHandler` 守卫（`src/electron/main/index.ts:51`），裸 `<a>` 的窗口内导航
  （will-navigate）没人拦会把应用窗口带到外链，window.open 恰好走该守卫转系统浏览器；
  默认的外链确认弹窗（linkSafety）关掉，桌面惯例直接开系统浏览器。**② lineNumbers 关**
  （主流聊天产品无行号）。**③ animated 关**（块入场动画主流均无）。
- `HomeChat.tsx`：`MessageRow` 加 memo —— 历史消息对象引用在 delta setState 中稳定，
  逐 token 重解析只落在流式占位一条（其内部由 Streamdown 块级 memo 摊薄）。
  思考流保持纯文本（主流一致），用户消息气泡同理不做。
- `globals.css`：`--font-mono`（JetBrains Mono 随包分发，CJK 注释回落鸿蒙）；
  `--color-chrome-accent` 补映射（此前只有裸变量）；`@source '../../../node_modules/streamdown/dist'`
  —— v4 自动扫描不进 node_modules，包内 Tailwind 类（代码块 chrome/表格/链接）必须显式扫。
- `eslint.config.mjs`：`no-unused-vars` 放开 `ignoreRestSiblings` —— components 覆盖经
  ExtraProps 收到 hast node，解构丢弃是从 rest spread 剥掉它的标准手法。
- **后续件**：math（KaTeX）/mermaid 插件按需；store 层 delta 节流（当前每 token setState，
  靠双层 memo 扛住，长会话若现卡顿再上）；暗色主题落地时 shiki 双主题（github-light/dark
  已配好，随 `.dark` 切换）。
