# MCP 座实现文档（阶段 4a，待审批）

> 状态：**待用户审批**（AGENTS.md 硬规则 8）。审批通过后按批次动工。
> 硬规则 7 的三仓对比已完成（2026-11-15），出处钉行号见 §2。

## 1. 目标与范围

MCP 座 = Host 侧管理 **MCP 客户端**配置与授权，pi `createMcpExtension`
装配进会话，让外部 MCP server 的工具直接进 Agent 循环（D7：不造轮子，
全部走 pi 官方扩展形状）。**不含**：Cogent 对外作为 MCP Server（那是 D9，
阶段 5）。

首批交付：
1. 配置模型与存储（user 级定义 server + 项目级仅覆盖开关）；
2. 协议方法（读写配置）+ 装配（每会话经 `createMcpExtension` 注入）；
3. 审批联动（MCP 工具进 D8 审批链）；
4. 设置页 MCP 管理卡片 + 手动验收。

## 2. 四家对比结论（出处钉行号）

| 主题 | pi（内核，主体） | zcode | dsh | Cogent 采用 |
| --- | --- | --- | --- | --- |
| 扩展入口 | `createMcpExtension(options)` 工厂，`loadConfig`/`updateConfig`/`credentials`/`openUrl` 全部可覆盖 —— `reference/pi/packages/coding-agent/src/extensions/mcp/index.ts:70-92,280` | 自研 runtime methods（`core/src/runtime/methods/mcp.ts:57-195`） | manager/client 分层（`packages/mcp/mcp-manager`） | **pi 工厂 + `loadConfig` 注入 Host 配置**（Cogent 不自研连接管理） |
| 配置格式 | `mcpServers` 通用形状：stdio（command/args/env/cwd）+ Streamable HTTP（url/headers/oauth），"configurations can be copied between them" —— `node_modules/@earendil-works/pi-mcp/dist/config.d.ts:1-96` | 双来源（`.zcode/config.json` 键 `mcp.servers` + `.agents/mcp.json`）—— `mcpSyncService.ts:40-56` | profile YAML + Settings 热编辑 + 插件自注册 | **直接用 pi-mcp 形状存 `~/.cogent/mcp.json`**（与生态互拷；校验用现成 `validateMcpServerConfig`） |
| 作用域/覆盖 | global（agent dir mcp.json）+ project（受信项目 mcp.json）；项目条目无 command/url/type = 只覆盖 `enabled/exposure/toolExposure`（`isMcpServerOverride`，`config.d.ts:111-115`；`OVERRIDE_KEYS`，pi `mcp/config.ts:71`） | user + workspace 双文件 | 六级 rank 目录（技能侧）；MCP 走 profile/插件 | **user 级定义 server；项目级只允许 override**（pi 现成语义 = 天然信任门：低信文件开不了新进程） |
| 工具进 agent | `mcp__<server>__<tool>`；exposure 四档（direct 直接声明 / deferred 经 tool_search / codemode / hidden）—— `mcp/index.ts:8-16,118-122` | 同款命名 + 默认延迟暴露（`tool_search` 目录）—— `mcp/name.ts:3-24` | 同款 + 有损归一化追加 12 位哈希防碰撞 —— `tools.ts:89-105` | **direct 起步**（GUI agent，模型直接用；命名冲突极小概率，pi 已压非法字符） |
| 审批/安全 | **MCP 工具走 pi tool pipeline，permission 扩展与内置工具同待遇** —— `mcp/index.ts:20-21`；stdio env 为叠加式注入（配置显式给才加） | 全部默认 `needsApproval`，按 annotations 分级（readOnly→low/destructive→high）—— `core/src/mcp/index.ts:129-148`；工作区信任门 sha256 —— `workspace-mcp-trust/index.ts:23-36` | stdio 环境清洗（剔 KEY/PASSWORD/SECRET/TOKEN）—— `mcp-client/transport.ts:22-40`；`${credential:REF}` 模板 + 脱敏 | **D8 审批链天然覆盖（pi pipeline）**；MCP 工具 ToolKind 投影默认 ask 档（annotations 可得则映射 readOnly→低风险，实施时验证 pi 透传）；env 不做额外清洗（Host 进程 env 无 secret，叠加式注入仅显式配置生效）——记入技术笔记 |
| 刷新语义 | 连接后台跑，direct 工具的 server 首请求等 `startupWaitMs`（默认 10s）—— `mcp/index.ts:6-8,94` | 回合边界按 `tools/list_changed` 增量刷新 —— `methods/mcp.ts:218-262` | 整代原子交换（失败保旧集）—— mcp-manager README:147 | **首发：配置变更新会话生效**（UI 明示）；回合级热刷新列后续 |

## 3. 设计

### 3.1 数据与文件

```
~/.cogent/mcp.json                 # user 级（server 定义，唯一可定义新 server 的地方）
  { "mcpServers": { "fs": { "command": "npx", "args": [...] , "enabled": true, "exposure": "direct" } } }

<workspace>/.cogent/mcp.json       # 项目级（仅 override：enabled / exposure）
```

- 校验：`validateMcpServerConfig`（pi-mcp 导出）——名字规则、stdio/http
  判别、未知字段保留待应用检查；
- 合并：user 定义 + project override（override 条目无 command/url/type 即
  pi 语义；名字不匹配任何 user server 的 override 视为无效，诊断列出）。

### 3.2 Host 侧模块

- `src/host/runtime/mcp-config.ts`：store（读写两文件 + 校验 + 合并），
  构造即恢复、原子写（JsonStorageDriver 同款纪律；明文 JSON 非机密）；
- 协议方法（与 `providers.custom.sync` 同构）：
  - `mcp.list` → 各 server 的配置摘要（name/type/enabled/exposure/description）；
  - `mcp.sync` → 全量写 user 级定义（项目级文件不经协议写，只能用户手改）；
- 装配：SessionManager 创建 AgentSession 时
  `extensionFactories` 加入 `createMcpExtension({ loadConfig, updateConfig, logPath })`
  ——`loadConfig` 返回 Host 合并结果（**Pi-meme 快照语义**：会话创建时定格，
  之后改配置不影响在跑会话）；`updateConfig` 写回 user 级文件（exposure
  调整持久化）。

### 3.3 审批联动

MCP 工具名 `mcp__*` → `tool-meta.ts` 的 ToolKind 投影加一档：
MCP 工具默认 **ask**（未经用户配置的第三方工具，保守起步）；若 pi 的
beforeToolCall 载荷能取到 annotations（实施时验证），则 readOnlyHint 映射
为低风险档（沿用现有权限矩阵路径，zcode `mcp/index.ts:129-148` 模式）。
审批 UI/链路零新增（D8 现成）。

### 3.4 UI（设置页）

设置页新增 MCP 卡片：server 列表（name/type/enabled/exposure 徽标）+
启停开关 + 新增/编辑表单（stdio：command/args/env；http：url/headers）+
删除。改动经 `mcp.sync` 全量提交，页面明示"**新会话生效**"。

## 4. 边界（首发不做）

- **OAuth sign-in**：pi 全套现成但需要交互式授权流（pi 的 `/mcp` 管理器是
  TUI 形态，Cogent Host 是 headless）——首版连接失败时在 UI 提示"该 server
  需要登录，暂不支持"；OAuth 流列后续批次；
- **热刷新**：配置变更不作用于进行中会话（新会话生效）；
- **`${VAR}` 变量替换**（env/headers 里）：pi 把决定权交给应用，首版原样
  传（不解析变量），避免引入 Host env 泄漏面；
- **项目级定义 server**：不允许（只 override）——信任门后续立项时再开
  （zcode sha256 digest 模式已记）；
- **SSE 传输**：pi 仅 stdio + Streamable HTTP（老 SSE server 不接，生态
  正在迁移，不背包袱）。

## 5. 验收

- 集成：测试内置一个极小 stdio MCP server（node 脚本，echo 工具），配置
  后新会话中 agent 循环能调到 `mcp__<mock>__echo`，审批链对其生效；
- 手动：设置页添加真实 MCP server（如 `@modelcontextprotocol/server-filesystem`）
  → 新会话让模型列目录 → 工具卡正常呈现；禁用后新会话工具消失。

## 6. 批次

| 批 | 内容 | 验收 |
| --- | --- | --- |
| 4a-1 | mcp-config store + `mcp.list/sync` 协议方法 + createMcpExtension 装配 + 审批投影 + 集成测试（mock stdio server） | 四关全绿；集成断言工具可达 |
| 4a-2 | 设置页 MCP 卡片 + main IPC 转发 | 手动验收（真实 server 一枚） |

每批完成后写技术笔记（含本表对照的实施差异）。
