# HTTP 通道

> HostApi 的第二扇门（[计划/全局架构.md](../计划/全局架构.md) D2）：同一份
> 方法注册表挂上 HTTP，供 curl / 脚本 / 未来的 webview 页与远程端驱动 Host。
> 当前进度 = 阶段 2a（`POST /rpc` 骨架）+ 2b（票据鉴权 D3）；WS 事件流与
> 远程模式（2c）、main 端消费（2b-2）见计划。原理与四家对比看
> [../技术笔记/hostapi-http.md](../技术笔记/hostapi-http.md)。

## 是什么 / 在哪

- 传输层：`src/host/http/server.ts` —— Hono + `@hono/node-server`，纯薄壳，
  只做"帧文本进、响应帧出"+ 鉴权中间件，零业务逻辑；
- 鉴权域：`src/host/http/auth.ts` —— 一次性票据 store（消费即焚）+
  rootSecret + 长期 token HMAC 签验，纯逻辑无 HTTP 依赖；
- 注册表：与 stdio 同一份 —— `src/host/host-main.ts` 的 `handleFrame()`
  （原 dispatch 改造：解析 → 守卫 → handlers Map 分发 → 响应帧）被两个
  传输门共调，保证守卫与分发路径唯一；
- 开关：env `COGENT_HTTP_RPC=1` 启动时开（默认不开，D2「按需」）；
  `COGENT_HTTP_PORT` 选端口（默认 0 = 随机），实际监听地址打 stderr 一行
  `[host] http rpc listening on 127.0.0.1:<port>`；
- 监听地址写死 `127.0.0.1`（fail-closed：非 loopback = 远程模式，是 2c 的
  显式决策 + 鉴权前提，配置失误不可能把引擎暴露到网络）。

## 怎么工作

**鉴权（2b 起，开门即要 token —— 比 zcode「未配 token 就匿名」更紧一档）**：

```
stdio: main ──capability.issue {scope}──▶ Host 票据 store（32B · 30s · 消费即焚）
HTTP:  消费者 ──POST /auth/exchange {ticket}──▶ 长期 token（v1.<payload>.<HMAC>，scope 随票据）
       之后 ──POST /rpc，Authorization: Bearer <token>（或 ?token= query 双轨）
```

- rootSecret：Host 启动生成、不持久化、**不出进程**（token 的 HMAC 材料）；
  重启 = 全部 token 失效（token 生命周期 = Host 进程生命周期）；
- scope 三档 `readonly ⊂ write ⊂ admin`（D3 的 session 绑定档留阶段 3）；
  方法档位表（`METHOD_MIN_SCOPE`，28 方法）在 `/rpc` handler 内强制，
  越档 403；`capability.issue` 归 admin —— 防 HTTP 侧低档 token 自签提权；
- 401（无/坏 token，或票据无效）vs 403（token 有效但越档）分层。

`POST /rpc` body 为一个 JSON-RPC 帧（与 stdio 一行一帧完全同构）。语义分层：
**业务错误恒 HTTP 200**（parse error / method not found / handler 异常都住在
帧的 `error` 字段 —— 与 stdio 出口完全一致）；HTTP 状态码只表达传输层成败
（401/403、413 单帧超 1MB、400 非请求帧、404 路由）。

事件推送归属（2c 落 WS 前不变）：

```
服务层(SessionManager/审批/inspect) ──notify()──▶ stdout ──▶ main ──▶ renderer
 HTTP POST /rpc：请求帧进 → 响应帧出（HTTP body 原样带回）
                请求期间触发的 notify ──▶ 仍走 stdout 给 main（HTTP 门不截流事件）
```

即：**事件帧的唯一 owner 仍是 stdout → main**，HTTP 门是纯请求/响应，
对现有 stdio 链路零行为改动（全量集成测试回归佐证）。

## 边界

- 无 WS、无事件推送（2c）；远程模式（放开监听）未开；
- main 尚未消费（端口走 stderr 日志；2b-2 的 `initialize` 响应带
  `httpPort` + HostManager 侧接线）；
- `?token=` query 双轨已就位（为 2c 浏览器 WS 握手预留，D2 同口径）。

验收：`COGENT_HTTP_RPC=1` 拉起 Host 后 —— stdio `capability.issue` 签发 →
curl `POST /auth/exchange` 换 token → Bearer 调 `session.list` 得 200 帧回；
readonly 调写方法 403；票据重放/伪造 401；无 token 401；Host 重启后旧
token 401（`tests/integration/http-auth.test.ts` S1–S9 钉死）。
