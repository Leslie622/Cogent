# 内置浏览器与聚合面板（调研）

> 纯调研笔记（2026-11-12），尚无代码落点。缘起：对照 ZCode / ChatGPT 桌面版
> 的内置浏览器与面板系统，为后续「浏览器能力 / panel 系统 / 插件双面贡献」
> 立项储备决策依据。对照源：`reference/zcode`（Apache-2.0 全家桶源码）、
> `reference/deepseek-harness`（browser-use 家族）、公开资料与产品截图实证。
> pi 引擎本身**没有**浏览器能力 —— 本主题全部落在客户端层，与引擎正交。

## 1. 问题

Agent 迟早要"上网"（查文档、预览 localhost、带登录态操作网页），桌面产品还要
回答"用户看不看得见"。所谓"内置浏览器"其实是四个正交问题的合体，直接看 UI
会觉得复杂，拆层后每层都朴素：

| 层 | 问题 | 承载 |
| --- | --- | --- |
| L1 渲染 | 真网页画在哪 | Electron WebContentsView / WKWebView / fork Chromium |
| L2 壳 | 标签/地址栏/新标签页谁画 | 宿主 UI（React）自绘，非浏览器内核 |
| L3 感知 | 模型怎么"看"页面 | ARIA/DOM 快照为主、截图按需（成本纪律） |
| L4 操控与信任 | 模型怎么"动手"、用户敢不敢 | 工具注入会话 + 权限审批 + 登录态隔离 |

两个易错认知：新标签页**不是网页**（宿主自绘导航页，列面板与插件入口）；
地址栏是宿主画的 omnibox（非 URL 输入转搜索）。

## 2. 三家实证

### 2.1 ZCode（源码级，reference/zcode）

- L1/L2：`packages/desktop/src/main/browserView/`（WebContentsView 生命周期）+
  `embedded-browser-permission-contract/`（权限契约）+ `desktopNetworkPolicy.ts`；
  横跨主进程 / host / 渲染层 / 原生 helper，是网状工程，不是可单独抠出的模块；
- L3/L4：`apps/zcode-cli/packages/browser-use-plugin/`（即官方市场那个插件的
  源码 `@zcode/browser-use-plugin`；Node REPL 内核由同仓 `node-repl-host`
  承载；iab / extension / cdp 三后端）。感知纪律：`domSnapshot()`（ARIA 树，
  含 shadow DOM / iframe）为主，截图仅在视觉必要时（布局确认 / canvas），
  坐标路径 cua 兜底；"不要同时要 snapshot 和 screenshot"是成本纪律；
- 所见即所操：agent 开标签会自动激活面板给用户看 —— 共享同一 WebContents，
  用户可围观、随时接管；
- 设置面证据：忽略证书校验（本地自签 https dev server）、清缓存（保留
  Cookie）/ 清全部两档、本地 URL 默认开内置浏览器而外链走系统浏览器。

### 2.2 ChatGPT（公开资料 + 截图实证）

- 路线演进：Operator（云端 VM + 纯视觉截图循环）→ Atlas（2025-10，macOS
  Chromium fork，agent 层与 browser 进程 IPC 直连，地址栏内置"本站允许
  ChatGPT 看"开关）→ 2026 折叠进桌面 app 内置浏览器（Atlas 弃用）——
  云端直播浏览器最终被本地共享实例取代；
- 架构泄露：设置页副标题自称 "Browser Use 偏好"；报错横幅
  `plugin 'browser' was not found in marketplace 'openai-bundled'` 证明
  浏览器能力是**内置市场里的插件**而非硬编码功能；
- 成本开关："批注截图（增加套餐用量）"= L3 截图的用量经济学。

### 2.3 DeepSeek-Harness（源码级，reference/deepseek-harness）

- browser-use 是**能力 seam 而非实现**：`packages/browser-use/browser-use`
  的 `ctx.browserUse` 只有一个独占 `register(name)`，刻意不定公共浏览器 API
  （决策记录 `.agents/notes/.../2026-09-12-browser-use-provider-registration.md`：
  通用 API 会在出现可移植消费者之前锁死实验）；
- 三个实验 provider 显式挂载：browser-use-playwright-mcp /
  browser-use-chrome-devtools-mcp / browser-use-stagehand-native；原则一句话
  "DSH owns the task loop; the provider supplies browser operations"；
  工具走正常执行管线进会话日志；
- Session 所有权：launch / attach 二分；单 Session 独占（attach 保留外部
  浏览器登录态，断开只 disconnect 不关浏览器）；登录态不从会话日志恢复；
- 能力域三分：web 家族（web_search / web_fetch，只读取页）≠ browser-use
  （交互浏览）≠ computer-use（CUA 桌面）。

## 3. 插件、内置浏览器、聚合面板的关系

```
Shell（标签系统 + panel 注册表 + 新标签页启动器）
 ├─ 面板：浏览器 / 文件 / 终端 / 审查 / 部署 / 侧聊 / 文档查看器…
 │        每个面板双面：用户视图 + agent 工具面
 └─ 插件市场：一次分发"能力 + 面板"（browser-use、PDF、Excalidraw…）
```

- browser-use 插件 = L3+L4（模型的"手和眼"）；内置浏览器 = L1+L2（"舞台"）。
  耦合点是同一浏览器实例 —— 共享换来围观 / 接管 / 信任；dsh 证明两者可拆
  （纯插件、无 UI 也能成立）；
- **面板双面性**：文件面板 = 用户侧文件树（git 角标）+ 预览面，同时也是
  agent 的展示工具（可锚点高亮指定段落给用户看）；ZCode 文档类插件同时注册
  查看器面板与 open / read / show 类 MCP 工具，是同一表面的两面；
- 引擎无关：这是桌面客户端层的设计，与用什么 Agent 引擎正交。

## 4. 对比 DeepAgent 与引擎路线

- **DeepAgent（LangChain）**：无内置浏览器与面板系统（CLI + 极简 GUI），
  浏览器能力靠 MCP / browser-use 类工具外接 —— 反证：内置浏览器是桌面
  产品层能力，不是引擎层能力；
- 引擎路线对照：**Cogent = pi（借引擎，少数派路线）**；ZCode = 自研引擎
  （apps/zcode-cli/core，desktop 的 host 进程承载；模型层用 Vercel AI SDK，
  佐证 patches/@ai-sdk__anthropic 与 openai-compatible）；dsh = 完全自研，
  底座 Cordis 插件框架（"everything-is-a-plugin"，配 arXiv 论文），agent
  loop 在 packages/core/agent-loop；Claude Code / ChatGPT harness = 闭源
  自研；Cursor = fork VS Code；
- ZCode 的生态策略：不 fork 别人引擎，而是**导入兼容** —— 设置页一键导入
  14 家 Agent（Claude Code / Codex / OpenCode / Goose / …）的 plugins /
  skills / commands / MCP（docs/external-agent-*-import.md）。

## 5. 取舍与 Cogent 路线启示（未立项，仅储备）

1. **抄决策不抄码**（UI 方针既定"不照搬外部成品"）：ZCode 浏览器面板横跨
   五层 + 原生 helper，搬码等于整体重写；可搬的是四层拆分、双面面板、
   seam 注册纪律；
2. dsh 的 seam 纪律最值得先抄：若立项浏览器，先定 ToolKind 与注册点，不急
   定通用浏览器 API；后端保持可替换（对应 iab / cdp / extension）；
3. panel 注册表是聚合平台的地基：批次 5（技能）/ 批次 6（MCP）可把
   「插件贡献工具 + 面板」作为终态；新标签页 = 启动器；
4. 顺序建议：只读预览（localhost dev server，复用审批矩阵）→ agent 驱动
   （共享实例）→ attach 外部浏览器；
5. 精读清单：reference/zcode 的 `main/browserView/`、
   `embedded-browser-permission-contract/`、`host/browserControlMainBridge.ts`、
   `apps/zcode-cli/packages/browser-use-plugin/`、`UI_PLUGIN.md`；
   reference/deepseek-harness 的 `docs/subsystems/browser-use.md` 与上述决策记录。

## 6. 资料锚点

- 本地：`reference/zcode`（348MB 浅克隆，2026-11-12）、
  `reference/deepseek-harness`（packages/browser-use + experimental 三 provider）；
- 线上：[Introducing ChatGPT Atlas](https://openai.com/index/introducing-chatgpt-atlas)、
  [Atlas 架构分析（ByteByteGo）](https://blog.bytebytego.com/p/the-architecture-behind-atlas-openais)、
  [ChatGPT 内置浏览器文档](https://learn.chatgpt.com/docs/browser)、
  [browser-use 开源库](https://browser-use.com)、
  [ZCode 仓库](https://github.com/zai-org/ZCode)；
- 截图实证（2026-11-12）：ZCode 新标签页 / 文件面板 / 浏览器设置页、
  ChatGPT 浏览器设置页（含 openai-bundled 报错横幅）。
