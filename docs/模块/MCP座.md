# MCP 座

> Cogent 作为 MCP 客户端消费外部服务；对外 MCP Server 方向相反，见[对外MCP](对外MCP.md)。
> 原理与实读对照见[技术笔记](../技术笔记/MCP座.md)，真实服务验收见[手测册](../测试用例/MCP座.md)。

## 入口与所有权

| 职责 | 入口与真源 |
| --- | --- |
| 配置、作用域、信任 | `runtime/mcp-config.ts`、`mcp-trust.ts`；Host 单写 `mcp.json` / `mcp-trust.json` |
| 连接、状态、能力目录 | `runtime/mcp-runtime.ts` 的 `McpRuntimeManager`；Host 单实例，复用 pi-mcp `McpClient` |
| 传输 | `runtime/mcp-transports.ts`；stdio、Streamable HTTP、Legacy SSE，关闭时回收子进程树 |
| 会话工具桥 | `kernel/cogent-mcp-extension.ts`、`pi-session-factory.ts`；pi 扩展与 `tool_search` |
| OAuth 凭据 | `runtime/mcp-oauth.ts` / `mcp-secrets.ts`；main `credentials/mcp-store.ts` 单写加密文件 |
| RPC 与 UI | `runtime/mcp-handlers.ts`；设置 `McpSection`、`McpServerDialog`、`McpManagementDialogs` |

## 配置、存储与生效

```text
用户 mcp.json → 项目 .mcp.json → 项目 .cogent/mcp.json（右侧优先）
        ↓ 定义校验、override 合并、projectId + 真实路径 + sha256 信任
McpRuntimeManager → 共享连接与实时目录 → 回合边界同步 pi 工具和提示段
        ↑ main safeStorage → initialize / OAuth 状态交接 → Host 仅内存使用
```

- 存储根为 `COGENT_HOME ?? ~/.cogent`；配置使用生态 `mcpServers` 形状，未知字段、
  `oauth`、`toolExposure`、`cwd`、`timeout` 无损往返。整包非法时不半写。
- 项目文件可定义新服务，也可只覆盖同名服务的 `enabled/exposure/toolExposure`。
  新定义未经审阅不连接、不探测、不暴露能力；信任持久化到 `mcp-trust.json`。
  文件变动或项目身份不匹配即失效；授权时再次核路径及精确字节摘要。
- 三个来源按真实路径去重，同一物理文件只按先出现的来源读取一次：默认主目录会话的
  `<cwd>/.cogent/mcp.json` 就是用户文件，用户服务仍是受信的用户定义并复用全局连接。
  这种重合下没有独立的项目覆盖槽位，项目页覆盖明确拒绝，不改用户级定义。
- 缺省 `deferred`，由 `tool_search` 发现并激活；可按 server/工具切 `direct`、
  `deferred`、`hidden`。旧 `codemode` 明确归一到 `deferred`，不再静默不可达。
- 系统提示的 `mcp_servers` 段把 deferred 工具的目录亮给模型：按服务列工具名和描述首行，
  外部文本并成单行并转义；整段超过 4000 字符先降为只列名字，再退回服务名加数量。
  目录只让能力可见，不替模型选工具。
- `${VAR}`、`${env:VAR}`、`${VAR:-default}`、`${workspaceFolder}`、
  `${COGENT_PROJECT_DIR}` 只在连接瞬间单遍展开；缺失必需值报错。
  stdio 默认清洗宿主敏感 env，server 显式声明的键正常注入；不改技能正文模板语义。
- 用户配置按校验后的原定义保存，不自动迁移静态 env/header/clientSecret/URL 凭据。
  不支持 `${secret:KEY}`；旧引用明确报错并提示改用环境变量，读取不改配置；
  旧凭据文件在显式 OAuth 写入成功前保留供恢复。
- 用户级且不依赖项目目录的连接跨会话复用；项目定义或含项目路径的连接按真实主根隔离，
  复用前仍逐项目检查信任。会话销毁释放引用，项目连接闲置默认 15 分钟回收；Host 退出统一关闭。
- 配置修改、重连及服务端能力通知刷新目录，下一回合热生效。调用执行前再次检查当前
  工具是否可达，旧连接和排队调用不能绕过禁用/信任失效。日志位于 `pi/mcp.log`，有界轮转并脱敏。

## 认证与交互边界

- main 仅把 OAuth 状态加密保存到 `mcp-credentials.json`，静态认证按配置或环境变量提供。
  读取遇损坏、跨机解密失败或安全存储不可用时返回空 OAuth 快照，记录日志及 `status().error`，
  不阻断桌面启动、不覆写旧文件；后续显式加密写成功才覆盖并解除故障。
  写入时 `safeStorage` 不可用或 Linux `basic_text` 后端均拒绝，不回退明文。
  OAuth 写回须等待 main 提交确认，同代 Host 的启动与状态交接有序执行；旧文件的 secret 表不再消费。
- OAuth 复用 pi 的发现、PKCE、DCR、预注册客户端、刷新锁与 loopback 回调；
  支持手动回调、取消和登出。CIMD 需要发行方公开客户端元数据文档并显式配置
  `COGENT_MCP_OAUTH_METADATA_BASE_URL`，缺失时报错，不能冒充其他产品身份。
- MCP 工具仍经过 pi 工具管线和[审批](审批与权限.md)。已受信服务的 annotations
  参与只读/执行分类；`ask` 中只读 MCP 也询问，破坏性/未声明工具归执行档。
  支持会话内允许某工具或某 server 的只读工具；分类不替代配置和工具授权。
- Resources 支持标准三个模型工具与输入区 `@` 实体；Prompts 进入 `/mcp:server:prompt`
  候选和参数表单。Host 提交时按会话作用域展开，历史显示原始输入；大文本落盘，
  图片须当前模型支持原生图片，不能把 base64 文本当作识图。
- Form/URL Elicitation 按调用会话挂起，走 `mcp.elicitation.request/resolved` 与专属 IPC；
  非法答案保留表单，取消/超时/断开清理。共享连接串行归属交互，避免串会话回填。
- 设置页展示连接状态、工具暴露档、资源/提示词、诊断、重连、信任与 OAuth 登录。
  仅 `oauthAuthorized` 为真才显示登出；状态事件严格按当前用户/项目作用域接收。
  不提供密钥管理或附件参数绑定入口；附件读取不委托 MCP，`attachments.media` / `saveMedia`
  保留为弃用兼容，见[附件](图片与文件附件.md)。

## 验收

验收：配置/变量/信任/连接池/OAuth/壳桥/交互/输入引用各有 `tests/host/runtime/mcp-*.test.ts`
及 `tests/electron/main/` 定向回归；`tests/integration/mcp.test.ts` 与 `mcp-primitives.test.ts`
验证真实 Host、mock MCP/模型的工具搜索、同会话热刷新、审批、附件带路径直接调用、资源、提示词和交互闭环。
工具目录的三档降级与外部文本清洗在 `tests/host/kernel/mcp-catalog.test.ts`。
`tests/integration/mcp-oauth.test.ts` 覆盖本地受保护 HTTP MCP 的 DCR/PKCE 登录、私有持久化确认、工具调用与登出。
Composer、设置页与交互面板由 `tests/renderer/` 验证行为。真实厂商 OAuth、Electron 外部浏览器
登录及多平台子进程树回收仍按[手测册](../测试用例/MCP座.md)逐项记录，自动测试不代表实机通过。
