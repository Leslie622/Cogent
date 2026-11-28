# MCP 座：Host 连接池与 pi 会话桥

> 当前行为与验收入口见[MCP座](../模块/MCP座.md)。本笔记解释连接所有权、动态工具、信任和凭据边界。

## 所有权与调用链

旧版按会话调用 pi `createMcpExtension`，配置固定在装配快照中，设置页看不到连接本体。
当前 `McpRuntimeManager` 在 Host 统一持有连接；`createCogentMcpExtension` 负责将当前作用域
可用工具、资源及提示段装进 pi 会话，所有工具调用继续经过 `beforeToolCall` 和宿主审批。
复用 `@earendil-works/pi-mcp@1.5.2` 的客户端、stdio/HTTP 传输和 OAuth；Legacy SSE 为
应用层适配，不另外实现 JSON-RPC、MCP 握手、分页或授权协议。

```text
McpConfigStore.resolve → McpTrustStore → McpRuntimeManager.ensureScope
                                      ↓ 连接池/能力修订/会话调用上下文
              createCogentMcpExtension → pi ToolDefinition → beforeToolCall
                                      ↑ 工具搜索/下回合刷新/调用前再核授权
```

连接身份依据配置与目录依赖；工具暴露策略按调用作用域独立求值，不能由共享连接的第一个
会话覆盖其他项目。发现服务端交互请求时，单条连接中的有上下文调用串行执行，才能把
不含原工具调用 ID 的 `elicitation/create` 归属到正确会话。取消信号贯通 tools/call、
resources/read、prompts/get；服务端能力刷新亦排队，避免刷新与交互抢占上下文。

## 本次实读对照与采用

版本：`pi@74dcca7d4`、`zcode@c5904686`、`deepseek-harness@e8f7b93a`。
以下结论来自本次打开的同主题源码，不表示已运行这些上游仓库的测试。

| 主题 | 实读源码与结论 | Cogent 采用 |
| --- | --- | --- |
| 动态工具移除 | pi `packages/coding-agent/src/extensions/mcp/index.ts:388–452` 为工具分配防碰撞名字；SDK 没有注销接口，将已移除工具重新注册为 `hidden` | 会话桥在回合边界对比目录，移除/禁用工具重新注册为隐藏，执行时再查当前连接；不调用不存在的 unregister API |
| 工具搜索装配 | pi `packages/coding-agent/src/extensions/tool-search/index.ts:12–16` 注册 inactive 的搜索工具，SDK 消费者需显式装配并激活 | 装配 `createToolSearchExtension()`，存在 deferred 工具时激活 `tool_search`；用户搜索激活的工具在允许范围内保留 |
| 工具目录可见 | zcode `apps/zcode-cli/packages/core/src/tool/search/description.ts:13`：deferred 工具至少把名字亮给模型，取到定义前只有名字；pi 的 `tool_search` 描述不列可搜索的工具（`dist/extensions/tool-search/tool.js:236–239`）；pi 用 `<段名>…</段名>` 包每个系统提示段（`dist/core/system-prompt.js:117`） | `mcp_servers` 段按服务列出工具名和描述首行，三档降级同技能清单；来自外部服务的文本并成单行并做 XML 转义；目录只让能力可见，不替模型选工具 |
| 项目信任 | zcode `apps/zcode-cli/packages/bootstrap/src/workspace-mcp-trust/index.ts:24–35,58–80,174` 以 workspaceIdentity、工作目录、来源、执行配置摘要绑定授权 | Cogent 用注册表 projectId + 真实文件路径 + 精确文件字节 sha256；来源变动重新审阅，未受信不探测，不借用其他项目已连池实例 |
| 环境隔离 | dsh `packages/mcp/mcp-client/src/transport.ts:21–37` 先清洗宿主 env 再叠加显式配置 | stdio 清洗敏感宿主键，保留 server 显式声明；MCP 配置的环境变量展开与非机密技能正文隔离 |
| 协议与 OAuth | 已安装 pi-mcp 的 `dist/client.d.ts`、`dist/oauth/{sign-in,loopback,auth-provider,client-settings}.d.ts` 提供通知、反向请求、PKCE、回调、注册与刷新锁 | 连接观测、凭据桥与 UI 归 Host/main；协议流直接调用公开 API，不借助上游私有成员 |

## 凭据提交与安全失败

main 是 `mcp-credentials.json` 唯一写者，仅静默托管 OAuth 状态。`McpCredentialStore` 读取
损坏文件、跨机密文或不可用安全存储时记录 `startupError`，通过日志和 `status().error` 保留
诊断，再向握手提供空 OAuth 快照。读取不覆盖原文件，避免凭据故障卡住整个桌面；用户后续
显式写入时仍先校验加密与后端，拒绝 Linux `basic_text`，成功原子提交后才更新缓存并解除故障。
`getSelectedStorageBackend()` 仅 Linux 存在，Windows/macOS 不调用该 API；Windows 缺失该函数的
回归以及隔离 Electron 的实际加密读写探针已验证这一边界。
旧版文件的 secret 表不再解密或消费；成功的 OAuth 写入仅保留 OAuth 持久化内容。

Host 的 `McpSecretBridge` 仅保留 OAuth 内存状态；`save` 发私有 stdio 请求，收到 main 的
`persistResult` 后才发布。授权 URL 与 OAuth 状态写回由 `HostManager` 独立消费，不进入
renderer 广播或通用事件日志。启动交接按 Host 代次核验，排队发送时重读最终提交的 OAuth 表；
同 key 刷新串行锁防止重复消耗旋转 token。授权身份按服务器名、规范 URL 和作用域隔离，
仅存在 access/refresh token 才投影 `oauthAuthorized`；注册元数据与静态 header 不算已授权。

静态 env、认证 header、`oauth.clientSecret` 和 URL 按原定义校验保存，不自动生成 UUID 键
或改写配置，也不依赖 main 保存静态凭据。环境变量及项目路径在连接时单遍展开，宿主敏感
env 仍默认清洗；不再提供手动密钥管理或 `${secret:KEY}` 语法。旧引用明确报错并提示改为
环境变量，不自动把旧密文迁回明文，也不因读取改写用户/项目配置或旧凭据文件。

CIMD 除代码支持外，还依赖发行方公开符合 pi 文档布局的客户端元数据与回调 URI 声明。
`COGENT_MCP_OAUTH_METADATA_BASE_URL` 必须为无用户名、密码、查询或片段的 HTTPS 地址。
未提供时显式 CIMD 登录报可操作错误；`auto` 按上游发现规则走可用注册方式，不伪造 pi 身份。

## 运行与呈现的两种原文

模型收到的 MCP 资源/提示词正文属于来源数据，并非用户原话。`prepareMcpInput` 处理文本、
受支持图片及嵌入资源，大文本超 24K 落 `pi/mcp-input/`。`cogent.mcp-input.v1` 记录原始输入和
结构化引用；`readPiTranscript` 与 `toChatMessages` 回显用户实际输入，历史/搜索不重写模型转录。
工具结果继续走既有 24K 落盘保护，保留结构化结果、图片与资源链接供对话流呈现。

验证重点是行为而非类名：跨会话只连一次、不同项目不能借信任、改配置下一回合生效、
失效工具不能被旧调用执行、错误答案不消费挂起、取消精确清理会话、凭据提交失败不污染旧值。
`tests/integration/mcp-oauth.test.ts` 使用本地 DCR/PKCE 授权服务与受保护 HTTP MCP，验证
未授权、回调换 token、私有持久化确认、自动重连、实际工具调用及登出后的状态回落。
真实厂商 OAuth、发行方 CIMD 文档发布、Electron 浏览器交互及各平台进程回收须按
[手测册](../测试用例/MCP座.md)核验，不能由 mock 测试推断已通过。
