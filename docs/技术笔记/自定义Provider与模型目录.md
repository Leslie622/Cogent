# 笔记：自定义 Provider 与模型目录管理（custom-providers）

> 落点：`src/host/runtime/custom-providers.ts`、
> `src/electron/main/custom-providers/store.ts`、设置页 ModelsSection。
> 对应 pi 机制：`createProvider` + `MutableModels.setProvider`。

## 1. 问题

内置模型目录是编译期固定的（41 个 provider，见 [pi接入与会话管理](pi接入与会话管理.md)），
但真实用户要接**目录之外**的端点：

- API 中转站 / 公司网关（OpenAI-compatible 协议，自有 baseUrl + key + 模型清单）；
- 本地推理服务（Ollama / vLLM / LM Studio）；
- 给内置 provider 挂代理（模型不变，只换端点）。

引擎不能为此改源码 —— 需要一个"运行时注册 provider"的机制。

## 2. pi 的做法（1.5.0）

### 2.1 createProvider：内置与自定义同一条路

`pi-ai/dist/models.js:534` 注释原话：
*"Built-in provider factories and models.json custom providers both go through this"* ——
`createProvider(input)` 从零件拼 Provider：`{ id, name, baseUrl, headers, auth, models,
fetchModels, filterModels, api, images, classifiers }`。关键细节：

- **api 字段两种形态**：单个 `ProviderStreams`（所有模型共用一种方言）或按
  `model.api` 分发的 map（`models.js:543`：`const single = input.api && typeof input.api.stream === "function"`）。
  自定义端点用单形式 + `openAICompletionsApi()`（懒加载工厂，
  `api/openai-completions.lazy.js` = `lazyApi(() => import("./openai-completions.js"))`）；
- **模型是纯数据**：`Model` 接口（`types.d.ts:653`）无方法，必填
  `id/name/api/provider/baseUrl/reasoning/contextWindow/maxTokens`（+ cost/input 等）；
- **auth 是最小契约**：`ApiKeyAuth.resolve({ credential })` 返回
  `{ auth: { apiKey } }` 或 `undefined`（未配置）。存储凭据经 resolve 的
  `credential` 参数到达（`auth/resolve.js:24` readCredential → resolveApiKey）。

### 2.2 setProvider：运行时 upsert

`models.js:52`：`setProvider(provider)` 按 `provider.id` 覆盖插入，
`deleteProvider(id)` 移除 —— Models 集合是活的可变注册表，`getModels()`/
`getModel()`/`streamSimple` 即刻反映。pi coding-agent 的 models.json
（`providers.json`：`{ providers: { id: { baseUrl, apiKey, models } } }`，
文档 models.md「Configure a compatible endpoint」）就是**启动时解析 JSON →
逐个 createProvider → setProvider** 的胶水；`/model` 打开时重载文件。

### 2.3 内置 provider 的 baseUrl 覆盖

pi models.json 允许只写 `"anthropic": { "baseUrl": ... }` —— 模型与认证不动。
实现层面这意味着"重建一个同 id provider，模型清单与流式实现沿用原实例"。

### 2.4 compat 自动探测

`Model.compat`（`types.d.ts:674`）注释：*"If not set, auto-detected from baseUrl"* ——
OpenAI-compatible 方言对非官方端点默认可用，未知代理无需手配兼容开关。

## 3. 对比

### DeepAgent（作者此前项目）

无自定义 provider 概念：provider 列表硬编码在后端 service 配置里，
模型名是字符串字段由前端手填 —— 拼错只在运行时 404。pi 把"端点+模型清单"
结构化成 Provider 对象（模型有 contextWindow/maxTokens 元数据），
Cogent 的模型下拉直接消费这些元数据，不存在手填模型名。

### Claude Code

- 自定义端点走**环境变量覆盖**（`ANTHROPIC_BASE_URL` 等 settings.json env 段）——
  只支持给内置 provider 换端点，不能新增"目录外 provider"；
  模型名可用 `ANTHROPIC_MODEL` 指定但仍是字符串。pi 的 createProvider 能力面
  严格更大（新增 provider + 挂任意模型清单）。
- 两者一致点：都不改源码、都走"配置 → 运行时注册"。

### Continue / 其他 IDE 插件

Continue 的 config.json 允许自定义 provider（baseUrl+apiKey 同文件），
灵活性大但 **key 明文进配置文件**是社区长期争议点。Cogent 拆开存：
定义（明文 JSON，非机密）与 key（safeStorage 密文）分文件、分 IPC 通道，
form 保存时两条路各走各的。

## 4. 取舍

| 决策 | 备选 | 采信理由 |
| --- | --- | --- |
| 自定义 provider id = `custom/<slug>` | 允许任意 id | 与 41 个内置 id 空间隔离，防撞名；UI 可按前缀区分展示 |
| 统一 `openai-completions` 方言 | 让用户选 api 类型 | 初版只开最通用的 Chat Completions；anthropic 与 responses 档均按真需求追加（见文末追加节），方言暴露面是产品决策 |
| 全量替换语义的 sync（ defs+overrides 一次推平） | 增量 add/remove/delete 三 method | 定义总量小（个位数），全量替换无 diff 逻辑、幂等、协议面最小 |
| 覆盖内置 provider 用"闭包委托原实例" | JSON 序列化原模型重建 | provider 的流式实现持有懒加载/重试状态，浅拷贝方法会丢行为；委托 `original.stream/streamSimple` 最忠实 |
| 引擎不持久化自定义定义，宿主落盘+同步 | 引擎自带文件存储 | 引擎零磁盘边界（架构.md：main 是壳不是业务的对偶——持久化归宿主）；引擎重启后 renderer load() 推回，代价一次 method 调用 |
| 设置页只铺 6 家常用内置 provider | 41 家全铺 | 全铺没法用；其余 provider 定义仍可经自定义 provider 接（或后续加"显示全部"开关） |
| 下拉只展示配了 key 的模型 | 置灰未配置项 | 用户拍板；未配置模型占位 300+ 项全是噪音 |
| cost 全 0 的自定义模型 | 手填价格 | 自定义端点计费不可知，0 是"未知"的诚实表达；usage 统计是后续路线项 |

## 5. 在 Cogent 的落点

- `src/host/runtime/custom-providers.ts`：CustomProviderRegistry
  （snapshotBuiltin/sync/buildCustomProvider/buildOverrideProvider）；
- `src/host/runtime/session.ts`：SessionManager 持有 registry，
  `syncCustomProviders()` 委托；
- `src/host/index.ts`：`providers.custom.sync` handler（入口逐项形状收窄）；
- `src/electron/main/custom-providers/store.ts`：明文 JSON 持久化
  （userData/custom-providers.json，损坏报错不重建）；
- `src/electron/main/ipc/custom-providers.ts`：get/set（set 时引擎 running 即推 sync）；
- `src/renderer/src/stores/engine.ts`：customProviders/overrides 状态 + saveProviders
  （落盘→sync→重拉目录）+ load() 时把落盘定义推回引擎；
- `src/renderer/src/features/settings/sections.tsx`：ModelsSection
  （常用 6 家 + baseUrl 覆盖输入 + CustomProvidersCard 表单）；
- `src/renderer/src/features/chat/ChatInput.tsx`：下拉只渲染可用模型
  （usableModels 过滤）+ activeModelId 失效回落第一个可用。

## 追加：override 链路连环三修（2026-11-09 用户 DeepSeek 实测引出）

**① 定价继承缺失**：`buildModel` 把 cost 硬编码 0，而 override.models 同 id
条目会顶掉目录条目 —— 用户编辑过目录模型（如 deepseek-flash）后成本统计
静默归零。修复 = merge 语义：同 id 以目录条目为基底，用户 def 显式设置的
字段才覆盖；cost 永远继承目录（协议 ModelDef 无此字段，用户不可配价），
全新自定义模型保持 0（端点计费不可知）。

**② baseUrl 覆盖对目录模型不生效**：`buildOverrideProvider` 只给
override.models 新增条目设了新端点，目录透传模型原样带官方 baseUrl，且
流式委托回原生 provider 实例 —— 设置页填的中转地址，目录模型从未走过
（直到假 key 打官方端点吃 401 才暴露）。修复 = 目录模型浅拷贝重写
baseUrl（目录模型是纯数据对象，浅拷贝安全）。

**③ 同名模型跨 provider 歧义**（关联发现，落点在 submit 而非本模块）：
azure 目录也收录 deepseek-v4-pro（Azure Foundry 托管版），引擎 submit 按
id 全局查找按注册序命中 azure 那份 → "Provider is not configured: azure"。
修复 = 协议 `agent.submit` 加 optional `provider`，UI 选择时的 provider
原样下发、引擎 `getModel(provider, id)` 双键限定；renderer 侧查 provider
同样要先过 usableModels（全集按 id find 还是会撞未配 key 的那家）。
对照冒烟配方见 tests/integration/harness.ts（ambiguity-smoke：不带 provider
复现 azure 报错 / 带上则成功）。

## 追加：userDefined 判定与"显示一律 id"（2026-11-10 用户定调）

**背景（方向反转）**：2026-11-09 曾做过"设置页与聊天菜单显示名统一"（目录名
基底 + `name ?? id` 渲染）；次日用户定调废弃——**显示一律用模型 id，只有 id
的概念**：pi 目录名（DeepSeek V4 Pro 之类）是营销名，与 API 请求体里的 id
不对应，所见即所传才是正解；用户自添加模型 id 输什么是什么，调不调得通用户
自负责。name 字段保留在协议里（pi Model 需要），但 UI 不再消费。

**userDefined 的由来**：配套规则"默认（目录原生）模型编辑时锁 id"需要精确
区分目录原生 vs 用户添加。坑：**覆盖重建后的 models 集合不可作判定基准**——
`buildOverrideProvider` 把 override.models（目录同 id 覆盖 + 目录外新增）一并
注册进 provider，混在一起无法分辨。正解 = `originals` 快照（snapshotBuiltin
在引擎构造时记录的纯 pi 目录）：`isUserDefined(provider, id)` = 自定义
provider（customIds）恒 true；内置 provider 则看 id 是否在 originals 目录里。
协议落点 = `ModelSummary.userDefined?: boolean`（只增 optional，老宿主缺省
false = 目录原生，宁可少锁不误锁）。

冒烟断言（协议级）：目录原生与被覆盖的目录模型 false / 目录外新增与自定义
供应商条目 true，mock 手法见 tests/integration/harness.ts。

## 追加：模型开关两事 —— 实时性排查与禁用行复活（2026-11-10）

**"重启才生效"排查**：用户报告设置页只放开两个模型、聊天下拉仍全量，重启
应用后正常。逐环核链路（preload → main IPC → 引擎 sync → refreshModels）
均正确，冒烟钉死引擎实时性：sync(disabledModels) 后 `models.list` 立即只剩
放开的模型（disabled-smoke，见 tests/integration/harness.ts）。根因 = **旧引擎
子进程**：引擎是独立 node 进程，renderer HMR / 热重启都不替换它，用户实例
跑的是 disabledModels 过滤提交前的旧构建。属环境排障教训。

**禁用行复活（真 bug，重启后必撞）**：目录模型行由 `models.list`（已过滤）
构建，而引擎不注册被禁模型 → 开关一关行就从设置页消失，**可逆开关变得
不可逆**（打不回去）。截图里"关掉的行还在"恰是旧引擎没滤的假象。修复 =
设置页合并行末尾追加裸 id 行（disabledModels 里不在 catalog、不被
override.models 接管的 id），无标签只带 OFF 开关；重新打开后模型回到
models.list，完整信息随 catalog 行回归。引擎侧"不注册"语义不动（submit
天然拒掉被禁模型，这是设计意图）。

**聊天菜单选厂商不关菜单**：配套交互修正 —— 厂商行是中途步（选完还要挑
模型），`closeOnClick={false}` 保持菜单打开，悬停模型行时 base-ui 浮层树
自动换出模型列表；模型行/管理模型保持点击即关。

**行序稳定（同日追加，用户反馈）**：复活行先按"追加到末尾"实现，开关一翻
行就从目录位跳到末尾再跳回，用户点错。正解 = 合并行**统一按 id 排序**：行序
与启用状态、引擎刷新、目录快照顺序全部解耦，开关只改行内容（标签随裸 id 行
隐现）不动位置。不选"引擎带 disabled 标记回传全量目录"那条路：要重建
"全启用时的目录序"且得对齐 buildOverrideProvider 的覆盖行重排语义，复杂度
不成比例。

**added 漏滤 disabledModels（同日修）**：`buildOverrideProvider` 此前只滤
目录行，内置 provider 上用户新增的模型关了开关照样注册。修复时注意
`addedIds` 必须取**未滤的** override.models 全集 —— 被禁的同 id 覆盖行自己
不注册，但它的存在仍要压住目录孪生（否则关掉覆盖行反而把官方目录模型放
回来）。冒烟断言扩到三类：目录禁用 / 新增禁用 / 覆盖行禁用（disabled-smoke）。

**选择状态双键（2026-11-10 续，"自定义厂商选不上"）**：用户自定义网关
（公司GLM）模型 id 与 zai 目录同名、两家都配了 key —— 菜单里点该厂商，
勾选停在 Z.AI 不动。根因 = 选择状态只存 model id，三处 id 单键 find 全命中
目录在前那份：菜单 active 查找、ChatComposer 的 provider 派生（submit 会
下发错家）、上下文指示器分母。昨日 ③ 只修了 submit 协议与引擎侧双键，
**状态侧没跟上** —— 单键写入的 activeModelId 本身就是歧义值，查的人再怎么
过滤也救不回。修复 = 状态升级 {activeModelId, activeProviderId} 成对
（settings.json 加字段，旧文件缺省 null 退化为 id 单键，用户点一次即补全）；
查找统一走 findActiveModel 双键；回落顺序 = 同 provider 首个模型（保住厂商
选择）→ 全局首个。

## 追加：第三方言 openai-responses 与网关路由权限坑（2026-11-10）

**排查故事（三层洋葱）**：用户接公司网关（New API，request id 格式辨认）
连踩三坑，每层错误都换了模样：

1. `404 Invalid URL (POST /v1/v1/messages)` —— baseUrl 填了带 /v1 的地址，
   Anthropic SDK 又自拼 `/v1/messages`，路径翻倍；
2. 修成根地址后 `403 model_access_denied` —— 先疑模型名大小写（网关令牌
   白名单精确匹配），改到与 ZCode 配置逐字符一致仍拒；
3. 切 openai-completions 方言后错误信封**从 Anthropic 格式变成 OpenAI 格式**
   （`{"error":{...},"type":"error"}` → 平铺 + param/code 字段）——信封变了
   证明路由切换生效、Cogent 请求本身无误；三个数据点（同 key 同模型：
   /v1/responses 通、/chat/completions 与 /messages 皆 403）收敛出真相：
   **网关按路由放行模型权限，此令牌只有 Responses 端点可用**。

**排查方法论（可复用）**：

- **错误信封 = 命中路由的指纹**：Anthropic 端点回 Anthropic 错误形状，
  OpenAI 端点回 OpenAI 形状 —— 改配置后先看信封变没变，再读错误内容；
- **同一凭据在别的客户端（ZCode/curl）通** = 权限在服务端按路由或按模型
  划分，客户端侧只剩"对齐可用路由"一条路。

**决策**：补第三方言而非让用户去网关侧放行 —— 网关未必归用户管，且 pi 的
KnownApi 本就内置 `"openai-responses"`（懒加载工厂 `openAIResponsesApi`，
与另两方言同构），Cogent 只是没暴露。落点五处：协议 apiFormat 值域 +1
（只增不破）、引擎 `API_BY_FORMAT` 三厂映射（原二元三元改表驱动，往后加
方言只添一行）、index.ts 入口校验白名单、env.d.ts 镜像、设置页下拉第三档。

**对比**：DeepAgent 无方言概念（单一 OpenAI 兼容后端）；Claude Code 只说
Anthropic 协议（自定义端点也走 ANTHROPIC_BASE_URL）；Codex CLI 反向只走
Responses；ZCode / Cherry Studio 系给用户开多方言下拉。pi 的启示：方言是
provider 的可插拔零件（懒加载工厂 + compat 探测兜底），宿主暴露几档是产品
决策而非引擎约束 —— Cogent 由此从"两档够用"升到"三档对齐主流网关"，
后续 gemini/bedrock 等真需求出现再添。

**baseUrl 规则表（UI 注释同源）**：

| 方言 | SDK 拼接 | baseUrl 应填 |
| --- | --- | --- |
| openai-completions | + /chat/completions | 带 /v1 |
| openai-responses | + /responses | 带 /v1 |
| anthropic-messages | + /v1/messages | 根地址（不带 /v1） |
