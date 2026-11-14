# HostApi HTTP 通道 —— 同一注册表挂上第二扇门

> 阶段 2a（2026-11-15）：`POST /rpc` 骨架；阶段 2b：票据鉴权（D3）。
> 代码落点：`src/host/http/server.ts`（传输层）、`src/host/http/auth.ts`
> （票据 store + rootSecret + token 签验）、`src/host/host-main.ts` 的
> `handleFrame()`（共用分发入口）与 `capability.issue` handler。
> 模块现状见 [../模块/HTTP通道.md](../模块/HTTP通道.md)。

## 1. 问题

stdio 只能服务"父子进程"这一种拓扑：Electron main spawn Host，管道即通道。
但 HostApi 的消费者不止 main —— webview 第三方页、远程浏览器端、curl 脚本、
未来的 chat 门面（D15）与拨出中继（D16）。这些消费者与 Host 没有血缘关系，
必须走网络端点。核心问题因此不是"加一个 HTTP 服务器"，而是：**27 个方法
+ 12 个事件的注册表如何被多个传输通道共用而不分叉** —— 每扇门各自解析
一遍协议，守卫与错误语义迟早漂移。

## 2. pi 的做法（上游没有这条路）

pi 上游只有进程协议：`--mode rpc` 是 JSON stdin/stdout
（`reference/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:2-5`，
"Receives commands as JSON on stdin, outputs events and responses as JSON
on stdout"；入口 `src/rpc-entry.ts`）。**pi 不提供任何 HTTP 面** —— HTTP 门
是 Cogent 在 Host 侧自建的层，pi 的启发仅在"帧格式与传输无关"这一点上：
pi 的 rpc 帧本身就是可序列化 JSON，换管道不改帧。

## 3. 对比（四家）

| | 通道形态 | 鉴权 | 事件怎么出 | 出处 |
|---|---|---|---|---|
| **zcode** | Hono + `createNodeWebSocket` 同 port 双轨；默认 `127.0.0.1`，非 loopback 直接 throw（fail-closed） | Bearer 头 **或** `?token=` query（浏览器 WS 不能自定义头），`timingSafeEqual` 恒时比较 | WS 推送（consumer 持一条 WS） | `reference/zcode/packages/zcode-server-cli/src/server-core/http.ts`（200–280 段：loopback throw / 双轨鉴权 / `/api/server-info` 匿名协商端点）；票据 `hostCapability.ts`（TTL 一次性，消费即焚） |
| **Pi-meme** | 控制面 `HostControlRequest/Response` + 事件面游标分页（`EventPage.resyncRequired` 标记断点后重同步） | 单 token | 事件流带 cursor，可拉可订（`events.subscribe`） | `reference/Pi-meme/packages/contracts/src/app-host.ts:282-290`（请求/响应）、`:119-147`（EventCursor/EventPage）、`:217-219`（subscribe） |
| **MCP Streamable HTTP** | POST + SSE 回传，规范层无裸 WS | Bearer | SSE 流内推 | 规范级对照（Cogent 阶段 5 的 D9 出口用它） |
| **im2.0（旧项目教训）** | local 进程**拨出** WS 连云端 IM | accessToken 放 URL query | AICHAT 信封沿同连接回推 | `websocket-chat-bridge.js`；教训不在 query 本身（zcode 生产同款），在 preload 泄漏进程级权限给页面 |

## 4. 取舍（Cogent 采用了哪种、为什么）

- **单一分发路径**：`handleFrame()`（原 stdio dispatch 改造，返回响应帧
  而非直写 stdout）被 stdio 主循环与 HTTP 门共调 —— 不是"参照谁"，是
  D2 的字面落实：注册表单一，门只管帧进帧出。stdio 链路零行为改动由
  全量集成测试回归佐证（103 用例）。
- **业务错误恒 200**：JSON-RPC 错误住在帧的 `error` 字段（与 stdio 出口
  逐字节同构）；HTTP 状态码只管传输层（413/400/404）。zcode 同款分层。
  代价是 curl 脚本必须解析帧判断成败 —— 对 Agent 引擎这是正确代价，
  因为"方法失败"本来就是应用语义。
- **写死 `127.0.0.1`**：比 zcode 的"可配置 + 非 loopback 需鉴权 throw"更
  紧一档 —— 远程模式是 2c 的显式决策，之前物理不可能开出去。
- **POST 先行、WS 后至**：2a 只装 `hono` + `@hono/node-server`；ws 依赖
  留到 2c（事件广播）再引入。Pi-meme 的游标事件流（cursor + resync）
  是 2c 断线补偿的现成参照。
- **2a 无鉴权 → 2b 恒鉴权**：zcode 的 ingressToken 可选（未配 = 匿名
  loopback），Cogent 2b 起 `COGENT_HTTP_RPC=1` 语义就是"scoped token
  通道"，无匿名档 —— 比 zcode 紧一档。双轨（Bearer 头 + `?token=`
  query）与 zcode 同款，query 轨为 2c 浏览器 WS 握手预留。
- **rootSecret 不出 Host 进程**（2b 落地对 D3 早期设想的修正）：早期设想
  "根 secret 经握手给 main"服务于"main 签发"；落地为 main 发起（stdio
  `capability.issue`）、Host 存证后，main 的信任就是 stdio 血缘、无需持钥，
  rootSecret 唯一用途 = 长期 token 的 HMAC 材料（生成/签名/验签全在
  Host 内）。zcode 的 ingressToken 也是同思路：凭证只在被连接侧闭环。
- **票据有 store、长期 token 无状态**（分工）：一次性票据要防重放，
  无状态 HMAC 做不到"消费即焚"，必须 store（zcode hostCapability 同构
  + scope 维度）；长期 token 数量不定、生命周期 = Host 进程，用 HMAC
  签名零存储，重启自然全失效 —— 两种生命周期两种机制，不混用。

## 5. 在 Cogent 的落点

- `src/host/http/server.ts`：`startHttpRpc(handleFrame, { port, rootSecret,
  store })`；鉴权中间件（除 `/auth/exchange` 外必须 token）+ `METHOD_MIN_SCOPE`
  方法档位表（28 方法 → readonly/write/admin 最低档，`capability.issue`
  = admin）在 `/rpc` handler 内 403 强制；`FrameHandler` 类型（`RpcResponse
  | null`，null 表示非请求帧，stdio 丢弃 / HTTP 转 400）；
- `src/host/http/auth.ts`：`createCapabilityStore`（TTL 30s 消费即焚，
  时钟/随机源可注入）、`createRootSecret`、`signToken`/`verifyToken`
  （v1.payload.HMAC，timingSafeEqual 恒时比较）；
- `src/host/host-main.ts`：`capability.issue` handler（scope 显式校验
  fail-fast）；`COGENT_HTTP_RPC=1` + `COGENT_HTTP_PORT`（畸形值拒启），
  实际地址打 stderr；
- 测试三层：`auth.test.ts`（10 用例：即焚/重放/TTL/篡改/跨 secret）、
  `server.test.ts`（14 用例：401/403/双轨/exchange/传输语义）、
  `tests/integration/http-auth.test.ts`（真 Host 构建产物全链 S1–S9，
  含 Host 重启后旧 token 失效的跨代断言）；
- curl 冒烟实录（2b）：exchange 两档 → Bearer 读 `session.list`（200）→
  readonly 越档 `session.create`（403）→ write 真建会话（200 拿 id）→
  无 token（401）→ 票据重放（401）。
