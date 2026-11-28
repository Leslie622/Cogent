# MCP 座升级实施方案（对标一线主流产品完整能力）

> 状态：**Batch 1–5 及五项后续收口修复已实现；产品自带 Node 22 全量验收通过，Node 24 首轮原生退出记录见 §8；真实厂商 OAuth、跨平台与人工操作边界见[手测册](../测试用例/MCP座.md)。**
> 自动验收：本轮 lint、Node/Web 类型、生产构建、架构地图 30 项校验通过；Windows 隔离 Electron 已验证损坏凭据仍可启动、原文件保留及实际系统加密读写。完整测试的运行环境和结果见文末，不沿用精简前的计数。
> 后续收口修复：凭据读取失败降为空 OAuth 快照并保留故障和原文件，不阻断启动；写入仍强制系统加密。移除手动密钥体系、自动 UUID 迁键及附件绑定 UI；静态凭据由用户配置或环境变量提供。登出与状态广播按真实 OAuth 授权和当前作用域收紧。现状以[模块](../模块/MCP座.md)和[技术笔记](../技术笔记/MCP座.md)为准，本轮完整验收记录见文末。
> 最终裁决：
> - **D1 范围**：全量到位（M1–M7 + M8 全套协议原语，不做保守降级）；
> - **D2 连接所有权**：**Host 级 `McpRuntimeManager` 统一持有连接池与状态流**，底层复用 `@earendil-works/pi-mcp` 客户端/传输/OAuth，通过自定义 pi 扩展桥接进会话（对「决定 27」中 MCP 装配方式做正式演进升级）；
> - **D3 默认暴露档**：默认 **`deferred`**（配合 `tool_search` 延迟加载），支持按 server 切 `direct` 与单工具启停（`toolExposure`），彻底修复缺省落 `codemode` 导致不可用的问题；
> - **D4 凭据安全（后续裁决更新）**：仅 OAuth Token/State 由 Electron 壳侧 `safeStorage` 静默托管；不提供手动密钥管理或 `${secret:KEY}`，不自动改写静态配置；支持环境变量引用和 stdio 敏感宿主环境清洗；
> - **D5 项目级定义**：完整支持项目根 `.cogent/mcp.json` 与 `.mcp.json` 定义新 server，配 **`projectId + sha256` 工作区信任门**；
> - **D6 传输层**：支持 `stdio` + `streamable-http` + Legacy `sse`；
> - **D7 附件分析工具（后续裁决更新）**：移除 MCP 设置页的专用绑定配置与搜索入口；保留 `read_attachment` 内置解析及既有后端绑定兼容，不在本轮扩展多媒体管线（后端委托随后由[附件读取与 MCP 解耦](附件读取与MCP解耦实现.md)移除）；
> - **D8 对外 MCP UI**：本次**不做**，保持 MCP 设置页聚焦于 MCP 客户端管理（与 zcode / Cursor 一致）。
>
> 关联模块：[MCP座](../模块/MCP座.md)、[工具系统](../模块/工具系统.md)、[审批与权限](../模块/审批与权限.md)、[凭据与模型目录](../模块/凭据与模型目录.md)、[交互座](../模块/交互座.md)、[图片与文件附件](../模块/图片与文件附件.md)、[消息呈现](../模块/消息呈现.md)、[设置页](../模块/设置页.md)。
> 关联笔记：[MCP座技术笔记](../技术笔记/MCP座.md)、[技能座升级实现](技能座升级实现.md)（可复用 `template-vars.ts`）。

---

## 1. 背景与升级目标

Cogent 阶段 4a 基于 pi `createMcpExtension` 跑通了最小闭环，但在对标 Claude Code、Cursor、Claude Desktop 以及参考仓（`pi`、`zcode`、`deepseek-harness`）时存在明显架构瓶颈：

1. **连接与会话强耦合**：每个 pi 会话独立建连，开 5 个会话会起 5 套重复的 `npx` 子进程；设置页无连接状态/工具数/stderr 诊断；配置改动或 OAuth 登录后必须新建会话才生效；且 pi `AgentSession.dispose()` 不触发 `session_shutdown`，导致 `stdio` 子进程泄漏至 Host 退出。
2. **远程 OAuth 2.1 缺失**：Sentry、Linear、Notion、Figma、GitHub 等主流远程 MCP 均依赖 OAuth 2.1（PKCE + DCR/CIMD），目前 `McpServerDef`（[types.ts:879](../../src/protocol/types.ts#L879)）与 `McpConfigStore`（[mcp-config.ts:95-112](../../src/host/runtime/mcp-config.ts#L95-L112)）未保留 `oauth` 字段，无登录流与安全托管。
3. **上下文爆炸与默认暴露陷阱**：目前仅实际启用 `direct`，未装配 pi 内置 `createToolSearchExtension()`；导入外部 `mcpServers` JSON 未写 `exposure` 时默认落 `codemode`，导致未装 `codemode` 的 Cogent 中工具静默不可达。
4. **配置丢字段与环境隔离**：编辑保存丢弃 `oauth` / `toolExposure` / 未知扩展字段；不支持 `${ENV_VAR}` / `${workspaceFolder}`；`stdio` 子进程未隔离宿主模型 API Key。
5. **审批一刀切 & 项目协作受限**：[tool-meta.ts:113-116](../../src/host/runtime/tool-meta.ts#L113-L116) 将全部 `mcp__*` 投影为 `exec` 档，只读查询工具也反复弹审批；项目级无法定义 `.mcp.json` 新 server。
6. **协议原语与体验未闭环**：Resources 无前端 `@` 引用；Prompts 未接入 `/` 命令；未支持 MCP `2025-06`/`2025-11` Elicitation；Legacy SSE 被拒绝；对话流 MCP 工具卡与富内容呈现较粗糙。

**升级目标**：在不重造 MCP 协议轮子、严守「决定 28」审批安全边界的前提下，将 Cogent 的 MCP 座一次性升级至**一线主流产品完整水位**。

> **关于「决定 27」的架构演进说明**：阶段 4a 采用 pi 上层 `createMcpExtension` 托管连接。本次演进为 **Host 级 `McpRuntimeManager` 直接复用 `@earendil-works/pi-mcp` 底层 `McpClient` / `StdioTransport` / `StreamableHttpTransport` / `oauth`**，仅接管“连接池生命周期、状态流推送、热刷新与安全存储”，并通过自定义 pi 扩展把工具与资源注入 pi 会话、装配 pi 内置 `createToolSearchExtension()`。所有 MCP 工具调用仍 100% 经由 pi 工具管线与 Cogent `beforeToolCall` 审批链执行。定稿落地后同步更新 [决定.md](../决定.md) 与 [MCP座技术笔记](../技术笔记/MCP座.md)。

---

## 2. 调研与对照（实读版本与出处）

- **实读源码版本**：
  - `pi`：`74dcca7d4`（`@earendil-works/pi-coding-agent@1.5.2`、`@earendil-works/pi-mcp@1.5.2`）
  - `zcode`：`c5904686`
  - `deepseek-harness`：`e8f7b93a`
  - `Pi-meme`：`8e39e3b`
- **行业标准与产品**：Claude Code、Cursor、MCP Specification `2025-06-18` / `2025-11-25`。

| 能力维度 | Claude Code / Cursor | `pi` (`74dcca7d4`) | `zcode` (`c5904686`) | `deepseek-harness` (`e8f7b93a`) | Cogent 升级目标 |
| --- | --- | --- | --- | --- | --- |
| **连接所有权与状态观测** | 实时状态灯、工具列表、重连、错误与 stderr | `/mcp` 展示状态/工具数/stderr tail（`extensions/mcp/runtime.ts:51,59`） | 连接池 + `McpStatusDot` + `McpFailurePresentation`（`packages/ui/src/settings/McpSettingsSection.tsx:38,61`） | `McpServerManager.watch()/probe()/restart()`（`packages/mcp/mcp-manager/src/index.ts`） | **Host 级 `McpRuntimeManager`** 统一连接池 + 实时事件流 `mcp.statusChanged` + 诊断/stderr 尾部 + 重连 |
| **OAuth 2.1 认证** | 浏览器 PKCE + DCR + Keychain | `@earendil-works/pi-mcp/oauth` 完整实现（`extensions/mcp/oauth.ts:66-239`） | OAuth 回调、租约、跨进程刷新 | 凭据注入与模板解析 | 复用 `pi-mcp/oauth` + **壳侧 `safeStorage` 加密托管** + `shell.openExternal` + 手动粘贴兜底 |
| **延迟加载与单工具控制** | Claude Code Tool Search；Cursor 单工具开关 | `createToolSearchExtension()` + `deferred` + `toolExposure`（`extensions/tool-search/index.ts:12-16`） | 默认延迟暴露 + `tool_search` | 注册表策略控制 | **默认 `deferred`** + 装配 `createToolSearchExtension()` + UI 单工具启停/暴露档切换 |
| **变量替换与密钥隔离** | `${ENV_VAR}` / `${env:VAR}` / `${workspaceFolder}` | `resolveConfigValueOrThrow` 支持 `${VAR}` 与 `!command`（`extensions/mcp/runtime.ts:109-116`） | 模板按 `allowSensitive` 隔离（`adapters/src/plugins/mcp.ts:402-463`） | `${credential:REF}` + stdio 敏感 env 清洗 | 沿用 [template-vars.ts](../../src/host/runtime/template-vars.ts) 的上下文与敏感 sink 边界，由 `mcp-env.ts` 补齐 MCP 专用语法（见 §4.1.2）+ stdio 敏感 env 清洗 |
| **项目级定义与信任门** | `.mcp.json` + 首次信任确认 | 受信项目 `.pi/mcp.json` | 向上扫至 `.git`，`projectId + sha256` 持久化信任（`docs/design/v2/mcp.md:120-167`） | profile 作用域隔离 | 识别 `.cogent/mcp.json` + `.mcp.json`，**`projectId + sha256` 信任门**，文件变动自动失效重审 |
| **审批分级** | Annotations 提示 + 工具白名单 | 工具带 `toToolAnnotations`（`extensions/mcp/tools.ts:239-273`） | 按 `readOnlyHint`/`destructiveHint` 分级（`core/src/mcp/index.ts:60-104`） | 工具注册表策略 | 从 `McpRuntimeManager` 查 `annotations` 给 `ApprovalBridge`，区分只读/破坏性，支持单工具信任 |
| **协议原语** | Resources + Prompts `/` + Elicitation | `McpClient` 原生支持 `request()` / `setRequestHandler()` / `onNotification()`（`pi-mcp/dist/client.d.ts:46-50`） | v4 `mcp-elicitation.ts` | Resources 三件套 | 全补齐：Resources `@` 引用 + Prompts `/` 命令 + Elicitation（Form/URL 面板） |
| **传输层** | stdio / Streamable HTTP / SSE | stdio + Streamable HTTP（拒 SSE） | stdio + Streamable HTTP + SSE | stdio + Streamable HTTP | **stdio + Streamable HTTP + Legacy SSE** |

---

## 3. 总体架构与数据流

```text
Electron Main (壳侧)
  ├─ src/electron/main/credentials/mcp-store.ts  (safeStorage 加密存 OAuth Token/State)
  ├─ src/electron/main/ipc/mcp.ts                (特权 IPC: 交互响应 / 唤起浏览器 openExternal / 配置检测导入)
  └─ 启动 handshake + 变更同步 ──▶ 注入 OAuth 状态到 Host 内存（不落 Host 盘）
                                        │ stdio JSON-RPC
                                        ▼
Host 引擎进程 (src/host/)
  ├─ McpConfigStore (mcp-config.ts)              两级配置: ~/.cogent/mcp.json + 项目 .cogent/mcp.json / .mcp.json
  ├─ McpTrustStore (mcp-trust.ts)                工作区信任门: ~/.cogent/mcp-trust.json (projectId + path + sha256)
  ├─ McpSecretBridge (mcp-secrets.ts)            仅 OAuth 状态桥，写回等待 main 加密提交确认
  ├─ McpRuntimeManager (mcp-runtime.ts)          【核心】单实例连接池（按 scopeKey 管理 McpClient 实例）
  │     ├─ 传输层: StdioTransport(含env清洗+进程组回收) / StreamableHttpTransport / SseTransport
  │     ├─ 能力缓存: tools(含annotations) / resources / resourceTemplates / prompts / instructions / stderrTail
  │     ├─ OAuth 控制器 (mcp-oauth.ts): 复用 @earendil-works/pi-mcp/oauth (PKCE/DCR/CIMD/loopback)
  │     ├─ Elicitation 路由器 (mcp-elicitation.ts): 拦截 client.setRequestHandler('elicitation/create') → 推交互面板
  │     └─ 事件广播: notify('mcp.statusChanged', snapshot) → 实时推给设置页与顶部状态栏
  └─ 会话装配 (pi-session-factory.ts)
        ├─ createCogentMcpExtension({ runtime, cwd, projectId }) ── 桥接工具/资源三件套 + mcp_servers 段 + 动态同步 tools/list_changed
        ├─ createToolSearchExtension()                  ── 激活 deferred 工具按需搜索加载
        └─ ApprovalBridge                               ── 查询 runtime.getToolAnnotations(toolName) 做分级裁决
```

---

## 4. 详细技术规格

### 4.1 配置模型、无损往返、变量替换与多生态导入

#### 4.1.1 协议与存储模型（`src/protocol/types.ts` + `src/host/runtime/mcp-config.ts`）
扩展 `McpServerDef` 与 `McpServerSummary`（向后兼容，新增字段全部可选）：

```ts
export type McpTransportType = 'stdio' | 'http' | 'sse'
export type McpExposure = 'direct' | 'deferred' | 'codemode' | 'hidden'

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  callbackPort?: number
  callbackUrl?: string
  scope?: string
  clientName?: string
  clientRegistration?: 'auto' | 'dcr' | 'cimd'
  authServerMetadataUrl?: string
}

export type McpServerDef = { name: string } & (
  | {
      type: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      /** 是否清洗宿主敏感环境变量（*_API_KEY/*_SECRET/*_TOKEN/*_PASSWORD），缺省 true */
      sanitizeHostEnv?: boolean
    }
  | {
      type: 'http' | 'sse'
      url: string
      headers?: Record<string, string>
      oauth?: McpOAuthConfig
    }
) & {
    description?: string
    enabled?: boolean
    /** Cogent 默认档统一改为 'deferred'（不再静默回落未装载的 'codemode'） */
    exposure?: McpExposure
    /** 单工具粒度暴露覆盖：精确工具名或 * 通配 → McpExposure */
    toolExposure?: Record<string, McpExposure>
    /** 每请求超时秒数，缺省 60 */
    timeout?: number
    /** 透传保留的未知扩展字段（编辑保存时原样写回，不静默丢弃） */
    extraFields?: Record<string, unknown>
  }
```

- **默认暴露档修复**：`McpConfigStore` 中凡未显式指定 `exposure` 的条目，有效值一律回落为 **`'deferred'`**（用户手写 `'codemode'` 时在 UI 标记提示并按 `'deferred'` 处理，避免静默不可达）。
- **无损写盘**：`McpConfigStore.sync` / `defToRaw` 保留 `oauth`、`toolExposure`、`cwd`、`timeout`、`sanitizeHostEnv` 以及 `extraFields`；`type: 'sse'` 显式写出 `"type": "sse"`（不走 pi-mcp 拒绝 sse 的旧校验分支，对 `sse` 在 `mcp-config.ts` 补同构 URL/headers/oauth 校验）。

#### 4.1.2 受控变量替换与密钥安全
新建 `src/host/runtime/mcp-env.ts`，沿用 [template-vars.ts](../../src/host/runtime/template-vars.ts) 的单遍替换与敏感 sink 边界，实现 MCP 配置专用语法。共享正文解析器保持既有语义，不向技能正文开放宿主环境：
- **支持占位符**（仅在建立传输连接瞬间解析，绝不回写磁盘、绝不进日志/Prompt/UI 状态回包）：
  - `${ENV_VAR}` 或 `${env:ENV_VAR}`：读取宿主 `process.env[ENV_VAR]`（支持 `${VAR:-default}` 默认值语法）；
  - `${COGENT_PROJECT_DIR}` / `${workspaceFolder}`：当前作用域项目主根；
  - 不再解析 `${secret:KEY}`；旧引用在建连时明确报错并提示改为环境变量，原文件不自动还原或重写。
- **解析合同**：仅对原始配置执行单遍替换，环境值及默认值中的占位符不递归展开；`${VAR:-default}` 在变量未定义或为空时取字面量默认值；无默认值且未定义的环境变量报 `MCP_MISSING_ENV:<NAME>`，不将未解析占位符传给 server。
- **解析目标字段**：stdio 的 `command` / `args[]` / `cwd` / `env[k]`；http/sse 的 `url` / `headers[k]` / `oauth.clientSecret`。
- **stdio 宿主环境隔离**：当 `sanitizeHostEnv !== false` 时，构造子进程 `env` 前剔除宿主 `process.env` 中匹配 `/(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)$/i` 的键（用户在本 server `config.env` 中显式声明的键不受影响，正常注入）。

#### 4.1.3 多生态配置导入（`src/renderer/src/features/settings/mcp-import.ts`）
扩展 `parseImport` 支持以下格式自动识别与归一化：
1. 标准 `{ "mcpServers": { ... } }`（Claude Desktop / Claude Code / Cursor / Cogent）；
2. VS Code 格式 `{ "servers": { ... } }`（支持 `type: "stdio" | "http" | "sse"`；合法变量名的 `${input:NAME}` 转成 `${env:NAME}` 并提示配置环境；不合法名称保留并提示手动替换）；
3. OpenCode 格式（`"type": "local"` 数组 `command` 拆为 `command + args`，`environment` → `env`，`{env:NAME}` → `${NAME}`）；
4. 主进程提供只读探测 IPC（`mcp:detectExternalConfigs`），检测本机 `~/.claude.json`、`~/.cursor/mcp.json`、Claude Desktop 配置文件路径，允许用户在导入弹窗中一键勾选导入（仅读取用户确认选择的文件）。

---

### 4.2 项目级 `.mcp.json` 定义与工作区信任门（`src/host/runtime/mcp-trust.ts`）

#### 4.2.1 发现与合并优先级
给定项目主根 `cwd`，按递增优先级合并：
1. 用户级定义：`~/.cogent/mcp.json`（`origin: 'user'`，天然受信）；
2. 仓库标准文件：`<cwd>/.mcp.json`（`origin: 'project-file'`）；
3. Cogent 项目文件：`<cwd>/.cogent/mcp.json`（`origin: 'project-cogent'`）。

规则：
- 若项目级条目**仅含** `enabled` / `exposure` / `toolExposure`（无 `command` / `url` / `type`），仍按现有 **override 语义**覆盖同名用户级 server，**无需信任审批**；
- 若项目级条目**定义了新 server**（含 `command` / `url` / `type`），则标记 `origin: 'project'` 并进入**工作区信任门**；相对 `cwd` 以项目根解析。

#### 4.2.2 `projectId + sha256` 信任持久化
文件位置：`<COGENT_HOME>/mcp-trust.json`（原子写入）：
```ts
interface McpTrustRecord {
  /** Cogent 项目注册表中的稳定 ID，不以目录名代替 */
  projectId: string
  /** 规范化真实路径 realpathSync.native(filePath) */
  filePath: string
  /** 文件内容 UTF-8 的 sha256 hex */
  sha256: string
  /** 信任的 server 名集合（或 '*' 表示整文件） */
  trustedServers: string[]
  decidedAt: string
}
```
- **身份与匹配**：信任记录按 `projectId + filePath` 定位，并同时核对 `sha256` 与 `trustedServers`。`projectId` 来自当前会话归属或设置页选中的项目；Host 按项目注册表校验其主根与 `cwd` 的真实路径一致，不凭同名目录推断身份。缺少有效项目身份时不得授权项目定义；复用池连接前也必须先通过调用项目的信任检查。
- **Fail-closed 纪律**：任何 `origin !== 'user'` 的新定义 server，若其当前项目、来源文件、`sha256` 或 server 名与信任记录不匹配，状态强制为 `untrusted`——**不建立连接、不启动子进程、不发网络请求、不暴露任何工具/资源/提示词给模型**。
- **审批展示**：`mcp.list` 接受可选 `projectId`（与 `cwd` 一致性校验），返回每个项目的待审文件摘要（`projectId`、文件路径、server 列表、type、command/url、声明的 env/header **键名列表**，绝不回传值）。用户点击「信任并启用」调用 `mcp.trust.decide({ projectId, cwd, filePath, sha256, decision: 'trust' | 'reject' })`；后端核对项目归属及来源文件路径，并二次校验当前磁盘文件 `sha256` 防止 TOCTOU 竞争，写入后立即触发 `McpRuntimeManager` 建连。

---

### 4.3 Host 级 `McpRuntimeManager`（`src/host/runtime/mcp-runtime.ts`）

#### 4.3.1 连接池模型与作用域键
- **复用策略**：
  - 用户级无项目路径依赖的 server（`stdio` 的 `cwd` 未指向项目根、且 `args`/`env` 不含 `${workspaceFolder}`）：全局共享**唯一连接实例**（`poolKey = global:<name>`），跨所有会话与项目复用，彻底消除多会话重复 spawn 子进程；
  - 依赖项目路径的 server（项目级定义，或配置含 `${workspaceFolder}` / 相对 `cwd`）：按 `poolKey = project:<realpath(cwd)>:<name>` 隔离连接实例，同一项目下多会话共享，项目切换/关闭闲置超期（默认 15 分钟无活跃会话引用）后自动关闭回收。
- **状态机**：
  ```ts
  export type McpConnectionState =
    | 'disabled'
    | 'untrusted'
    | 'connecting'
    | 'connected'
    | 'needs-auth'
    | 'disconnected'
    | 'failed'
  ```
- **运行时快照**（`McpServerRuntimeStatus`）：
  `name`、`poolKey`、`state`、`latencyMs?`、`serverInfo?`（name/version）、`instructions?`、`protocolVersion?`、`tools: McpToolInfo[]`（含 `name`、`qualifiedName`、`description`、`inputSchema`、`annotations`、`effectiveExposure`）、`resourcesCount`、`promptsCount`、`error?`、`stderrTail?`（最近 4000 字符）、`updatedAt`。

#### 4.3.2 传输层与 Legacy SSE 适配（`src/host/runtime/mcp-transports.ts`）
- `stdio`：直接复用 `@earendil-works/pi-mcp` 的 `StdioTransport`（`stderr: 'pipe'` 收集尾部日志至 `stderrTail` 并写入 `<COGENT_HOME>/pi/mcp.log`）。
- `http`（Streamable HTTP）：直接复用 `@earendil-works/pi-mcp` 的 `StreamableHttpTransport`，注入 `McpAuthProvider`（OAuth）与已解析的 `headers`。
- `sse`（Legacy SSE）：新建 `SseTransport implements McpTransport`（约 120 行，零新外部依赖，用 Node 22 内置 `fetch` + SSE 行解析）：
  1. `GET <url>`（带 `Accept: text/event-stream` 与解析后的 `headers` / OAuth Bearer）建立事件流；
  2. 收到首条 `event: endpoint` 解析 POST 目标 URL（支持相对路径）；
  3. `send(message)` 向该 endpoint 发送 `POST` JSON-RPC 帧；
  4. `event: message` 分发给 `McpClient.onmessage`；支持 `close()` 中止 `AbortController`；遇 `401` 抛出 `McpAuthRequiredError` 触发统一 OAuth 流程。

#### 4.3.3 动态事件与确定性子进程回收
- **协议通知监听**：连接成功后立即注册：
  - `client.onNotification('notifications/tools/list_changed', ...)` → 重新 `listTools()`，原子替换缓存并广播 `mcp.statusChanged` + 通知所有绑定的活跃 pi 会话在下一回合边界刷新工具集；
  - `client.onNotification('notifications/resources/list_changed', ...)` → 刷新资源缓存并广播；
  - `client.onNotification('notifications/prompts/list_changed', ...)` → 刷新提示词缓存并广播；
  - `client.onNotification('notifications/message', ...)` → 写入 `mcp.log`（超 5MB 轮转 `mcp.log.1`）。
- **确定性回收（根治子进程泄漏）**：
  - `McpRuntimeManager.disposeAll()` 注册在 Host 退出（`SIGINT`/`SIGTERM`/`stdin end`）及 `mcp.sync` / `mcp.override` / `mcp.reconnect` 配置变更时；
  - 关闭 `stdio` 连接时先 `client.close()`，超时 2s 后向进程组发 `SIGTERM`（Windows 走 `taskkill /T /F /PID`），再等待 1s 强杀 `SIGKILL`，保证 `npx`/`uvx` 孙进程零残留；
  - `SessionManager` 销毁会话不再持有连接，只需递减对应 `poolKey` 的会话引用计数。

---

### 4.4 pi 会话桥接扩展、`deferred` + `tool_search` 与单工具暴露

#### 4.4.1 自定义 pi 扩展（`src/host/kernel/cogent-mcp-extension.ts`）
替代原 `createMcpExtension` 装配，在 [pi-session-factory.ts](../../src/host/kernel/pi-session-factory.ts) 中注入：
1. **`createCogentMcpExtension({ runtime, cwd, projectId, onToolsRefreshed })`**：
   - 订阅 `runtime` 中当前 `cwd` 作用域下全部已启用且受信的 server；
   - 将每个 server 的工具按 `mcp__<namespace>__<tool>`（复用 `createMcpToolName` 与碰撞哈希）注册为 pi `ToolDefinition`：
     - `effectiveExposure === 'hidden'`：不注册；
     - `effectiveExposure === 'direct'`：`defaultActive: true`，首轮请求最多等待 `startupWaitMs`（默认 10s）就绪；
     - `effectiveExposure === 'deferred'`：`defaultActive: false`，由 `tool_search` 按需激活进入本分支活跃工具集；
   - 挂载标准 MCP 资源三件套（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`），直接委托 `runtime.listResources` / `readResource`，当且仅当存在提供资源的 server 时激活；
   - 在 `before_agent_start` 维护 `mcp_servers` 系统提示段：仅列出有 `deferred` 工具的 server 名称、一句描述（优先配置 `description`，次选 `server.instructions` 首行，限 250 字）和工具数，引导模型按需调 `tool_search`；
   - **回合边界热同步**：若 `McpRuntimeManager` 发生重连、配置变更、`tools/list_changed` 或 OAuth 登录成功，扩展在 `before_agent_start` 自动对比 revision，增量注册/注销工具并更新 `mcp_servers` 段——**无需新建会话即可热生效**；
   - **大结果保护**：继续沿用现有 `spillMcpToolResult`（24K 落盘），并正确转发 MCP 返回的 `image` content block 与 `structuredContent`。
2. **装配 `createToolSearchExtension()`**：
   - 在 [pi-session-factory.ts](../../src/host/kernel/pi-session-factory.ts) `extensionFactories` 中加入 pi 官方 `createToolSearchExtension()`；
   - 将 `'tool_search'` 加入 `MCP_TOOL_ALLOWLIST` 与 [tool-meta.ts](../../src/host/runtime/tool-meta.ts)（`kind: 'read'`，免审批，摘要 `tool_search(<query>)`）；
   - 当本会话存在任一 `deferred` MCP 工具时自动激活 `tool_search`。

---

### 4.5 远程 MCP OAuth 2.1 认证与 `safeStorage` 凭据托管

#### 4.5.1 壳侧加密存储（`src/electron/main/credentials/mcp-store.ts`）
参照现有 [credentials/store.ts](../../src/electron/main/credentials/store.ts) 模式，独立维护 `<COGENT_HOME>/mcp-credentials.json`（`safeStorage.encryptString` 加密落盘，绝不降级明文）：
```ts
interface McpCredentialFile {
  version: 1
  /** OAuth 状态：key = sha256(名字、URL、真实作用域) */
  oauthStates: Record<string, string>   // key -> base64(safeStorage密文(JSON.stringify(McpOAuthState)))
}
```
- **主进程 ↔ Host 桥接**：
  - 启动 `initialize` 时主进程只将解密后的 `mcpOAuthStates` 经 stdio 注入 Host 内存；旧文件的 `secrets` 字段不消费、不解密，读取时不改写。
  - Host 侧 `McpOAuthCredentialStore` 在 token 刷新或登录完成后，通过 Host → Main 专用回调事件/请求 `mcp.oauth.persistState` 写回主进程 `safeStorage` 加密落盘（并发刷新锁仍复用 `McpRuntimeManager` 进程内串行队列）。
  - 私有 `mcp.secrets.sync` 保留内部名称，负载仅 `{ oauthStates }`；删除手动密钥 IPC 与写入事件。JSON、密文或系统安全存储读取失败时记 `startupError` 并提供空快照，不阻断握手、不覆盖旧文件；显式 OAuth 加密写入成功后才自愈。

#### 4.5.2 OAuth 登录流（`src/host/runtime/mcp-oauth.ts`）
复用 `@earendil-works/pi-mcp/oauth`（`startMcpSignIn` / `listenForLoopbackSignIn` / `waitForLoopbackSignIn` / `completeMcpSignIn` / `createMcpAuthProvider`）：
1. 用户在设置页点击某 `needs-auth` HTTP/SSE server 的「登录」→ 调 `mcp.oauth.login({ name, cwd? })`；
2. Host 启动 loopback 回调服务器并生成 PKCE `authUrl`，经 `mcp.oauth.openUrl` 事件通知 Electron 主进程调用 `shell.openExternal(authUrl)`（同时返回 `authUrl` 给前端弹窗作为「若浏览器未打开可复制链接 / 手动粘贴回调 URL」兜底）；
3. 浏览器授权回调后 `completeMcpSignIn` 换取 token → 经 `mcp.oauth.persistState` 存入 `safeStorage` → `McpRuntimeManager` 立即自动重连该 server 并广播 `mcp.statusChanged`（状态变为 `connected`，当前活跃会话下一回合即可用）；
4. 支持 `mcp.oauth.cancel({ loginId })` 取消挂起登录，支持 `mcp.oauth.logout({ name, cwd? })` 清除 token 并断开重连。
5. `runtime.oauthAuthorized` 只在对应连接身份有保存的 OAuth Token 时为真；DCR 注册元数据不算用户授权，静态 Header/公开远程服务不显示登出。

---

### 4.6 Tool Annotations 审批分级与工具级治理

在 [session.ts](../../src/host/runtime/session.ts) 的 `ApprovalBridge.decide` 中改造 `mcp__*` 审批逻辑：
1. 查询 `const meta = this.mcpRuntime.getToolMeta(toolName)`，拿到 `{ serverName, originalToolName, annotations }`；
2. **风险分级**：
   - **只读（`readOnlyHint === true && destructiveHint !== true`）**：映射为 `kind: 'read'`（在 `auto` / `autonomous` 档与 `plan` 模式自动放行；`ask` 档仍询问）；
   - **破坏性（`destructiveHint === true`）**：映射为 `kind: 'exec'`，并在 `approval.request` 载荷中附加 `mcpMeta: { serverName, originalToolName, destructive: true, openWorld: annotations?.openWorldHint === true }`，审批面板高亮「高风险外部写入/破坏性操作」警示标签；
   - **未声明 annotations（保守默认）**：映射为 `kind: 'exec'`（保持决定 28 安全基线，但允许用户粒度授权）。
3. **会话级细粒度放行**：扩展 `ApprovalRegistry` 支持 `always-mcp-tool:<qualifiedName>` 与 `always-mcp-server-readonly:<serverName>`，用户可在审批面板选择「允许一次 / 本会话始终允许此工具 / 拒绝」。

---

### 4.7 MCP 协议原语补齐

#### 4.7.1 MCP Resources 前端消费（`@` 引用）
- Host 提供 `mcp.resources.list({ cwd?, server? })` 与 `mcp.resources.read({ cwd?, server, uri })` RPC；
- 在输入区（[triggers.ts](../../src/renderer/src/features/home/composer/triggers.ts) / [CommandSuggestionPanel.tsx](../../src/renderer/src/features/home/composer/CommandSuggestionPanel.tsx)）的 `@` 触发面板中新增「MCP 资源」分组，展示已连接 server 的资源列表；
- 选中后作为结构化引用插入输入，提交时由 Host 读取或把 `<mcp_resource server="..." uri="..." />` 上下文块注入本轮消息（图片资源按模型能力走原生图，大文本超 24K 落盘提示）。

#### 4.7.2 MCP Prompts 接入 `/` 斜杠命令
- `McpRuntimeManager` 在 server 声明 `capabilities.prompts` 时通过 `client.request('prompts/list')` 缓存提示词列表（含 `name`、`description`、`arguments[]`）；
- Host 提供 `mcp.prompts.list({ cwd? })` 与 `mcp.prompts.get({ cwd?, server, name, arguments? })` RPC；
- 在输入区 `/` 命令列表（[commands.ts](../../src/renderer/src/features/home/composer/commands.ts)）动态并入 `/mcp:<server>:<prompt>`（展示 server 徽标与描述，若带必填 `arguments` 弹轻量参数表单或行内补全）；触发后调用 `prompts/get` 将返回的 `messages` 文本/图片内容展开送入对话。

#### 4.7.3 MCP Elicitation（Form Mode & URL Mode）
新建 `src/host/runtime/mcp-elicitation.ts`，沿用 [交互座](../模块/交互座.md) 的挂起-响应模式：
- 连接建连时在 `McpClient` 声明 `capabilities: { elicitation: { form: {}, url: {} } }`，并注册 `client.setRequestHandler('elicitation/create', handler)`；
- 收到 server 发来的 `elicitation/create` 请求时：
  - Host 生成 `requestId`，关联当前活跃 `sessionId`（通过 `callTool` 执行上下文追踪）与 `AbortSignal`；
  - 广播 `mcp.elicitation.request` 事件（区分 `mode: 'form'` 带 `requestedSchema` 与 `mode: 'url'` 带 `url` + `elicitationId`）；
  - 前端在会话底部交互区（复用 `ask_user` 同位面板）渲染：
    - **Form Mode**：根据 JSON Schema（`string`/`number`/`integer`/`boolean`/`enum` + `title`/`description`/`default`/`required`）动态渲染表单，支持「提交 / 拒绝 / 取消」；
    - **URL Mode**：清晰展示目标域名与安全警告（防钓鱼），提供「在浏览器打开」与「我已完成 / 取消」按钮；
  - 前端经特权通道调用 `mcp.elicitation.respond({ requestId, action: 'accept' | 'decline' | 'cancel', content? })` 解除挂起并将标准 `{ action, content }` 返回给 MCP server；
  - 会话中止/断开或用户取消时自动 reject/返回 `{ action: 'cancel' }`，绝不死锁。

---

### 4.8 设置页 UI 重构与对话流美化

1. **设置页「MCP 服务器」（[McpSection.tsx](../../src/renderer/src/features/settings/McpSection.tsx)）**：
   - **实时状态流**：订阅 `mcp.statusChanged` 事件，卡片行展示实时状态点（绿=已连接 / 琥珀=需登录或待信任 / 蓝脉冲=连接中 / 红=失败 / 灰=已禁用）、工具数徽标（如 `12 工具`）、延迟与来源徽标（`用户` / `项目 .mcp.json` / `项目覆盖`）；
   - **行内操作**：按状态动态展示「登录（OAuth）」「信任」「重连」「启用开关」「编辑」「删除」；
   - **可展开详情抽屉 / 折叠面板**：点击卡片展开 3 个 Tab：
     - 「工具（N）」：列出全部工具（名称、描述、`readOnly`/`destructive` 徽标、单工具启停开关 + `direct`/`deferred`/`hidden` 切换）；
     - 「资源与提示词」：列出已发现的 Resources 与 Prompts；
     - 「诊断与日志」：展示 `serverInfo`、协议版本、完整报错信息、`stdio stderr` 尾部日志、以及「复制诊断 / 重连」按钮；
   - **工作区待信任横幅**：项目作用域存在 `untrusted` 的 `.mcp.json` / `.cogent/mcp.json` 时，顶部醒目展示审阅卡片（列出来源文件、命令/URL、env 键名），支持一键「信任」或「拒绝」；
   - **状态作用域**：用户页只接收无 `cwd/projectId` 的广播；项目页只接收匹配当前 `projectId/cwd` 的广播；不按缺失 runtime 的同名服务器跨作用域匹配。
   - **新增/编辑弹窗（[McpServerDialog.tsx](../../src/renderer/src/features/settings/McpServerDialog.tsx)）**：类型下拉补齐 `sse`；新增「高级选项」折叠区（`cwd`、`timeout`、`sanitizeHostEnv`、HTTP `oauth` 可选静态配置）；暴露档默认选中 `deferred` 并移去「未装载」文案；
   - **体验精简**：不提供密钥管理弹窗或附件分析手动绑定入口；对应设置搜索项与组件删除。附件内置读取和既有后端绑定能力保持，尚未增加 PDF 页面渲染或原生音视频处理。
2. **对话流工具卡美化（[tool-display.ts](../../src/renderer/src/components/ui/tool-display.ts) & `tool.tsx`）**：
   - 新增 `tool_search` 类别词（`搜索工具`）与专属图标；
   - MCP 工具卡标题优化为：`MCP` 类别徽标 + `server` 标签 + 可读工具名 + 核心参数摘要（如 `github · create_issue`）；
   - 展开区美观渲染 `structuredContent` JSON 与 MCP 返回的内嵌图片缩略图/资源链接。

---

## 5. 协议契约与权限矩阵

新增/变更均遵循 [约定.md](../约定.md) §2 协议纪律（零运行时依赖，同步更新 `src/protocol/method-access.ts` 与 `src/renderer/src/env.d.ts`）：

| 名称 | 类型 | HTTP Scope | Renderer 允许 | 说明 |
| --- | --- | --- | --- | --- |
| `mcp.list` | RPC（扩展返回） | `readonly` | 是 | 增加可选参数 `projectId` 并校验与 `cwd` 一致；返回 `servers`（含 `origin` / `runtime` 实时状态 / `tools` 摘要）+ `pendingTrustFiles`（含 `projectId`）+ `errors` |
| `mcp.sync` | RPC（扩展校验） | `write` | 是 | 全量写用户级定义（支持 `sse`、`oauth`、`toolExposure`、`sanitizeHostEnv`、`extraFields`），触发 `McpRuntimeManager` 差量重连 |
| `mcp.override` | RPC（扩展字段） | `write` | 是 | 项目级 override，新增支持 `toolExposure` |
| `mcp.reconnect` | 新增 RPC | `write` | 是 | `{ name, cwd? }` 强制重建单个 server 连接 |
| `mcp.probe` | 新增 RPC | `write` | 是 | `{ def, cwd? }` 保存前在表单内一键「测试连接」（临时连接、探完即关） |
| `mcp.trust.decide` | 新增 RPC | `write` | 是 | `{ projectId, cwd, filePath, sha256, decision }` 审阅项目 `.mcp.json`，Host 校验项目归属与来源路径 |
| `mcp.oauth.login` | 新增 RPC | `write` | 是 | `{ name, cwd? }` 启动 OAuth 登录并返回 `{ loginId, authUrl }` |
| `mcp.oauth.completeManual` | 新增 RPC | `write` | 是 | `{ loginId, redirectUrl }` 手动粘贴回调 URL 兜底 |
| `mcp.oauth.cancel` | 新增 RPC | `write` | 是 | `{ loginId }` 取消挂起登录 |
| `mcp.oauth.logout` | 新增 RPC | `write` | 是 | `{ name, cwd? }` 清除 OAuth 凭据并断开 |
| `mcp.resources.list` / `read` | 新增 RPC | `readonly` | 是 | 查询与读取 MCP 资源（供设置页与 `@` 引用） |
| `mcp.prompts.list` / `get` | 新增 RPC | `readonly` | 是 | 查询与展开 MCP 提示词（供 `/` 命令） |
| `mcp.elicitation.respond` | 新增 RPC | `write` | **否**（走特权 IPC） | 响应挂起的 Elicitation（与 `approval.respond` / `question.respond` 同级安全） |
| `mcp.secrets.sync` | 私有 RPC | **仅 stdio** | **否** | Electron 主进程 → Host 同步 OAuth 状态快照，不含手动密钥 |
| `mcp.statusChanged` | 新增 Event | 广播 | 是 | 推送单个/全量 `McpServerRuntimeStatus` 变更 |
| `mcp.oauth.openUrl` | 新增 Event | 仅 stdio | 否 | Host 请求主进程调用 `shell.openExternal`（主进程严格校验 `https://` 或 `http://localhost`） |
| `mcp.oauth.persistState` | 新增 Event | 仅 stdio | 否 | Host 通知主进程将更新后的 OAuth state 加密落盘到 `safeStorage` |
| `mcp.oauth.persistResult` | 新增 RPC | 仅 stdio | 否 | 主进程回复同代 OAuth 状态写入请求的成功或失败 |
| `mcp.elicitation.request` | 新增 Event | 广播 | 是 | 推送挂起中的 Elicitation Form/URL 请求 |
| `mcp:elicitationRespond` | 特权 IPC | — | Preload 白名单 | 壳侧转发 `mcp.elicitation.respond` |
| `mcp:detectExternalConfigs` | 特权 IPC | — | Preload 白名单 | 探测本机其他客户端 MCP 配置文件供导入 |

---

## 6. 分批实施路线与验收标准（可直接按批施工）

### Batch 1：配置无损升级、变量替换、工作区信任门与 OAuth 加密底座
- **新建/修改文件**：
  - `src/protocol/types.ts`、`src/protocol/method-access.ts`、`src/renderer/src/env.d.ts`
  - `src/host/runtime/mcp-config.ts`（支持 `sse`、`oauth`、`toolExposure`、`sanitizeHostEnv`、`extraFields`、默认 `deferred`、识别 `.mcp.json` + `.cogent/mcp.json`）
  - `src/host/runtime/mcp-env.ts`（沿用 `template-vars.ts` 的上下文与安全边界，补齐 §4.1.2 MCP 专用语法与缺失变量校验 + stdio 敏感 env 清洗）
  - `src/host/runtime/mcp-trust.ts`（`projectId + sha256` 持久化信任门）
  - `src/electron/main/credentials/mcp-store.ts`、`src/electron/main/ipc/mcp.ts`、`src/electron/preload/index.ts`
  - `src/host/host-main.ts`（新方法注册、入口校验与启动期 OAuth 状态注入）
- **验收**：
  - 单测：`tests/host/runtime/mcp-config.test.ts`（无损往返、缺省 `deferred`、`sse` 校验、`.mcp.json` 合并）、`tests/host/runtime/mcp-env.test.ts`（支持的占位符、空值默认值、缺失环境变量及旧密钥语法报错、单遍展开、敏感 env 剥离）、`tests/host/runtime/mcp-trust.test.ts`（未信任拦截、sha256 信任生效、跨项目不得复用信任、项目身份与真实路径不匹配拒绝、文件改动失效、TOCTOU 拒绝）、复用 `tests/host/runtime/template-vars.test.ts` 验证正文语义不变、`tests/shared/method-access.test.ts`、`tests/electron/main/ipc/trusted.test.ts`。

### Batch 2：Host 级 `McpRuntimeManager`（连接池 + SSE + 确定性回收）与 pi 桥接 + `tool_search`
- **新建/修改文件**：
  - `src/host/runtime/mcp-transports.ts`（封装 `StdioTransport` + 进程组回收、`StreamableHttpTransport`、新增 `SseTransport`）
  - `src/host/runtime/mcp-runtime.ts`（连接池、状态机、`stderrTail`、能力缓存、`tools/list_changed`、`mcp.probe`、`mcp.reconnect`、`mcp.statusChanged`）
  - `src/host/kernel/cogent-mcp-extension.ts`（替代 `createMcpExtension`，桥接工具/资源三件套、回合边界热同步、`mcp_servers` 提示段）
  - `src/host/kernel/pi-session-factory.ts`（装配 `createCogentMcpExtension` + `createToolSearchExtension()`）
  - `src/host/runtime/tool-meta.ts`（加入 `tool_search`）
  - `src/host/runtime/session.ts`（接入 `McpRuntimeManager`、`Annotations` 审批分级与会话级细粒度放行、`read_attachment` 媒体委托改查 `runtime`）
- **验收**：
  - 单测 + 集成：`tests/host/runtime/mcp-runtime.test.ts`（连接池跨会话复用、子进程退出零残留、`tools/list_changed` 热刷新、SSE mock server 闭环）、`tests/integration/mcp.test.ts`（升级覆盖 `deferred` → `tool_search` 激活 → 调用闭环、`readOnlyHint` 审批分级、`destructiveHint` 高亮、热开关无需重开会话）。

### Batch 3：远程 MCP OAuth 2.1 完整认证流
- **新建/修改文件**：
  - `src/host/runtime/mcp-oauth.ts`（复用 `@earendil-works/pi-mcp/oauth`，对接内存状态 + `mcp.oauth.persistState` 写回 `safeStorage`）
  - `src/electron/main/index.ts` & `src/electron/main/ipc/mcp.ts`（处理 `mcp.oauth.openUrl` 安全 URL 校验与 `shell.openExternal`、处理 `mcp.oauth.persistState` 加密落盘）
  - `src/host/host-main.ts`（注册 `mcp.oauth.login/completeManual/cancel/logout`）
- **验收**：
  - 集成测试：`tests/integration/mcp-oauth.test.ts`（真实 Host + 本地 DCR/PKCE/loopback + 受保护 Streamable HTTP MCP；未登录 → main 持久化确认 → 自动重连并调用 → 登出）。Electron 单测单独验证 `safeStorage` 与坏文件/解密/不可用时仍能握手，OAuth 源码测试覆盖刷新锁和刷新 Token；黑盒测试不等同真实厂商或系统安全存储实测。

### Batch 4：MCP 协议原语补齐（Resources `@`、Prompts `/`、Elicitation Form/URL）
- **新建/修改文件**：
  - `src/host/runtime/mcp-elicitation.ts`（`elicitation/create` 挂起队列、取消/超时保护、`mcp.elicitation.respond`）
  - `src/host/host-main.ts`（注册 `mcp.resources.*`、`mcp.prompts.*`、`mcp.elicitation.respond`）
  - `src/renderer/src/features/home/composer/commands.ts`、`triggers.ts`、`CommandSuggestionPanel.tsx`（接入 MCP Prompts `/` 与 Resources `@`）
  - `src/renderer/src/features/home/ElicitationPanel.tsx` & `stores/chat/`（渲染 Form Mode 动态表单与 URL Mode 安全跳转确认面板）
- **验收**：
  - 单测 + 集成：`tests/host/runtime/mcp-elicitation.test.ts`（Form 提交/拒绝/取消、URL 模式、会话 abort 清理不死锁）、`tests/integration/mcp-primitives.test.ts`（Resources 列出与读取、Prompts 列出与参数展开、Elicitation 端到端闭环）。

### Batch 5：设置页 UI 全面升级、对话流美化、文档与验收收口
- **新建/修改文件**：
  - `src/renderer/src/features/settings/McpSection.tsx`（实时状态灯、工具/资源/诊断折叠面板、单工具开关、OAuth 登录/登出按钮、项目信任横幅、严格作用域匹配）
  - `src/renderer/src/features/settings/McpServerDialog.tsx` & `mcp-import.ts`（`sse`、高级选项、表单内「测试连接」、多生态自动导入）
  - `src/renderer/src/components/ui/tool-display.ts` & `tool.tsx`（`tool_search` 呈现、`[server] tool` 卡片与富内容展示）
  - 文档回写：`docs/模块/MCP座.md`、`docs/技术笔记/MCP座.md`、`docs/决定.md`（更新决定 27 演进注记）、新增 `docs/测试用例/MCP座.md`（真实 stdio/HTTP/OAuth MCP 手测册）、同步 `docs/架构地图/`（通过 `保真校验.test.ts`）。
- **验收**：
  - 跑完整四关：`npm run lint && npm run typecheck && npm run build && npm test`；
  - Web 组件测试覆盖 `McpSection` / `McpServerDialog` / `mcp-import` / `ElicitationPanel`；
  - 按 `docs/测试用例/MCP座.md` 执行 Electron 实机手测（真实 filesystem stdio、真实远程 OAuth MCP、多工具 deferred `tool_search`、项目 `.mcp.json` 信任门、重启后无残留子进程）。

---

## 7. 安全边界与非目标

- **严格守门**：
  - `safeStorage` 不可用或 `basic_text` 时拒绝写入；启动读取失败仅使用空 OAuth 快照，不阻断应用，不覆写旧文件，绝不降级明文存储；
  - `mcp.oauth.openUrl` 仅放行 `https:` 或 loopback `http:`（`127.0.0.1` / `localhost` / `[::1]`），禁止 `file:` / `javascript:` / 自定义危险协议；
  - `mcp.elicitation.respond` 与 `mcp.secrets.*` 绝不经 `engine:request` 开放给普通 HTTP/WS 客户端；
  - 任何 `untrusted` 项目级 server 严格 fail-closed，绝不触发子进程或网络探测。
- **明确非目标（本次不做）**：
  - 对外 MCP 出口（`cogent-mcp`）设置页 UI（D8 裁决：暂缓，保持设置页聚焦 MCP 客户端）；
  - MCP Sampling（服务端反向调客户端 LLM）与 MCP Apps `ui://` iframe 沙箱渲染（远期按需另立项）；
  - 云端 MCP 市场分发（依赖服务端，不在本地优先范围）。

---

## 8. 后续收口验收记录（2026-11-28）

本轮按用户的五项任务定点修复，未扩展多媒体架构或修改附件解析器、原生依赖和测试超时。
验证区分系统 Node 24.14.0 与产品自带 Host Node 22.23.5；后者可通过项目测试引导器支持的
`COGENT_NODE_BIN` 显式选择，不修改测试配置或产品运行时。

| 检查 | 本轮实际结果 |
| --- | --- |
| `npm run lint` | 通过，包含字号、文档及 ESLint；既有文档预算和历史行号仅提示 |
| `npm run typecheck` | Node/Web 均通过 |
| `npm run build` | 通过；Windows 平台 API 修正后由 integration global-setup 再次自动构建成功 |
| `npm test -- --maxWorkers 1 --no-file-parallelism`（Node 24.14.0） | 首轮 222 文件、1702 项通过；附件 worker 文件在原生访问冲突 `3221225477` / `0xC0000005` 下退出，剩余 3 项未完成，不能记全绿 |
| 重新构建后的附件 worker 单文件 | Node 22 与 Node 24 均 4/4 通过；没有证据确定首轮原生崩溃根因，未通过改依赖或延长超时规避 |
| 全量串行（显式产品 Node 22.23.5） | `COGENT_NODE_BIN` 指向自带 runtime 后执行相同 `npm test` 串行命令，223 文件、1706 项全部通过；包含新增 OAuth 黑盒及 Windows API 缺失回归 |
| 架构地图独立测试 | 2 文件、30 项通过，包含保真与布局 |
| Windows 隔离产品启动探针 | 真实 main/preload/renderer/Host 和 IPC 成功；损坏 JSON 保留原样、记录诊断；关闭后全部所属进程退出 |
| Windows 隔离 OAuth 存储探针 | 真实系统加密写入及重新读取通过，文件无测试 Token 明文；该平台缺少 Linux backend API 的情形已实际验证 |

日志在 `tmp/mcp-cleanup-*.log`。本地 OAuth 黑盒只模拟 main 的私有提交确认；真实 Windows
系统加密由独立 Electron 探针验证，不能据此推断真实厂商授权页、CIMD 发布或 Linux 已通过。
真实厂商与平台人工流程继续按[手测册](../测试用例/MCP座.md)执行。

### 8.1 验收后修复：主目录会话丢失用户级 MCP（2026-11-28）

现象：缺省 `COGENT_HOME` 下在用户主目录开会话，用户级服务在该作用域变成未受信的项目定义，
不连接、无 `tool_search` 和 MCP 提示段；设置页（不带工作目录）仍显示已连接，两处不一致。
根因：`mcp-config.ts` 的 `resolve` 依次读用户文件、`<cwd>/.mcp.json`、`<cwd>/.cogent/mcp.json`，
主目录会话的第三条路径就是用户文件，同名条目被后读的未受信项目定义覆盖。
修复：来源列表按真实路径去重；重合时没有独立的项目覆盖槽位，`override` 明确拒绝而不改用户定义。
验证：变更文件 lint、Node 工程 typecheck、`mcp-config`/`mcp-runtime`/`mcp-trust`/`mcp-oauth` 单测 43 项、
`tests/integration/mcp.test.ts` 通过；真实 Host 复验 `tmp/mcp-real/home-collision-verify.mjs` 13/13
（mock stdio、mock 模型）。未重跑完整四关；用户现网 `~/.cogent/mcp.json` 未改动，需重启应用生效。
