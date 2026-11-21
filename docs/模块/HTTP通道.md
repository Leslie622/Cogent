# HTTP 通道

`attachments.*`、`files.*`、`outputs.*`为桌面专用入口，HTTP/WS不论token档位一律拒绝，防止远程消费者
按本机路径访问文件。WS不广播outputs事件，session.messages不夹带产物表；详见[附件](图片与文件附件.md)、[文件链接](正文文件链接.md)、[产物卡片](产物文件卡片.md)。

> HostApi 的 HTTP/WS 传输：与 stdio 共用方法注册表，供脚本、内嵌页面、
> 浏览器和对外 MCP 驱动运行中的 Host。
> 原理对比见[HostApiHTTP通道](../技术笔记/HostApiHTTP通道.md)。

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
- scope 三档 `readonly ⊂ write ⊂ admin`；自动标题配置读取为 readonly、修改为 admin，
  防止普通会话写票据改变全局辅助模型策略；`capability.issue` 归 admin
  （防任意传输门低档 token 自签提权）。

**三个门，一套帧**（消息格式与传输正交）：

| 门 | 上行 | 下行 |
| --- | --- | --- |
| stdio（门 1，main 专用） | 一行一请求帧 | 响应帧 + 事件帧（stdout） |
| `POST /rpc` | body 一个请求帧 | 响应帧（恒 200，业务错误住帧内 `error`） |
| `GET /ws`（upgrade） | 文本帧 = 请求帧（同一 handleFrame） | 响应帧 + **事件帧广播** |

事件推送归属（双出口同帧同时写）：

```
owner: 事件源 = Host 服务层；广播出口 = notify
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

- 事件广播不按会话过滤，所有在线连接收全部事件；尚无 session 绑定 scope、
  游标重放和 WS 心跳，远程消费者须按现有断线语义补拉快照。
- main 经 `HostManager.getHttpPort()` / `issueCapability()` 为消费者接线；
  webview 通过 guest preload 换票后直连（见[内嵌页面](内嵌页面.md)）。
- 对外 MCP 使用同一签票链，main 写入 `mcp-access.json`，token 随 Host 生死，
  拓扑与凭据轮换见[对外MCP](对外MCP.md)。

验收：`COGENT_HTTP_RPC=1` 拉起 Host 后 —— stdio `capability.issue` → curl
`/auth/exchange` 换 token → Bearer 调 `session.list` 200；readonly 越档
（HTTP 403 / WS -32003 帧）；票据重放/伪造 401；Host 重启旧 token 401；
WS 连接收请求响应与事件广播（`tests/integration/http-auth.test.ts` S1–S11，
S11 = mock LLM 真事件流 `run.started`/`message.delta`/`run.completed` 端到端）。
