# HostApi HTTP 通道

> 学习主题：同一方法注册表如何服务不同拓扑，以及鉴权为什么不能只放分发器。
> 当前方法、事件、配置与验收见 [HTTP通道模块](../模块/HTTP通道.md)。

## 1. 多一扇门，不多一套业务

stdio 服务 Electron main 与 Host 的父子进程关系；webview、浏览器和脚本没有这层
管道血缘，需要 HTTP/WS。若每个通道再解析和实现一套业务，参数守卫、错误语义与
方法集合会漂移。Host 因此只有一个 handleFrame 和方法注册表，传输层负责帧进帧出。

JSON-RPC 的业务错误住在 error 字段，HTTP 状态表达鉴权、体积、路由和解析等传输失败。
调用方必须读响应帧判断方法成败，不能把 200 一律当任务成功。

## 2. 参照实现与来源范围

| 参照 | 可借机制 | 出处 |
| --- | --- | --- |
| pi | JSON stdin/stdout，帧可序列化且不绑终端；原调研范围未发现 SDK 的 HTTP 宿主面 | `reference/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:2-5` 与 `src/rpc-entry.ts` |
| zcode | Hono + WS 同端口，loopback 策略、Bearer/query 双轨、恒时比较、一次性 capability | `reference/zcode/packages/zcode-server-cli/src/server-core/http.ts:200-280`、同目录 `hostCapability.ts` |
| Pi-meme | 单控制面，事件带 cursor/resyncRequired；订阅与快照补偿有明确契约 | `reference/Pi-meme/packages/contracts/src/app-host.ts:119-147,217-219,282-290` |
| MCP Streamable HTTP | POST/SSE 是标准 MCP 传输，不是任意 JSON-RPC 的裸 WS | 规范对照；Cogent 的 MCP 出口目前使用 stdio，不能把 Host HTTP 门称为 MCP HTTP 服务 |
| 作者旧 im2.0 项目 | 本地拨出 WS 到云端中继 | 教训是 preload 暴露进程权限与凭据，不能把 query 本身当作全部问题 |

这是原通道与页面接入调研的出处迁移；文档收缩没有重新确认各上游当前版本。

## 3. 票据与长期 token 为何用两种机制

```text
owner: Host（rootSecret、票据 store、HMAC 签验）
main ──stdio capability.issue──→ 一次性票据（30s）
页面 preload ──POST /auth/exchange──→ 消费票据 → scoped token
之后 /rpc 或 /ws ──token──→ 同一验签与 scope 判定 → handleFrame
Host 重启 → secret 换代 → 所有旧 token 失效
```

票据要消费即焚，无状态 HMAC 无法单独防重放，必须有 store。长期 token 则随 Host
进程生死，用 HMAC 验证可不维护无限 token 表。rootSecret 不出 Host；main 的信任
来自 stdio 血缘，只发起签发而不持根钥。不要把“main 发起”误写成“main 自己签”。

readonly/write/admin 是方法最低 scope，不是模型会话权限档。两层问题不同：
前者决定消费者可调哪些 API，后者决定会话工具执行是否需要人裁决。

## 4. 共用注册表并不自动共用安全边界

曾有 WS message 直接调用 handleFrame，绕过 HTTP 中间件的最低 scope 检查。
方法注册表完全共用，readonly 仍可借另一扇门写入。正确形状是 HTTP 与 WS
调用同一个 verifyToken/scopeAllows；不能抄两份看似相同的条件。
WS 不能回 HTTP 403 时，用明确 JSON-RPC 错误帧表达越档。

浏览器 WebSocket 构造器没有自定义 Authorization 头，query 或子协议字段是实际选择。
依据：[WebSockets API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)、
[Sec-WebSocket-Protocol](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-WebSocket-Protocol)。
Cogent 采用与 zcode 同类的 Bearer/query 双轨；token 不进入日志和用户错误文本。

默认只听 loopback，远程监听是显式配置并给出诊断，不能因为有恒鉴权就无意开放全部网卡。
CORS 是浏览器读取策略，不是认证：页面直连本机门需允许跨源，但任意网页仍必须持有效
scoped token。WS 也不受 CORS 保护，upgrade 必须自己验签。

## 5. WS 生命周期与事件顺序

使用 ws 的 noServer/handleUpgrade 接到现有 HTTP server；只有一个端点，无需再用
额外 Hono WS 适配层。原选型时 @hono/node-ws peer 与项目 node-server 主版本不一致，
不能把“框架提供封装”直接当作兼容性已成立。

HTTP server.close 不会主动收敛已经 upgrade 的连接，关闭先发 1001，给短暂 drain
窗口，再 terminate 未退出者。事件不重放，等待任务结果必须先订阅就绪再提交；断线
消费者拉 session.messages 快照，不能假定重新连上会补齐离线事件。
Pi-meme cursor 方案是有对应服务合同的增强，不能只在消费者加一个序号就冒认重放能力。

## 6. 真页面才能暴露的边界

preload 把 fetch 裸引用传给 SDK 会丢 this，需 fetch.bind(globalThis)；缺 CORS 头则
浏览器拦响应。Node fetch 单测既不执行浏览器同源策略，也不保证同样的 this 绑定，
因此单元全绿不能替代真 webview 验收。凭证传递细节见 [内嵌页面接入](内嵌页面接入.md)。

`src/host/http/server.ts` 管传输、upgrade 和 drain，`auth.ts` 管票据/HMAC，
`src/host/host-main.ts` 管唯一分发与事件广播。纯逻辑回归在 `tests/host/http/`，
构建产物全链在 `tests/integration/http-auth.test.ts`；用量和命令不在笔记重复维护。

本轮文档/运行身份、提交/迁移、配置与退出的三仓对照见[运行交接与数据可靠性](运行交接与数据可靠性.md)，当前实现以对应模块为准。
