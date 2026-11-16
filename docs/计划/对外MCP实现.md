# 对外 MCP Server 实现文档（阶段 5a：D9 出口座）

> 阶段 5 第一批。2026-11-16 四仓调研定稿（对比结论见 §2）+ 同日二轮
> 调研（默认档/人机协同主流做法，§3.5）。
> 状态：**已实施完成**（2026-11-16 同日落地，四关全绿 254 用例；
> 实施差异三处：① `session.messages` 无分页参数（§3.3 表中「分页」按
> 协议事实修正为全量投影）；② waitMs 落地为两段式订阅 —— 先 WS 就绪
> 再 submit（事件不重放，先提交再订会错过快任务的 completed，实现期把
> §3.4 的顺序描述钉死成 API 形状）；③ planEnabled 协议缺省语义 =
> absent/off，host 对 false 不落字段 —— 默认 plan 用「补 true」、显式
> 放开用「补 false」表达，两层默认值天然不打架。事实文档见
> [../模块/对外MCP.md](../模块/对外MCP.md)。原文档存档如下，不再回改。）

## 1. 目标与动机

D9：外部 agent（如 zcode）经 MCP 驱动 Cogent 会话。MCP server 是 Cogent 的
**出口**面（Cogent 作为被驱动方），与 MCP 座（4a，Cogent 作为 MCP 客户端
消费外部 server）方向相反。

现状事实（均已就绪的底座）：

| 底座 | 现状 | 出处 |
| --- | --- | --- |
| HTTP/WS 通道 | 桌面 app 恒开（`enableHttpRpc: true`），随机端口经 initialize 上报 | electron/main/index.ts:118、host/manager.ts:181 |
| 三档鉴权 | readonly ⊂ write ⊂ admin，方法档位表 40 方法全覆盖 | http/server.ts:58-111、http/auth.ts:18 |
| 票据签发 | main 经 stdio `capability.issue` 签票（血缘全权起点） | host/manager.ts:109-111 |
| 审批审计对 | approval.asked/decided 全路径进 inspect 流（4d） | inspector.ts、协议 inspect.entries |

缺口三件（本批要补的）：

1. **凭据断链**：rootSecret 每次启动随机生成、不出进程（auth.ts:20-22），
   长期 token 随 Host 进程生死（auth.ts:88-91 无 exp 字段是有意的），票据
   一次性 30s TTL（auth.ts:26）—— 外部进程（zcode spawn 的 MCP server）
   拿不到任何能用的凭据；
2. **端口发现**：HTTP 门随机端口，只有 main 知道（manager.ts:181）；
3. **MCP 面本体**：HostApi 方法 → MCP 工具的映射层不存在。

## 2. 对比结论（四仓 + Pi-meme，出处：文件:行号）

### 2.1 Pi-meme apps/mcp：拓扑同型的主参照

独立进程、**不启动 Host、按工具调用连接运行中的 Host**（README:25 ——
Host 离线时 MCP 仍可初始化列工具，业务调用才连）。与本批「驱动 GUI 所见
的同一 Host」的验收语义完全同型。可搬的形状：

- **显式 typed 工具，不做任意 RPC 透传**（tools.ts:212-267 register 帮手，
  zod strict 入参 + 每工具手写 description；47 工具、22 写）。工具面是
  审校过的子集，不是方法表面镜像；
- **写默认关 + 双闸**：`allowWrites` 默认 false 只在配置显式开
  （config.ts:45-46），项目登记另设一闸且与 projectIds 互斥
  （config.ts:145-147）；README:85 明示「allowWrites 含 Agent 执行授权，
  不只是改名」—— 写闸文案要照实吓人；
- **annotations 四 hint 逐工具声明**（tools.ts:239-244：readOnly /
  destructive / idempotent / openWorld）；
- **每调用重连上游 + signal 合成**（hosts.ts:176-195：client 惰性建、
  fetch 层 timeout ∥ MCP 请求 signal 合成；Host 重启即重建）；
- **错误投影**（hosts.ts:207-268：网络/TLS/超时各归一词 + **secret 全量
  擦除**后进错误消息，2000 字符截断）；
- **幂等域**（hosts.ts:123-132：clientId 派生自配置范围 SHA-256，写操作
  幂等键由调用方提供，README:116）；
- **无人值守强制显式**：交互会话 configuration 可选（tools.ts:390-405），
  但 schedules 的 accessMode **必填**（tools.ts:74-84 scheduleInput 强制
  全配置）—— 无人语境不给默认值兜底，放开必须显式声明；
- HTTP 门：无状态 Streamable（不设 session id、只 POST，http-server.ts:
  86-91）+ Bearer 恒时比较（76-85）+ Host/Origin 白名单（48-58）+ 2MiB
  请求体/结果上限（97、257-259）+ 64 并发闸（92）。

### 2.2 dsh cua-mcp：consent 纪律参照（形状不采）

每 MCP 连接自建一个 Agent（server.ts:155-159）—— **拓扑不采**：Cogent 若
照做 = MCP 连接 spawn 独立无头 Host，双 Host 并发写 `~/.cogent`
（projects.json / approvals.json / pi 会话树）有存储竞态，且「驱动用户
GUI 正看着的会话」不成立。但三条纪律进来：

- **consent 双档**：unattended `allow`（自动批）vs `elicit`（MCP
  elicitation 把外部 agent 的人拉回答环路，consent.ts:56-82：decline →
  拒绝、cancel → 中止，语义映射干净）—— Cogent 的对应问题「外部 agent
  驱动时审批谁来答」见 §3.5。默认 `elicit`（安全档，index.ts:41），
  无人值守才显式 `allow`。elicitation 生态实测（README:67/75，主流证据
  进 §3.5/§4-2）：Codex 需 `approval_policy.granular.mcp_elicitations=
  true` 才转发；Claude Code 2.1 print 模式直接拒绝 elicitation；
  **运行时审批的主位在客户端侧** —— Codex `approval policy never` 拒调
  destructive 工具（「MCP tool call requires approval, but approval
  policy is never」），即客户端按 annotations 问自己的人；
- **逃生字段剔除**：该 profile 没有答复者的升级字段（sandbox_permissions
  等）在 **schema 层剔除 + 调用带即拒**（server.ts:55-59、198-201）——
  「没有下游审批答复者的能力不上 MCP 面」同款纪律用于本批工具面裁剪
  （§3.4 的不映射表）；
- **串行队列 + signal 合成**（server.ts:182-188、207-212：工具调用过
  Agent 的 maintenance 活动队列，`AbortSignal.any([signal, mcpReq.signal])`）。

### 2.3 zcode：预期消费者画像（非参照实现）

zcode 自身**不是** MCP server —— server 代码全在插件包（android-emulator-
plugin/src/mcp/server.ts:46-116，McpServer + registerTool + stdio，即
「MCP server 作为插件的工具出口」用法）；作为 MCP **客户端**它按
stdio/HTTP 配置消费外部 server —— 这就是 D9 的真实消费者。SDK 新旧包名
并存（插件用 `@modelcontextprotocol/server` 2.0.0，zcode-cua 用
`sdk` ^1.27.1）。工具名进消费者侧带前缀：dsh 注明 Claude Code 里变
`mcp__dsh_cua__cua_run_code`（cua-mcp/server.ts:45-46）—— 我们的
`cogent_` 前缀同理。

### 2.4 pi 内核：无现成物

pi 无 server 侧 MCP：radius-mcp.ts 是 mcp.json **客户端**配置规划
（radius-mcp.ts:1-19），pi-mcp 包零 SDK 依赖（package.json:53-55）。
D9 全部 Host 侧自建，无内核可借力。Cogent 需新增显式依赖
`@modelcontextprotocol/sdk`（1.x 线，Pi-meme 1.32.2 同款 registerTool API）。

## 3. 设计

### 3.1 拓扑与进程形状

```
zcode（MCP 客户端）
   │ spawn stdio
   ▼
cogent-mcp（独立入口进程，node22，src/host/mcp-server/）
   │ 每次工具调用：读凭据文件 → HTTP /rpc（Bearer token）
   ▼
Cogent Host（桌面 app 内运行中的那个 Host，HTTP 门恒开）
   └─ 会话/审批/观测全在单 Host 内 —— GUI 所见即外部 agent 所驱动
```

- **单 Host 连接型**（Pi-meme 同款）：不 spawn 引擎、不建第二 Host
  （§2.2 的竞态与语义理由）；Host 离线时 MCP 照常初始化、列工具，
  业务调用返回连接错误（README:25 同款）；
- 入口 `src/host/mcp-server/`（config / tools / host-client / main），
  与 host-main 同链分发（同一 node22 运行时 spawn，manager.ts:127-135
  同款）；**stdio transport 首发**（外部客户端 spawn，无 MCP 侧鉴权需求
  —— 父子进程信任，Pi-meme 同款 README:36）。

### 3.2 凭据链（补断链的通路，不动协议）

owner：凭据文件 = main（写）、cogent-mcp（读）。

```
装配期（Host 每次启动）:
  main 读 settings.json externalMcp（壳配置归 main，ipc/settings.ts:3）
    enabled=false → 不写文件，MCP 面自然死（无凭据可用）
    enabled=true  → Host 握手得 httpPort（manager.ts:181）
       → stdio capability.issue(scope = allowWrites ? write : readonly)
       → 票据 /auth/exchange 换长期 token（auth.ts:88，随 Host 生死）
       → 原子写 ~/.cogent/mcp-access.json { port, token, scope }
         （tmp+rename，approvals.ts 同款纪律；Host 重启 main 重写）

运行期（每次工具调用）:
  cogent-mcp 重读 mcp-access.json（容忍 Host 重启换 token/换端口，
  Pi-meme「按调用连接」hosts.ts:176 的本地版）→ 带 token 打 /rpc
```

- 复用现有链零新鉴权原语：main 签票 → exchange → HMAC token，一路是
  2b/2c 已量产的路径；scope 由 `allowWrites` 决定，D9「写操作默认关」
  落在 token 档位上（readonly token 调写方法被 METHOD_MIN_SCOPE 挡，
  server.ts:183）；
- MCP 侧工具注册按凭据 scope 过滤（readonly 凭据 = 写组工具不注册，
  Pi-meme hasWrites 同款 tools.ts:221）。

### 3.3 工具面（显式 typed，`cogent_` 前缀）

| 组 | 工具 | 映射到 | 档 |
| --- | --- | --- | --- |
| 状态 | cogent_status | initialize + 凭据 scope 自述 | 读 |
| 项目 | cogent_projects_list | project.list | 读 |
| 会话 | cogent_sessions_list | session.list | 读 |
| 会话 | cogent_session_messages | session.messages（分页） | 读 |
| 模型 | cogent_models_list | models.list | 读 |
| 观测 | cogent_inspect_entries | inspect.entries（含 approval.asked/decided 审计对回看） | 读 |
| 会话 | cogent_session_create | session.create（**默认 plan 档**——只读零挂起，chat/读类开箱即用；放开 ask/auto/autonomous 必须显式传 permissionMode，主流"安全默认+放开显式"同款，见 §3.5） | 写 |
| 会话 | cogent_session_submit | agent.submit + 可选 `waitMs`（§3.5） | 写 |
| 会话 | cogent_session_abort | agent.abort | 写 |
| 裁决 | cogent_approval_respond | approval.respond | 写 |
| 裁决 | cogent_question_respond | question.respond | 写 |
| 裁决 | cogent_plan_respond | plan.respond | 写 |
| 档位 | cogent_session_set_permission / set_plan_mode | session.setPermission / setPlanMode | 写 |

不映射表（每条照 dsh「逃生字段」纪律给理由）：

| 不上 MCP 面 | 理由 |
| --- | --- |
| credentials.* / providers.custom.sync | 凭据面不外露（Pi-meme 同款排除，README:89） |
| mcp.sync / mcp.override / skills.save / delete / setEnabled | 提示词注入面 + 进程拉起面，等于把 Cogent 配置权交出去 |
| capability.issue | 提权面，绝不映射（server.ts:108-110 档位表防自签同理） |
| session.delete / project.delete | Host 无两段式/revision 机制（Pi-meme 删除要 preview+confirm+revision，README:120），裸删不安全 |
| session.compact / continue / inspect.entry 详情 | 内部机制，外部消费者用 messages 轮询与 entries 摘要够用 |

### 3.4 submit 的异步语义：waitMs 参数（Cogent 无 receipt 的替代）

Pi-meme 有 operationId 回执体系（submit→receipt→messages 三步，README:112）；
Cogent 的 submit 受理即回（host-main.ts:365-368 `{accepted:true}`，进度走
事件流），无 receipt 概念 —— **不为此加协议方法**，替代：

- `cogent_session_submit` 默认返回 `{accepted:true}`（诚实呈现受理语义）；
- 可选 `waitMs`（上限 120s）：server 先 WS 订阅（/ws + token）再 submit，
  等 `run.completed` / `run.failed`（types.ts:1070/1089）落地后返回终答
  摘要 + messages 引用；超时返回已受理状态（不判失败 —— 受理是真的）。
  便宜且有收益（外部 agent 一次调用拿终答，省它自己写轮询），进首发；
- 无幂等键：annotations `idempotentHint:false` + description 写明
  「重试可能重复提交」（真实墙见 §4-3）；
- 流式的边界与预留：token 级流式（message.delta）在 MCP 无对应物，
  工具返回即终态快照 —— 但 MCP 标准有 **progress notifications**
  （client 传 progressToken，长调用期间 server 推粗粒度进度），后续可把
  `tool.progress` 事件译进去给 waitMs 等待加心跳（便宜的增强，非首发）。

### 3.5 审批谁来答（三层各就各位，2026-11-16 二轮调研定稿）

MCP 生态里运行时审批的**主位在客户端侧**：驱动方 agent 应用（Codex /
Claude Code / zcode）对自己的 MCP 工具调用有自己的审批层，依据是工具
annotations（dsh 实测证据见 §2.2 —— Codex `never` 档拒调 destructive
工具的报错原文）。Cogent 按主流分三层：

1. **客户端侧（主位）**：`cogent_session_submit` / 带写档的
   `cogent_session_create` / `cogent_approval_respond` 等写组工具标
   `destructiveHint:true, readOnlyHint:false` —— **远端的人在他们自己
   的 agent UI 里批**「要不要让外部 agent 调这个工具」。MCP 生态的
   人机审批就发生在这里，这是 annotations 纪律（§2.1）真正的消费者；
2. **GUI 共址（Cogent 特有）**：单 Host 拓扑下桌面 app 开着，会话内层
   审批（edit/exec）照常弹给本地用户 —— 人在桌面前的共址场景用。
   挂起对外部 agent 可见：`cogent_inspect_entries` 轮询见
   `approval.asked`（4d 审计对复用，零新协议面）；
3. **无人值守（显式）**：`cogent_session_create` **默认 plan 档**（只读
   零挂起，chat/读类开箱即用），放开 ask/auto/autonomous 必须显式传
   `permissionMode`。「安全默认 + 放开显式」四家同向：dsh 默认 elicit
   （index.ts:41）、Pi-meme schedules 强制 accessMode（tools.ts:74-84）、
   Codex `never` 档宁拒不放行（README:67）。D15「无人值守建会话即用
   auto/plan」思路在 MCP 面提前兑现。

elicitation（server→client 问它的人）是标准里的反向扩展位，dsh elicit
档即此（consent.ts:56-82）—— Cogent 首发不启用（墙见 §4-2；生态实测
Codex 要开关、Claude Code print 模式拒绝，见 §2.2）。
`cogent_approval_respond` 上写组但随写闸默认关；开了即把内层裁决权交给
外部 agent —— 面板选项/附言/切档语义全量保留（协议方法原样映射，
不做删减版）。

### 3.6 owner + 事件顺序（一次写工具调用）

```
owner: 凭据文件 = main 写 / mcp-server 读
owner: 工具注册表 = mcp-server/tools.ts（按凭据 scope 过滤）
owner: 鉴权/档位 = Host http/server.ts（不动，METHOD_MIN_SCOPE 即守门人）
owner: 提交等待 = mcp-server（WS 订阅 + 超时，Host 无状态）

zcode ──tools/call(cogent_session_submit)→ mcp-server
  → 读 mcp-access.json（每调用重读）
  → POST /rpc agent.submit（Bearer token，Host 档位表验 write）
  ← {accepted:true}
  waitMs？── WS run.completed/run.failed ──→ 终答摘要
  超时 → 返回 accepted 状态（如实，不判失败）
  任一步错 → 错误投影（网络/越档/超时各归一词，token 不进消息）
```

## 4. 边界 / 首发不做（逐条真实墙）

1. **HTTP（Streamable）transport 不做，只做 stdio** —— 真实的墙：当前
   无 HTTP MCP 消费者（zcode 本机 stdio 即可驱动）；HTTP 暴露面（TLS/
   Origin 白名单/公网部署审校）与 D15 chat 门面 / D16 拨出中继的远程
   场景天然捆绑，届时共享一套 token 面一次做。stdio 已覆盖 D9 验收句；
2. **elicitation 审批转发不做**（dsh elicit 档）—— 真实的墙：消费者
   elicitation 支持生态很薄（dsh 实测 README:75：Codex 需
   `approval_policy.granular.mcp_elicitations=true` 才转发、Claude Code
   2.1 print 模式直接拒绝、dsh 自家客户端不声明该能力）；且运行时审批
   主位在客户端 annotations 层（§3.5），再做服务端转发是第二通道要
   处理答复竞态；Cogent 审批面板语义（序号选项/附言/切档/始终允许）
   也超出 elicitation form 表达力；
3. **幂等键体系不建** —— 真实的墙：Host 无幂等域（Pi-meme 的幂等在
   HostApi v2 契约里，Cogent 协议无此概念），为 MCP 单侧建去重表是
   第二处真相（§约定 4）。缓解：idempotentHint:false + 工具 description
   写明重试语义；
4. **多 Host 不做** —— 单工作机单 Host 是 Cogent 的部署事实，无
   Pi-meme 多 Host 服务化场景；
5. **delete 类工具不做** —— Host 无删除预览/revision 两段式，裸删无
   安全闸（§3.3 表）；
6. **文件读面不做**（Pi-meme 有 files_list/files_read 工具组）—— 真实
   的墙：Cogent HostApi 无 files 方法（文件操作是 pi 内置工具在引擎内部
   执行，协议面从未暴露），加 = 新协议方法 + 根约束校验，是独立一批的
   量。首发可见性：session.messages 投影的工具卡带 edit diff
   （types.ts:199，D4 定稿进协议）+ inspect 详情，远端 agent 能看到
   「改了什么」，拿不到全文；有真实取文需求时单独立项；
7. **不建 dsh 式每连接 Agent/串行队列** —— MCP server 是无状态映射层
   （每调用独立 /rpc 请求），无连接级资源要管；Pi-meme 无状态同款。

## 5. 验收

- 单测：config/凭据文件解析（畸形/缺失/过期凭据的报错词）、工具注册表
  按 scope 过滤（readonly 凭据 = 写组零注册）、waitMs 超时返回 accepted；
- 集成（复用 tests/integration 现成 host spawn 骨架）：起 Host + 伪
  mcp-access.json → MCP 客户端（SDK Client + StdioClientTransport）连
  cogent-mcp → tools/list 断言两组工具面；submit（waitMs）→ 终答与
  session.messages 一致；ask 档触发写工具 → inspect.entries 见
  approval.asked/decided 对（GUI 人答路径 = 外部可见审计）；
- 四关全绿（lint / typecheck / build / npm test）；
- 手测（进 docs/测试用例/对外MCP.md）：zcode 真机配 stdio server 驱动
  会话全流程（列表→建会话→提交→终答→审批挂起 GUI 答→继续）；
- 文档四件：模块页 `模块/对外MCP.md`、技术笔记 `技术笔记/external-mcp.md`
  （四家对照）、用例册、架构.md 目录树补 mcp-server/。

## 6. 批次

单批 5a（改动面：mcp-server/ 四文件新建 + main 凭据文件写入 +
settings.json 增 externalMcp 键 + package.json 增 SDK 依赖 + 测试 +
文档四件）。预估 ~14 文件。**协议零变化**（settings.json 是 main 壳
配置、mcp-access.json 是新文件，均非 RPC 协议面；PROTOCOL_VERSION 不动）。
