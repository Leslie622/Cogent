# 对外 MCP Server：agent-as-server 的形态学

> 四家对照：把「本地 Agent 经 MCP 给外部 agent 驱动」这件事，各家的做法
> 与 Cogent 的取舍。事实现状见 [../模块/对外MCP.md](../模块/对外MCP.md)。

## 1. 问题

MCP 主流是「**带人的 agent 应用 ←连← 能力提供方**」（Claude Desktop /
zcode / Cursor 连 GitHub、数据库、设备）；「连一个本地智能体」
（agent-as-server）是反向少数派。要回答四件事：拓扑（连谁的 Host）、
凭据（外部进程怎么拿到）、审批（人机协同挂谁头上）、异步（submit 不是
同步完成）。

## 2. 四家做法

### Pi-meme apps/mcp（拓扑同型主参照）

独立进程连**运行中的 Host**、不启动第二个（README:25「上游按工具调用
连接」—— Host 离线仍可列工具）。显式 typed 工具不透传 RPC（tools.ts:
214-267 register 帮手 + zod strict + 47 工具）；写默认关双闸（config.ts:
45-46、145-147：allowWrites 与项目登记各一闸且互斥）；无人值守（schedules）
的 accessMode **必填**（tools.ts:74-84 —— 无人语境不给默认兜底）；错误
投影 + secret 擦除（hosts.ts:207-268）；HTTP 门无状态 Streamable + 恒时
Bearer + Host/Origin 白名单 + 2MiB/64 并发闸（http-server.ts:76-98）。
幂等域 clientId 派生（hosts.ts:123-132）+ 写操作调用方幂等键。

### dsh cua-mcp（consent 纪律参照，拓扑不采）

每 MCP 连接自建一个 Agent（server.ts:155-159）—— Cogent 不采：双 Host
并发写存储有竞态、且「驱动 GUI 所见会话」不成立。三条纪律进来：
**consent 双档** allow/elicit（elicit = MCP elicitation 把外部的人拉回
环路，consent.ts:56-82；默认 elicit 安全档 index.ts:41）；**逃生字段剔除**
（没有答复者的升级字段在 schema 层删 + 调用带即拒，server.ts:55-59、
198-201）；串行队列 + signal 合成（server.ts:182-188）。

### zcode（消费者画像）

自身**不是** MCP server —— server 代码全在插件包（android-emulator-
plugin/src/mcp/server.ts:46-116：McpServer + registerTool + stdio，即
「MCP server 作为插件的工具出口」用法）。作为 MCP 客户端按 stdio/HTTP
配置消费外部 server = D9 的真实消费者；工具名进消费者带前缀
（`mcp__dsh_cua__cua_run_code`，cua-mcp/server.ts:45-46）。

### pi 内核

无 server 侧 MCP：radius-mcp.ts 是 mcp.json 客户端配置规划；pi-mcp 包零
SDK 依赖。D9 全部 Host 侧自建，Cogent 新增 `@modelcontextprotocol/sdk`
1.32.2（Pi-meme 同款 registerTool API）+ zod。

## 3. 关键分歧与取舍

| 分歧 | 各家 | Cogent |
| --- | --- | --- |
| 拓扑 | Pi-meme 连现有 Host；dsh 每连接自建 Agent | 连现有 Host（单 Host，GUI 所见即所驱动） |
| 凭据 | Pi-meme 长期 Host 登录令牌（服务化部署） | rootSecret 随进程生死去掉了「外部长期令牌」可能 —— 走 main 铸票换 token 写文件（复用 2b/2c 全链，零新鉴权原语），每调用重读容忍轮换 |
| 审批 | dsh elicitation（生态薄：Codex 要开关、Claude print 拒绝，README:75 实测）；Pi-meme 配置时 accessMode | 三层：客户端 annotations（主位）+ GUI 共址 + 无人值守显式档；elicitation 列远期 |
| 异步 | Pi-meme operationId 回执三步 | Host 无回执 —— submit 受理即回 + waitMs 两段式 WS 订阅（先订阅就绪再提交，事件不重放）补 |

## 4. 学到的东西（写给自己）

- **annotations 不是文档点缀**：它是 MCP 生态运行时审批的数据源 ——
  Codex `approval policy never` 拒调 destructive 工具（dsh README:67 报错
  原文），即客户端按 hint 问自己的人。写组工具的 destructiveHint 是第一
  道人闸；
- **「默认安全 + 放开显式」是四家共识**：dsh 默认 elicit、Pi-meme
  schedules 强制 accessMode、Codex 宁拒不放行 —— Cogent 落成 session_create
  默认 plan 档（只读零挂起），放开必须显式传 permissionMode；
- **事件不重放**：WS 是推送不是回放，等待方必须先订阅后动作 —— 顺序
  反了不是崩溃而是偶发超时，这类竞态要在设计期就用事件顺序图钉死；
- **协议缺省语义要顺着用**：Cogent 的 planEnabled 对 false 不落字段
  （absent = 关），MCP 层的默认 plan 用「补 true」表达，显式放开用
  「补 false」表达 —— absent-off 语义让两层默认值天然不打架。
