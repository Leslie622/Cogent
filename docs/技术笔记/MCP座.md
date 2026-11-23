# MCP 座 —— Host 管配置，pi 管连接

> 本文解释配置所有权、扩展装配和生命周期；现状见 [MCP座模块](../模块/MCP座.md)。

## 1. 问题

让外部 MCP server 的工具直接进 Agent 循环，但连接管理、工具命名、超时、
OAuth 这些轮子不该重造。Cogent 的拆法：**Host 只管配置与授权**（存哪些
server、谁开谁关、工具过不过审批），**连接与注册全部委托 pi 官方扩展**。

## 2. pi 的做法（装配面）

pi 的 `createMcpExtension(options)` 工厂（`reference/pi/packages/coding-agent/
src/extensions/mcp/index.ts:280`）把全部应用差异留成覆盖点：`loadConfig`
（配置装载）、`updateConfig`（设置写回）、`credentials`（OAuth 存储）、
`logPath`、`startupWaitMs`。关键承诺（index.ts:20-21）：**"Every call runs
through pi's tool pipeline"** —— MCP 工具与内置工具同待遇地过 `tool_call`
钩子与 permission 扩展，Cogent 的链式 beforeToolCall 审批（D8）零新增链路
自动覆盖。配置形状用 pi-mcp 的 `mcpServers` 通用形状（stdio: command/args/
env/cwd；Streamable HTTP: url/headers/oauth），"configurations can be copied
between them" —— 存盘即生态互拷。

## 3. 对比

下表保留原实施调研的对照与出处；这是调研结论迁移，不表示文档整理重新执行了上游测试。
pi 路径以 `reference/pi/packages/coding-agent/src/` 为根；zcode 的 core 路径以
`reference/zcode/apps/zcode-cli/packages/core/src/` 为根，dsh 指 `reference/deepseek-harness/`。

| 主题 | pi（内核，主体） | zcode | dsh | Cogent 采用 |
| --- | --- | --- | --- | --- |
| 扩展入口 | `createMcpExtension(options)` 工厂，`loadConfig`/`updateConfig`/`credentials`/`openUrl` 全部可覆盖 —— `reference/pi/packages/coding-agent/src/extensions/mcp/index.ts:70-92,280` | 自研 runtime methods（`core/src/runtime/methods/mcp.ts:57-195`） | manager/client 分层（`packages/mcp/mcp-manager`） | **pi 工厂 + `loadConfig` 注入 Host 配置**（Cogent 不自研连接管理） |
| 配置格式 | `mcpServers` 通用形状：stdio（command/args/env/cwd）+ Streamable HTTP（url/headers/oauth），"configurations can be copied between them" —— `node_modules/@earendil-works/pi-mcp/dist/config.d.ts:1-96` | 双来源（`.zcode/config.json` 键 `mcp.servers` + `.agents/mcp.json`）—— `mcpSyncService.ts:40-56` | profile YAML + Settings 热编辑 + 插件自注册 | **直接用 pi-mcp 形状存 `~/.cogent/mcp.json`**（与生态互拷；校验用现成 `validateMcpServerConfig`） |
| 作用域/覆盖 | global（agent dir mcp.json）+ project（受信项目 mcp.json）；项目条目无 command/url/type = 只覆盖 `enabled/exposure/toolExposure`（`isMcpServerOverride`，`config.d.ts:111-115`；`OVERRIDE_KEYS`，pi `mcp/config.ts:71`） | user + workspace 双文件 | 六级 rank 目录（技能侧）；MCP 走 profile/插件 | **user 级定义 server；项目级只允许 override**（pi 现成语义 = 天然信任门：低信文件开不了新进程） |
| 工具进 agent | `mcp__<server>__<tool>`；exposure 四档（direct 直接声明 / deferred 经 tool_search / codemode / hidden）—— `mcp/index.ts:8-16,118-122` | 同款命名 + 默认延迟暴露（`tool_search` 目录）—— `mcp/name.ts:3-24` | 同款 + 有损归一化追加 12 位哈希防碰撞 —— `tools.ts:89-105` | **direct 起步**（GUI agent，模型直接用；命名冲突极小概率，pi 已压非法字符） |
| 审批/安全 | **MCP 工具走 pi tool pipeline，permission 扩展与内置工具同待遇** —— `mcp/index.ts:20-21`；stdio env 为叠加式注入（配置显式给才加） | 全部默认 `needsApproval`，按 annotations 分级（readOnly→low/destructive→high）—— `core/src/mcp/index.ts:129-148`；工作区信任门 sha256 —— `workspace-mcp-trust/index.ts:23-36` | stdio 环境清洗（剔 KEY/PASSWORD/SECRET/TOKEN）—— `mcp-client/transport.ts:22-40`；`${credential:REF}` 模板 + 脱敏 | **D8 审批链天然覆盖（pi pipeline）**；MCP 工具 ToolKind 投影默认 ask 档（beforeToolCall 取不到 annotations，原因见下文）；env 沿 pi 配置语义，不增加另一套变量模板或清洗层 |
| 刷新语义 | 连接后台跑，direct 工具的 server 首请求等 `startupWaitMs`（默认 10s）—— `mcp/index.ts:6-8,94` | 回合边界按 `tools/list_changed` 增量刷新 —— `methods/mcp.ts:218-262` | 整代原子交换（失败保旧集）—— mcp-manager README:147 | **首发：配置变更新会话生效**；回合级热刷新列后续 |

### 3.1 SDK 消费者必须自己调 `bindExtensions` —— session_start 不会自己来

**症状**：扩展装进 `extensionFactories`、bundle 里 createMcpExtension 都在，
但 MCP 工具零装载、零诊断，`loadConfig` 从未被调用。

**定位**：pi 的 `session_start` 事件（MCP 扩展装载配置、启动连接的唯一
入口，mcp/index.ts:1115）不是 `createAgentSession` 发的 —— 它由
`AgentSession.bindExtensions()` 发（dist core/agent-session.js:2776），
而 bindExtensions 的调用方全部在 **CLI 产品层**（print-mode.ts:83 /
interactive-mode.ts:2100 / rpc-mode.ts:323）。SDK 层消费者不调它，挂
session_start 的扩展就永远不初始化。Pi-meme 的 SDK 封装同样手工调
（packages/pi-runtime/src/sdk/session.ts:917 `session.bindExtensions({ mode:'rpc', ... })`）
—— 这是「pi 内核 vs CLI 产品」分层的又一个实例（前一次是 /mcp 管理器
为何不存在于 headless）。修法：createPiSession 在 createAgentSession 后
`await session.bindExtensions({ mode: 'rpc' })`。

### 3.2 `tools` 显式列表会过滤扩展工具 —— direct MCP 工具需要 allowlist 放行

**症状**：bindExtensions 修好后 mock server 连上、审批也弹了，但一轮请求
的 tools 数组里没有 `mcp__mock__echo` —— 模型调它只会得到
"Tool not found"。

**定位**：agent-session.js 的 `_isActivatable`（约 1210 行）：allowlist
不匹配的 mcp__ 工具，只有**非 direct** 档（经 tool_search）才可激活；
direct 档必须被 allowlist 匹配（精确名或 `*` 模式，createToolNameMatcher
支持，core/mcp-servers.js:22）。Cogent 的 `tools: COGENT_TOOL_NAMES` 是
显式列表 → direct MCP 工具全部被挡。修法：allowlist 追加
`MCP_TOOL_ALLOWLIST = ['mcp__*', 资源三件]`（tool-meta.ts）。zcode 没有
这个坑是因为它不走 pi 的 tools 选项 —— 自研注册表无此过滤层。

### 3.3 annotations 降级映射：拿不到的边界

zcode 按 MCP annotations 分级（readOnly→低风险，core/src/mcp/index.ts:
129-148）。pi 侧工具定义确实带 annotations（extensions/mcp/tools.ts:
239-273 toToolAnnotations），但审批钩子的载荷 BeforeToolCallContext
（pi-agent-core types.ts:83-92）只有 assistantMessage/toolCall/args/context
—— **不含工具定义**，beforeToolCall 面上取不到 annotations。Cogent 统一投影为 exec；要做降级映射，需要工具注册表查询面，不能从工具名猜只读性。

## 4. 取舍

- **快照 vs 活配置**：loadConfig 返回装配期定格的快照（Pi-meme 手法）——
  进行中会话不受配置变更影响，语义可预期；代价是改配置必须新会话。
  pi CLI 是活的（/mcp 管理器原地生效），但那是交互式管理器的配套，headless
  没有对应的观测面，快照更诚实；
- **项目级仅 override**：pi 允许受信项目 mcp.json 定义 server；Cogent 收紧
  为只收 override（isMcpServerOverride 判别 + 白名单键）—— 项目文件是
  低信面，开新进程的定义权留在 user 级。zcode 的等价物是工作区信任门
  （sha256 digest），更重；首发取轻量版；
- **dispose 不发 session_shutdown**：pi 的 AgentSession.dispose() 只 abort +
  invalidate 扩展上下文，不发 session_shutdown（只有 reload 发）—— MCP
  连接/子进程活到进程退出。pi 自己的 print-mode 也是这个语义（进程退出
  收场）。Cogent 接受同语义并记边界（长跑 Host 高频建删会话时再立项）。

## 5. 在 Cogent 的落点

- `src/host/runtime/mcp-config.ts`：两级文件 store（校验/合并/快照/补丁）；
- `src/host/runtime/tool-meta.ts`：`mcp__*` → exec 档投影 +
  `MCP_TOOL_ALLOWLIST`；
- `src/host/kernel/pi-session-factory.ts`：createMcpExtension 装配 +
  `bindExtensions({ mode: 'rpc' })`（SDK 生命周期补齐）；
- `src/host/host-main.ts`：`mcp.list` / `mcp.sync`（入口收窄 + store 委托）；
- `src/protocol/types.ts`：McpServerDef/McpServerSummary/McpExposure；
- `tests/integration/mcp.test.ts` + `mock-mcp-server.mjs`：端到端
  （协议往返/direct 声明/审批链/回灌闭合/禁用生效）。
