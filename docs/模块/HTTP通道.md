# HTTP 通道

> HostApi 的第二扇门（[计划/全局架构.md](../计划/全局架构.md) D2）：同一份
> 方法注册表挂上 HTTP，供 curl / 脚本 / 未来的 webview 页与远程端驱动 Host。
> 当前进度 = 阶段 2a（`POST /rpc` 骨架，无鉴权）；票据签发（2b）、WS 事件流
> （2c）见计划。原理与四家对比看 [../技术笔记/hostapi-http.md](../技术笔记/hostapi-http.md)。

## 是什么 / 在哪

- 传输层：`src/host/http/server.ts` —— Hono + `@hono/node-server`，纯薄壳，
  只做"帧文本进、响应帧出"，零业务逻辑；
- 注册表：与 stdio 同一份 —— `src/host/host-main.ts` 的 `handleFrame()`
  （原 dispatch 改造：解析 → 守卫 → handlers Map 分发 → 响应帧）被两个
  传输门共调，保证守卫与分发路径唯一；
- 开关：env `COGENT_HTTP_RPC=1` 启动时开（默认不开，D2「按需」）；
  `COGENT_HTTP_PORT` 选端口（默认 0 = 随机），实际监听地址打 stderr 一行
  `[host] http rpc listening on 127.0.0.1:<port>`；
- 监听地址写死 `127.0.0.1`（fail-closed：非 loopback = 远程模式，是 2c 的
  显式决策 + 鉴权前提，配置失误不可能把引擎暴露到网络）。

## 怎么工作

`POST /rpc`，body 为一个 JSON-RPC 帧（与 stdio 一行一帧完全同构）：

```bash
curl -X POST http://127.0.0.1:<port>/rpc \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":"smoke","protocolVersion":1}}'
# → {"jsonrpc":"2.0","id":1,"result":{"service":"cogent-agent","protocolVersion":1,...}}
```

语义分层：**业务错误恒 HTTP 200**（parse error / method not found /
handler 异常都住在帧的 `error` 字段 —— JSON-RPC 错误是应用层语义，与
stdio 出口完全一致）；HTTP 状态码只表达传输层成败（413 单帧超 1MB 上限、
400 非请求帧、404 路由/方法不匹配）。

事件推送归属（2a 现状，2c 落 WS 前不变）：

```
服务层(SessionManager/审批/inspect) ──notify()──▶ stdout ──▶ main ──▶ renderer
 HTTP POST /rpc：请求帧进 → 响应帧出（HTTP body 原样带回）
                请求期间触发的 notify ──▶ 仍走 stdout 给 main（HTTP 门不截流事件）
```

即：**事件帧的唯一 owner 仍是 stdout → main**，HTTP 门是纯请求/响应，
对现有 stdio 链路零行为改动（全量集成测试回归佐证）。

## 边界

- 无鉴权：当前靠 loopback 信任语义（本机任意进程可连）；scoped token +
  一次性票据在 2b 落地（D3）；
- 无 WS、无事件推送（2c）；main 尚未集成（端口走 stderr 日志，2b 换协议
  握手字段）。

验收：`COGENT_HTTP_RPC=1` 拉起 Host 后，curl `POST /rpc` initialize 得到
`protocolVersion: 1` 响应帧；未知 method 回 `-32601` 帧且 HTTP 恒 200；
不开 env 时 Host 行为与阶段 1 完全一致。
