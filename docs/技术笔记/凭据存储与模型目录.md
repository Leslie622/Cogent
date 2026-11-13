# 笔记：凭据存储与模型目录（credentials + models）

> 对应路线项：第 5 项（safeStorage 凭据存取）。落点：
> `src/electron/main/credentials/store.ts`、`src/agent-service/runtime/credentials.ts`、
> `src/electron/main/ipc/credentials.ts` + `engine.ts`。

## 1. 问题

桌面 Agent 应用要替用户保管 provider API key，绕不开三件事：

1. **存哪里**：落盘明文 = 安全事故；不落盘 = 每次启动重输，体验崩坏；
2. **谁能看**：key 在 多进程架构（UI / 壳 / 引擎）里穿行，每一段的可见性要显式划界；
3. **怎么用**：引擎发起 provider 请求时按 provider 取 key，且要支持"运行中换 key"。

## 2. pi 的做法（1.5.0 源码）

### 2.1 CredentialStore 接口：引擎侧只有抽象

`pi-ai/dist/auth/types.d.ts:57`：`CredentialStore` 四方法（read/list/modify/delete），
`modify` 是唯一写路径且 per-provider 串行化（`auth/credential-store.js` 的 promise 链）——
OAuth 刷新场景"读-改-写"必须原子，pi 把并发正确性做进接口契约。
pi 只内置内存实现（`InMemoryCredentialStore`），持久化留给宿主 app 注入。

### 2.2 凭据解析链（请求级覆盖 → 存储 → 环境）

`auth/resolve.js:14` `resolveProviderAuthWithSignal` 的优先级：

```
overrides.apiKey（请求级显式传入）
  → credentials.read(providerId)（宿主持久的 CredentialStore）
  → provider.auth.apiKey.resolve({ credential: undefined })（环境变量等 ambient 源）
```

`agent-loop.js:275` 每轮请求把 `getApiKey(provider)` 的结果作为 overrides.apiKey 传入 ——
即 **Cogent 的内存表 key 走的是最高优先级通道**，用户配了 key 就不依赖环境变量。

### 2.3 provider 的 auth.resolve：key 与 env 分离

`providers/anthropic.js:14`：`resolve({ credential })` 返回 `{ auth: { apiKey }, env }` ——
credential 里的 `key` 变请求头，`env` 字段（如 Cloudflare 的 account id）注入
provider 作用域的环境查询。这个分离让"非机密配置"（endpoint 覆盖、账户 ID）与
机密同存一个 credential 对象但走不同通道。

### 2.4 模型目录：数据与代码分离

`pi-ai/dist/models.generated.js`：41 provider 的目录编译期生成（`providers/data/*.json`，
含 id/name/contextWindow/maxTokens/thinkingLevelMap/价格/兼容标志），
`flattenChatModelCatalog` 运行时铺平。`Models.getAvailable()` 还会按
`filterModels(credential)` 过滤 —— provider 可以声明"某类凭据才可见某些模型"
（如 OAuth 订阅 vs API key 的模型子集）。

## 3. 对比

### DeepAgent（作者此前项目）

- key 存环境变量 / 前端 localStorage（设置页写 localStorage，请求时后端读 env）——
  localStorage 对 XSS 完全裸奔，且 Electron renderer 崩溃恢复即丢；
  safeStorage（DPAPI/Keychain/keyring 加密）是 Electron 官方路径，Cogent 采用之。
- provider 列表硬编码在前端配置文件里，模型名手填字符串（拼错 404 运行时才暴露）；
  pi 的 catalog 是编译期生成 + 类型标注（`ChatModelCatalog` 泛型），拼错编译期就报 ——
  Cogent 的模型下拉直接投影 catalog，不存在手填模型名。

### Claude Code

- 凭据分层：API key 走环境变量（`ANTHROPIC_API_KEY`），OAuth 走
  `~/.claude/.credentials.json`（0600 权限文件存 refresh token）—— 文件权限即边界，
  简单但在 Windows 上等价保护弱（ACL 需额外设置）。Electron safeStorage 在 Windows
  走 DPAPI（绑用户账户），与 OS 集成更深；代价是不可移植（备份文件到别的机器解不开 ——
  这对本场景反而是正确语义：凭据不该随配置迁移）。
- 模型目录硬编码在 CLI 内（`/model` 列表），版本更新带新模型 —— 与 pi catalog 同思路，
  pi 只是把它做成了独立包（`pi-ai`）+ 生成管线，宿主不需要升级整个 CLI。

### 其他主流（Cursor / Continue 等 IDE 插件）

- 普遍做法 = key 存 VSCode SecretStorage（同样封装 OS keyring）—— 行业已收敛到
  "OS 级加密存储"这一共识，Cogent 用 safeStorage 是同款思路的 Electron 形态。
- Continue 允许自定义 provider（config.json 里写 baseUrl+key），灵活性换来了
  "配置文件含明文 key"的安全争议（社区反复讨论）—— Cogent 暂不支持自定义 baseUrl，
  规避该问题；将来支持时密文里加 env 字段（学 pi 的 credential.env 分离）。

## 4. 取舍

| 决策 | 备选 | 采信理由 |
| --- | --- | --- |
| main 持有 safeStorage 文件，引擎只内存表 | 引擎直接实现 pi CredentialStore + 读加密文件 | 引擎要保持"任何 Node 宿主可复用"（架构.md §1）——加密绑定 Electron safeStorage，放引擎会把引擎锁死在 Electron；宿主注入是协议已有的扩展点（initialize.credentials） |
| key 明文只在 main 内存 + 引擎内存，永不回流 renderer | renderer 需要时回查明文 | UI 只需要"配了没"（布尔位）；明文回流徒增泄露面。credentials.list 协议层就只回 keyConfigured |
| safeStorage 不可用直接抛错 | 降级明文落盘 | 明文落盘是安全事故不是兼容方案；宁可不支持（平台过旧）也不静默泄露 |
| 密文文件损坏报错不重建 | 损坏静默清空重建 | 约定.md §1.1 持久化读取行：静默重建 = 丢用户 key 还装作没事，报错让用户手工处理 |
| "清除 key" = 写空串 | CredentialStore 增加 delete 接口 | 空串在 keyConfigured 判空语义下自然失效；少一个 IPC + 协议 method；后续要"彻底删条目"再加 optional method |
| 模型目录全量投影（41 provider） | 白名单几家 | 目录是静态数据零成本；按 provider 过滤 UI 侧做（无 key 置灰），协议保持完整 |
| provider 名直接用 pi catalog 的 id（'anthropic'） | 自造显示名映射 | pi 的 name 字段已存在（如 "Anthropic"），UI 后续接 name 即可；多一层映射是多余状态 |

## 5. 在 Cogent 的落点

- `src/electron/main/credentials/store.ts`：CredentialStore（readAll/write/remove/listConfigured
  + assertAvailable）；文件形状 `{ version: 1, providers: { id: { apiKey: <base64 密文> } } }`；
- `src/electron/main/index.ts`：启动时 assertAvailable → readAll 灌 AgentServiceManager
  的 handshakeCredentials；
- `src/electron/main/service/manager.ts`：握手 initialize 携带 credentials（optional）；
- `src/agent-service/runtime/credentials.ts`：引擎侧 CredentialRegistry（loadAll/set/get/
  summaries/has），getApiKey 直查；
- `src/agent-service/index.ts`：credentials.set / credentials.list handler（入口显式收窄）；
- `src/electron/main/ipc/credentials.ts`：renderer 写入入口（形状校验 → 落盘 → 推引擎）；
- `src/renderer/src/features/settings/sections.tsx`：ModelsSection（per-provider 行：
  password Input + 保存/清除 + 状态 Badge），保存后 engine store refreshKeys 联动下拉。
