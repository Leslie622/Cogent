# 附件读取与 MCP 解耦实现

> 已实现并通过自动回归，H1 已实测通过，H2–H7 待用户手测，结果见第 10 节。承接 [MCP 座升级](MCP座升级实现.md)
> 的 D7（已移除绑定入口、保留后端兼容）。当前事实见[附件模块](../模块/图片与文件附件.md)与 [MCP 座](../模块/MCP座.md)。
> 下文路径相对项目根，行号对应本次实读位置（2026-11-28）。
> 同日按评审修订：补压缩后的 `path`、目录三档降级、外部文本清洗和一处旧文案。

## 1. 目标

让 `read_attachment` 与 MCP 各管各的事：

1. `read_attachment` 只做内置文字提取，不再委托任何 MCP 工具。
2. 图片、音视频、扫描页等内容由模型对着工具目录自己选工具，带附件路径直接调用。
3. 提示词只陈述事实，不写“某类附件用某类工具”的路由。

**不规定种类。** 提示词里没有任何一处写“图片用识图工具、视频用视频工具”。
模型需要的只有两件事实：附件内容有没有发给它，手头有哪些工具。
“这是不是图片”“哪个工具收本机路径”由模型判断。代码里保留的类型判断只有两处，
都与 MCP 无关：是否原生发送（看模型声明的输入能力和 MIME）、`read_attachment` 能否本地解析（看扩展名）。

## 2. 为什么要改

| 现象 | 证据 |
| --- | --- |
| 纯文本模型收到图片时，三处提示都把它引向 `read_attachment` | `src/host/runtime/session.ts:1069`、`src/host/runtime/prompts/reminders.ts:61`、`src/host/runtime/prompts/tools.ts:45` |
| 绑定入口已删，新用户的 `media.json` 为空，`read_attachment` 必然报“未配置可用的 image 分析服务” | 真实 Host 探针 `tmp/mcp-real/evidence/attachment-direct-call-*` |
| 模型自己 `tool_search` 后带路径直接调识图工具是通的 | 同上 |
| 工具目录不可见：pi 的 `tool_search` 不列出可搜索的工具，`mcp_servers` 段只有服务名和数量，模型靠猜关键词 | `node_modules/@earendil-works/pi-coding-agent/dist/extensions/tool-search/tool.js:236-239`、`src/host/kernel/cogent-mcp-extension.ts:126-130` |
| 同一能力两条到达路径；绑定写死 server、tool、参数名，服务端 schema 一变就失效 | `src/host/runtime/read-attachment.ts:85-114` |
| 压缩后的资产索引不带 `path`，早期附件没法交给需要路径的工具 | `src/host/runtime/compaction.ts:305,346-351` |

## 3. 同类做法

本次查了 `reference/` 四个仓和 17 个产品的公开资料，没有一家用内置工具把附件固定转发给某个 MCP 工具。

| 来源 | 做法 |
| --- | --- |
| pi 1.5.2 | `read` 对图片返回 image 块；非视觉模型在请求前换成占位文本。无委托。`packages/coding-agent/src/core/tools/read.ts:105-110`、`packages/ai/src/api/transform-messages.ts:12-14` |
| deepseek-harness 0.2.2-rc.2 | 非视觉模型带图提交即拒绝；`read_image` 先校验模型能力。`packages/api/session-controller/src/commands.ts:349-360`、`packages/fs/tool-fs/src/read-image.ts:124-139` |
| zcode 3.18.1 | `Read` 原生返回图片和 PDF；非视觉模型换成占位文本；deferred 工具至少把名字亮给模型。`apps/zcode-cli/packages/contracts/src/model/media-policy.ts:36-58`、`apps/zcode-cli/packages/core/src/tool/search/description.ts:13` |
| Codex、Cline、ZCode | 不兜底：禁贴图并提示换模型，或留文字占位 |
| Qwen Code、Cherry Studio | 客户端自有视觉后端兜底：指定视觉模型或 OCR；委托对象是一等能力，不是 MCP 工具 |
| 智谱 Vision MCP 文档 | “直接在客户端粘贴图片无法调用此 MCP Server……最佳实践是将图片放到本地目录，通过对话的方式指定图片名称或路径来调用” |

出处：[智谱视觉理解 MCP Server](https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server)、
[Codex settings.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/settings.rs#L404-L428)、
[Cline media.ts](https://github.com/cline/cline/blob/main/sdk/packages/shared/src/llms/media.ts#L3-L12)、
[Qwen Code vision-bridge-service.ts](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/visionBridge/vision-bridge-service.ts#L54-L139)、
[Cherry Studio attachmentRouting.ts](https://github.com/CherryHQ/cherry-studio/blob/main/src/main/ai/messages/attachmentRouting.ts#L2-L25)。
Claude Code、Copilot CLI、Cursor 闭源，只有文档依据；Trae 未查到。

## 4. 当前实现与接入点

| 事实 | 出处 | 影响 |
| --- | --- | --- |
| 媒体委托与嵌套执行；`ctx.executeTool` 在 Host 仅此一处 | `src/host/runtime/read-attachment.ts:85-114`（`delegate`）、`:122-129`（选本地解析或委托） | 删除委托 |
| 参数 `question`、`visual`、`pages` 只为委托服务 | 同文件 `:17-24` | 收敛为 `id`、`cursor`、`sheet`、`range` |
| 工具描述含路由句“图片、视频、扫描件……委托已配置的媒体 MCP” | `src/host/runtime/prompts/tools.ts:43-46` | 只声明能力与边界 |
| 附件块头部和每项 `content` 指向 `read_attachment` | `src/host/runtime/prompts/reminders.ts:55-65`、`src/host/runtime/session.ts:1069` | 改为陈述发送状态 |
| 压缩后的资产索引同样指向 `read_attachment`，且只摘了 `id`、`name`、`mime`、`size` | `src/host/runtime/compaction.ts:305,346-351,370` | 见 5.1 |
| `AttachmentService.path` 在记录缺失时抛错 | `src/host/runtime/attachments.ts:66-69` | 补 `path` 时要容错 |
| `mcp_servers` 段只列服务名、数量和描述首行；服务描述只取首行和长度，没有转义 | `src/host/kernel/cogent-mcp-extension.ts:119-132` | 见 5.2 |
| pi 用 `<段名>…</段名>` 包每个系统提示段 | `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:117` | 外部文本进段前要转义 |
| 技能清单已有三档降级和 XML 转义 | `src/host/runtime/skill-prompt.ts:24-31,72-109` | 5.2 复用同一形状 |
| 图片解码失败的报错写着“切换到分析工具” | `src/host/runtime/session.ts:1063` | 改为中性表述 |
| 扫描页警告写着“需要 document 分析工具” | `src/host/runtime/attachment-parser.ts:74-76` | 去掉指向 |
| 绑定的校验、读写和两个 RPC | `src/host/runtime/attachment-config.ts:8-23,62-68,112-113`、`src/protocol/domains.ts:97-108,120-121`、`src/protocol/method-access.ts:107-108` | 见 5.4 与第 9 节 |
| 渲染层读绑定决定发送按钮文案 | `src/renderer/src/features/home/AttachmentCards.tsx:12-18`、`src/renderer/src/stores/attachments.ts:72,219`、`src/renderer/src/features/home/HomeChat.tsx:385-390` | 改按事实判断 |
| 嵌套审批按 `parentToolCallId` 复用审批桥 | `src/host/runtime/hook-seat.ts:60-66`；集成用例 `tests/integration/mcp.test.ts:173-215` | 见 5.5 |

## 5. 方案

### 5.1 提示词只写事实

| 位置 | 现在 | 改为 |
| --- | --- | --- |
| 附件块头部 | “需要查看文档内容时调用 read_attachment；未解析时须明确说明。” | “content 标明附件内容是否已随本条消息发送；未发送的需要用工具读取，读不到的内容须明确说明。” |
| 每项 `content` | “图片随消息发送” / “尚未读取；需要内容时调用 read_attachment” | “已随消息发送” / “未随消息发送” |
| `read_attachment` 描述 | 末句“图片、视频、扫描件或页面视觉问题委托已配置的媒体 MCP” | “不解析图片、音视频和其他二进制，不渲染页面，也不做图像识别；遇到这类文件会明确报错。” |
| 压缩后资产索引 | “附件（需要查看内容时调用 read_attachment）” | “附件（id 是附件标识，path 是原件路径；内容不在当前上下文中，需要时用工具读取）” |
| 图片解码失败的报错 | “可重新附加或切换到分析工具。” | “可重新附加或检查图片文件。” |

数据边界两句（只使用原始文件名、不暴露 id 和对象路径）不变。模型没收到图片像素时，
`content` 如实写“未随消息发送”，不附原因，也不提任何工具。

压缩后的索引现在不含 `path`，而压缩后模型没有别的途径拿到它。给 `buildShadowSessionAssetsSection`
加一个可选的 `resolveAttachmentPath(id)`：记录和原件都在时补上 `path`，否则不补。
装配点在 `src/host/kernel/pi-session-factory.ts:255-259`，黑盒约束同步改成“切勿暴露内部 id 或 path”。
有了 `path`，支持图片的模型可以用 `read` 重读旧图片，纯文字模型可以把路径交给需要它的工具。
索引不再区分“当初是否原生发送过”，只说内容现在不在上下文里。

### 5.2 工具目录可见

`mcp_servers` 段按服务列出 deferred 工具，分三档降级，形状照搬技能清单（`src/host/runtime/skill-prompt.ts:72-109`）：

| 档 | 条件 | 形式 |
| --- | --- | --- |
| 1 | 整段不超过 4000 字符 | 服务行，加每个工具的名字和描述首行 |
| 2 | 第 1 档超出，只列名字后不超过 4000 字符 | 服务行，加逗号分隔的工具名 |
| 3 | 只列名字也超出 | 退回现在的“服务名 + 数量”；连它也超出时从末尾省略并写明省略数量 |

```text
Available MCP servers. Their tools are not declared upfront: call tool_search with the server or tool name to load its schema.
- zai-vision — 识别图片
  - analyze_image: <描述首行>
  - analyze_video: <描述首行>
```

只列名字时一行是 `- zai-vision — 识别图片 (7): analyze_image, analyze_video, …`。

- 每个工具的描述首行截到 120 字符。只靠工具名模型也能看见 `analyze_image`；
  zcode 的 deferred 工具同样至少把名字亮给模型（`apps/zcode-cli/packages/core/src/tool/search/description.ts:13`）。
- 引导语写“server or tool name”：多个服务有同名工具时带上服务名更准，pi 的检索也吃命名空间文本。
- 服务描述和工具描述都来自外部服务。pi 用 `<段名>…</段名>` 包每个系统提示段，
  所以拼进目录前先并成单行，再转义 `& < >`（目录行是文本不是属性，引号保持原样），
  防止描述里的闭合标签或换行改写提示结构。列出的工具名也走同一处理。
- 工具名只接受 `[A-Za-z0-9_-]+`，否则改列 `qualifiedName`。
- 预算是常量。这只让目录可见，不替模型选工具；`direct` 档的工具已在工具表里，不重复列。

### 5.3 `read_attachment` 只做本地提取

| 附件 | 行为 |
| --- | --- |
| 文本、PDF 文字层、DOCX、XLSX、PPTX | 本地提取；分页和 24000 字符上限不变 |
| 图片、音视频（按 MIME 判断） | 报错“read_attachment 只提取文字，不解析 image/png（a.png）。需要它的内容时，请使用能处理该文件的工具。”不调用任何 MCP 工具 |
| 其他类型 | 交给本地解析器按文本尝试，二进制由它如实拒绝；扩展名不常见的纯文本也能读到 |
| PDF 页没有文字层 | 返回该页结果和警告“本页未提取到文字，可能是空白页或扫描页”，不再委托 |

- 报错只说本工具的边界，不点任何工具或品类的名字。
- 参数收敛为 `id`、`cursor`、`sheet`、`range`。
- `AttachmentToolOptions` 去掉 `bindings`、`mcp`、`getMcp`、`getBindings`、`runtime`、`scope`；
  `session.ts:1908-1912` 的装配同步。
- `requiresVisual` 留在解析结果里当事实标志，不再有消费者；是否清理列入后续。

### 5.4 媒体绑定退役

- `read_attachment` 不再读取 `media.json`。
- 渲染层去掉 `media` 状态和 `attachments.media` 请求，删除已无消费者的 `mediaBindingIssue`。
  `isReferenceOnlyAttachment(ref, imageInput)` 改为：模型不能原生接收且没有本地解析器时，发送按钮显示“作为文件发送”。
- 盘上的 `media.json` 不删除、不迁移。
- `attachments.media` / `attachments.saveMedia` 两个 RPC 的去留见第 9 节。

### 5.5 嵌套审批

- 保留 `src/host/runtime/hook-seat.ts:60-66` 的分支和装配。委托拆掉后 Host 没有工具再发起嵌套调用，
  分支成为安全网：今后任何扩展经 `ctx.executeTool` 调工具，仍经过同一审批桥。注释改成这个意思。
- `tests/integration/mcp.test.ts:173-215` 改写为模型直接调用识图工具，验证允许、拒绝、停止三态仍生效。

### 5.6 文档与决定

- 模块页：[附件](../模块/图片与文件附件.md)的按需读取表和绑定兼容段、[MCP 座](../模块/MCP座.md)的
  资源段与设置页说明、[工具系统](../模块/工具系统.md)首段、[钩子座](../模块/钩子座.md)的嵌套审批行、
  [上下文压缩](../模块/上下文压缩.md)的资产索引说明。
- 技术笔记：[附件](../技术笔记/图片与文件附件.md)的三仓对照表补上本次调研并改写委托一句、
  [MCP 座](../技术笔记/MCP座.md)的提示段、[钩子座](../技术笔记/钩子座.md)的嵌套审批说明、
  [上下文压缩](../技术笔记/上下文压缩.md)的资产索引说明。
- 手测册：[附件](../测试用例/图片与文件附件.md)的 MODEL-04 和第八节、[MCP 座](../测试用例/MCP座.md)的 MCP-35。
- [决定](../决定.md)新增一条：附件读取不委托 MCP；提示词只写事实，品类与工具的对应由模型判断。
- 架构地图不增删进程、通道和存储域，不改图；核对 `docs/架构地图/src/模块说明.ts:928-929` 的对照文字并跑保真校验。

## 6. 边界与非目标

- 不做视觉后端（指定视觉模型转录图片）。Qwen Code 的约束值得借鉴，但它是独立功能，
  涉及模型选择、费用和数据外发披露，需要单独立项。
- 不做 PDF 页面渲染、OCR 和原生音视频输入。
- 不改 MCP 工具的审批分级和默认暴露档。识图工具未声明 annotations，在 plan 模式仍会被拦，
  这与是否经过 `read_attachment` 无关。
- 默认 deferred 下模型要先 `tool_search` 再调用，多一次往返。把服务设为 direct 可以省掉，由用户选择。

## 7. 验收

自动化：

| 层 | 内容 |
| --- | --- |
| `tests/host/runtime/read-attachment.test.ts` | 重写：文本走本地解析且不调用 `ctx.executeTool`；图片、视频、二进制报事实性错误；盘上有 `media.json` 绑定也不委托且文件原样；扫描页返回警告不委托；长输出 artifact 规则不变 |
| `tests/host/runtime/prompts.test.ts` | 附件块和工具描述的新文案；附件块不再出现 `read_attachment` |
| `tests/host/runtime/compaction.test.ts` | 提供解析器且记录、原件都在时索引含 `path`，缺失时不含；约束文案含“id 或 path” |
| MCP 扩展 | `mcp_servers` 段三档各一条；描述含换行和 `</mcp_servers>` 时被并成单行并转义；工具名不合字符集时改列 `qualifiedName` |
| `tests/integration/mcp.test.ts` | 纯文本 mock 模型 + 图片附件 + mock 识图工具：请求体含 `"content":"未随消息发送"`，系统提示目录含 `analyse_attachment`；用工具名 `tool_search` 能加载；带路径直接调用成功；审批三态沿用 |
| 渲染层 | `tests/renderer/stores/attachments.test.ts` 等去掉 `media` 依赖，按钮文案按事实判断 |
| 检查 | 变更文件 lint、Node 与 Web 两个工程的 typecheck、文档检查和上述测试 |

手测（真实模型，应用由用户启动）：

| 编号 | 操作 | 预期 |
| --- | --- | --- |
| H1 | 纯文字模型（如 glm-5.3）+ 已连接的智谱识图 MCP，发一张图问内容 | 模型自行搜索并调用识图工具，带上附件路径；记录往返次数和是否误调 `read_attachment` |
| H2 | 同上，发短视频 | 同上 |
| H3 | 支持图片的模型发图 | 原生发送，不调工具 |
| H4 | 纯文字模型，未配置任何识图 MCP，发图 | 明确说看不到图片内容，不编造 |
| H5 | 发扫描 PDF | `read_attachment` 如实报告没有文字层 |
| H6 | 盘上留有旧的 `media.json` 绑定 | 行为同 H1 或 H4，文件原样 |
| H7 | 长对话触发压缩后，纯文字模型问起早期发过的图片 | 模型从资产索引拿到 `path` 并调用工具 |

H1、H2 的前提是服务已连接。冷启动的 npx 服务可能超过现有的 10 秒连接预算，先在设置页确认。

## 8. 批次

1. Host 行为：5.3、5.5，含单测和集成用例改写。
2. 提示词与目录：5.1、5.2，含提示词单测。
3. 渲染层、文档与决定：5.4 的前三项、5.6，手测 H1–H6。

每批做定向验证。三批合起来动到了提示词、协议类型和 renderer，交付前已跑完整四关，结果见第 10 节
（[验证范围](../约定.md#14-验证范围)）。

## 9. 待裁决

1. **`attachments.media` / `attachments.saveMedia` 的去留。** 推荐本批保留为弃用兼容：没有产品消费者，
   不递增 `PROTOCOL_VERSION`，下次有破坏性协议变更时一并移除。备选是本批直接移除并递增到 4，
   握手链路（`src/electron/main/host/manager.ts:198`、`src/host/host-main.ts:281-309`）要一起验证。
2. **是否在交付前跑完整四关。**
3. **手测 H1、H2 的执行人。** 可以用无头方式跑，但需要用户授权使用其 `Z_AI_API_KEY`。

评审意见与这三项的推荐一致：1 选保留；2 跑一次；3 由用户在桌面端手测，最直观。
用户批准方案即按此执行。

## 10. 验收记录（2026-11-28）

三批已全部实现。系统 Node 24.14.0 下 lint、Node 与 Web 两个工程的 typecheck、生产构建通过。
全量测试共跑四轮：

| 运行方式 | 结果 | 说明 |
| --- | --- | --- |
| `npm test`，系统 Node 24，并行 | 1718/1720 | 失败 2 项：打包闭包 5 秒超时、工作区变更扫描的时序断言，都不在本次改动范围 |
| 同上，最终代码 | 1711/1721 | 运行期间另一套 Cogent 工作区同时跑全量测试，CPU 占满；多出的 5 项全是 5 秒超时 |
| 同上，机器空闲 | 1720/1721 | 只剩打包闭包超时；该测试单独运行耗时在 2.7–8 秒之间波动，放宽超时后断言全过 |
| `COGENT_NODE_BIN` 指向自带 Node 22.23.5，`--maxWorkers 1 --no-file-parallelism` | 1721/1721 通过 | 与 MCP 座升级的验收记录同一口径，耗时 644 秒 |

日志在 `tmp/gate-*.log`。打包闭包测试的 5 秒上限在并行负载下容易触顶，本次没有靠延长超时规避，
是否调整留给用户决定。

真实 Host 复验（mock stdio 服务、mock 模型，`tmp/mcp-real/decouple-verify.mjs`）24/24：在 deferred 无旧绑定、
deferred 盘上有旧 `media.json`、direct 三种配置下，附件块写“未随消息发送”并带 `path`，不指向任何工具；
系统提示目录列出工具名；`read_attachment` 对图片如实报错且不触发 MCP 审批；模型按名字搜索后带路径
直接调用成功；旧 `media.json` 原样未动。架构地图保真校验 30 项通过。

实现时比方案多出的两处：其他类型交给解析器按文本尝试（见 5.3）；目录只转义 `& < >`，引号保持原样，
第三档也受预算约束并在超出时写明省略数量（见 5.2）。

未验证范围：H1 已由用户在桌面端实测通过（记在[附件手测册](../测试用例/图片与文件附件.md#自动化与已有证据)），
H2–H7 待测。压缩后带 `path` 的链路只有单测覆盖索引的构造，真实压缩场景归 H7。
识图工具未声明 annotations 时在 plan 模式仍会被拦，本方案不处理。
