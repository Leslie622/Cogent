# HTTP 通道

> HostApi 的第二扇门（[计划/全局架构.md](../计划/全局架构.md) D2）：同一份
> 方法注册表挂上 HTTP + WS，供 curl / 脚本 / 未来的 webview 页与远程端驱动
> Host。当前进度 = 阶段 2 收官（2a 骨架 + 2b 票据鉴权 + 2c WS 事件流与
> 远程模式）。原理与四家对比看
> [../技术笔记/hostapi-http.md](../技术笔记/hostapi-http.md)。

## 是什么 / 在哪

- 传输层：`src/host/http/server.ts` —— Hono（`POST /rpc`、`/auth/exchange`）
  + ws 官方 noServer 模式（`GET /ws` upgrade），纯薄壳零业务逻辑；
- 鉴权域：`src/host/http/auth.ts` —— 一次性票据 store（消费即焚）+
  rootSecret + 长期 token HMAC 签验，纯逻辑无 HTTP 依赖；
- 注册表：与 stdio 同一份 —— `src/host/host-main.ts` 的 `handleFrame()`
  被三个传输门共调；档位判定 `scopeAllows` 同一份（/rpc 403 与 /ws
  -32003 帧同口径，换门不换规则）；
- 开关：env `COGENT_HTTP_RPC=1`；端口 `COGENT_HTTP_PORT`（默认 0 随机）；
  **远程模式** `COGENT_HTTP_HOST`（默认 127.0.0.1 fail-closed，显式设置
  才放开监听，恒鉴权仍在）；实际地址打 stderr（loopback 普通行 /
  非 loopback 警告行），`initialize` 响应同时带 `httpPort`。

## 怎么工作

**鉴权（D3，开门即要 token）**：

```
stdio: main ──capability.issue {scope}──▶ Host 票据 store（32B · 30s · 消费即焚）
HTTP:  消费者 ──POST /auth/exchange {ticket}──▶ 长期 token（v1.<payload>.<HMAC>，scope 随票据）
之后:  HTTP 带 Authorization: Bearer（或 ?token=）；WS 握手带 ?token=（同 verifyToken 同口径）
```

- rootSecret 不出 Host 进程；重启 = 全部 token 失效；
- scope 三档 `readonly ⊂ write ⊂ admin`；`capability.issue` 归 admin
  （防任意传输门低档 token 自签提权）。

**三个门，一套帧**（消息格式与传输正交）：

| 门 | 上行 | 下行 |
| --- | --- | --- |
| stdio（门 1，main 专用） | 一行一请求帧 | 响应帧 + 事件帧（stdout） |
| `POST /rpc` | body 一个请求帧 | 响应帧（恒 200，业务错误住帧内 `error`） |
| `GET /ws`（upgrade） | 文本帧 = 请求帧（同一 handleFrame） | 响应帧 + **事件帧广播** |

事件推送归属（2c 起，双出口同帧同时写）：

```
服务层(SessionManager/审批/inspect) ──notify()──┬─▶ stdout ─▶ main ─▶ renderer（不变）
                                                └─▶ broadcastEvent ─▶ 所有在线 WS 连接
 断线：连接级状态随之丢弃，消费者重连后拉快照（session.messages）补偿；
      游标式断点续传（Pi-meme EventCursor 模式）留待真实远程 UI 需要时立项
```

**WS 实现边界**：ws 包官方 noServer 模式（`server.on('upgrade')` +
`handleUpgrade`）——zcode 用 @hono/node-ws 但其 peer 锁 @hono/node-server@^1
（本项目 2.x），单端点场景标准 upgrade 路径无桥接依赖；浏览器 WebSocket
不能自定义 Authorization 头（MDN WebSockets API），`?token=` query 是标准
传递位。关闭走 drain 语义（先 `close(1001)` 排空 250ms 再 terminate 兜底，
zcode 同款 —— HTTP server.close() 不收敛已 upgrade 的连接）。

**CORS 全放行**（hono/cors）：页面消费者（webview/浏览器）与 `127.0.0.1`
永远跨源，无放行头浏览器直接拦（Pi-meme 用同源反代绕开，Cogent 页面直连
就必须回头）。真边界仍是恒鉴权 token —— 恶意网页能发请求但无 token
一律 401（票据也拿不到）；WS 不受 CORS 约束，upgrade 鉴权同理。

## 边界

- 事件广播无按会话过滤（所有在线连接收全部事件；session 绑定档留阶段 3
  webview 消费者）；无 WS 心跳 ping（loopback 稳定；远程 UI 实用化时再加）；
- main 侧已接线（`HostManager.getHttpPort()` / `issueCapability()`），
  renderer/webview 消费者 = 阶段 3（调试 UI 改造为首个内嵌页面）；
  **对外 MCP server 是第三个消费者**（5a）：main 在 Host 启动后走同一
  签票链铸 token 写 mcp-access.json（凭据链与拓扑见
  [对外MCP.md](对外MCP.md)），token 随 Host 生死对它同样成立。

验收：`COGENT_HTTP_RPC=1` 拉起 Host 后 —— stdio `capability.issue` → curl
`/auth/exchange` 换 token → Bearer 调 `session.list` 200；readonly 越档
（HTTP 403 / WS -32003 帧）；票据重放/伪造 401；Host 重启旧 token 401；
WS 连接收请求响应与事件广播（`tests/integration/http-auth.test.ts` S1–S11，
S11 = mock LLM 真事件流 `run.started`/`message.delta`/`run.completed` 端到端）。
