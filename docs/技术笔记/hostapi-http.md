# HostApi HTTP 通道 —— 同一注册表挂上第二扇门

> 阶段 2 全程（2026-11-15）：2a `POST /rpc` 骨架 → 2b 票据鉴权（D3）→
> 2b-2 main 集成 → 2c WS 事件流 + 远程模式。代码落点：`src/host/http/server.ts`
> （传输层）、`src/host/http/auth.ts`（票据 store + rootSecret + token
> 签验）、`src/host/host-main.ts` 的 `handleFrame()`（共用分发入口）、
> `capability.issue` handler 与 notify 双写。
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
- **WS 用 ws 官方 noServer 模式，不用 @hono/node-ws**（2c）：zcode 的
  `createNodeWebSocket({ app })` 来自 @hono/node-ws，但其 peer 锁
  @hono/node-server@^1（本项目用 2.x，npm view 证实最新版仍锁 1.x）。
  @hono/node-ws 的价值是把 upgrade 织进 Hono 路由（多 WS 端点 + 中间件
  链），Cogent 单端点用不上 —— `server.on('upgrade')` + `handleUpgrade`
  是 ws 文档的标准路径，鉴权直接调与 HTTP 中间件同一个 `verifyToken`
  （同口径的实质是同一函数，不是抄两份）。
- **档位判定单点 `scopeAllows`**（2c 施工中堵住的洞）：初版 WS message
  直连 handleFrame，绕开了 /rpc 的 METHOD_MIN_SCOPE —— readonly token
  可以经 WS 调写方法。修法是把档位判定提成纯函数供两门共用；WS 无 HTTP
  状态码，越档回 JSON-RPC server-error 帧（-32003，-32000~-32099 标准
  区间）。教训：**"同一注册表"只保证分发唯一，不自动保证鉴权唯一 ——
  每新增一扇门都要过一遍门级守卫清单（鉴权/档位/体积上限）**。
- **WS 关闭 drain**：HTTP `server.close()` 不会收敛已 upgrade 的连接
  （zcode WEBSOCKET_DRAIN_TIMEOUT 同款坑）—— 先 `close(1001)` 给正常
  客户端排空窗口（250ms）再 terminate 兜底，`HttpRpcServer.close()`
  按此实现并被单测钉住（客户端收到 1001 而非硬断）。
- **query token 的标准依据**：浏览器 `WebSocket()` 构造器只收 url +
  protocols，无自定义头能力（[MDN WebSockets API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)），
  token 走 query 或 `Sec-WebSocket-Protocol` 子协议字段是公认 workaround
  （[MDN Sec-WebSocket-Protocol](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-WebSocket-Protocol)）；
  zcode 生产同款（Bearer+query 双轨 + timingSafeEqual）。Cogent 选 query
  双轨，子协议方案留作替代（D2 已记）。
- **断线补偿不预建**：Pi-meme 的游标事件流（EventCursor + resyncRequired，
  `reference/Pi-meme/packages/contracts/src/app-host.ts:119-147`）是成熟
  形态，但 Cogent 阶段 2 的消费者是脚本/调试 UI，重连拉快照
  （session.messages）已够 —— 游标机制等真实远程 UI 实用化（事件量大到
  快照不够）再立项，避免为不存在的负载建机制。

## 5. 在 Cogent 的落点

- `src/host/http/server.ts`：`startHttpRpc(handleFrame, { port, hostname?,
  rootSecret, store })` 返回 `{ port, broadcastEvent, close }`；HTTP 鉴权
  中间件（Bearer+query 双轨）+ `scopeAllows` 档位单点（/rpc 403、/ws
  -32003 帧）+ WS upgrade（verifyToken 同口径）+ drain close；
- `src/host/http/auth.ts`：`createCapabilityStore`（TTL 30s 消费即焚，
  时钟/随机源可注入）、`createRootSecret`、`signToken`/`verifyToken`
  （v1.payload.HMAC，timingSafeEqual 恒时比较）；
- `src/host/host-main.ts`：`capability.issue` handler；notify 双写
  （stdout + `broadcastEvent?.(frame)`）；`COGENT_HTTP_RPC` / `PORT` /
  `HOST`（非 loopback 打警告行）；
- 测试三层：`auth.test.ts`（10 用例）、`server.test.ts`（20 用例：HTTP
  鉴权/传输 + WS 握手拒连/双向帧/-32003 防绕过/广播/1001 drain）、
  `tests/integration/http-auth.test.ts`（真 Host 构建产物 S1–S11：票据
  全链 + 跨代失效 + WS 请求 + mock LLM 真事件流端到端）；
- 冒烟实录（2b/2c）：exchange 两档 → Bearer 读（200）→ readonly 越档
  （HTTP 403 / WS -32003）→ write 真建会话（200）→ 无 token / 重放
  （401）；远程模式 `COGENT_HTTP_HOST=0.0.0.0` → NON-LOOPBACK 警告行 +
  全链仍通。
