# 笔记：自定义 Provider 与模型目录管理（custom-providers）

> 落点：`src/agent-service/runtime/custom-providers.ts`、
> `src/electron/main/custom-providers/store.ts`、设置页 ModelsSection。
> 对应 pi 机制：`createProvider` + `MutableModels.setProvider`。

## 1. 问题

内置模型目录是编译期固定的（41 个 provider，见 [pi-agent-integration.md](pi-agent-integration.md)），
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
| 统一 `openai-completions` 方言 | 让用户选 api 类型 | 中转站/网关/Ollama 事实标准就是 Chat Completions；选项越少配置越简单，真需求出现再加 |
| 全量替换语义的 sync（ defs+overrides 一次推平） | 增量 add/remove/delete 三 method | 定义总量小（个位数），全量替换无 diff 逻辑、幂等、协议面最小 |
| 覆盖内置 provider 用"闭包委托原实例" | JSON 序列化原模型重建 | provider 的流式实现持有懒加载/重试状态，浅拷贝方法会丢行为；委托 `original.stream/streamSimple` 最忠实 |
| 引擎不持久化自定义定义，宿主落盘+同步 | 引擎自带文件存储 | 引擎零磁盘边界（架构.md：main 是壳不是业务的对偶——持久化归宿主）；引擎重启后 renderer load() 推回，代价一次 method 调用 |
| 设置页只铺 6 家常用内置 provider | 41 家全铺 | 全铺没法用；其余 provider 定义仍可经自定义 provider 接（或后续加"显示全部"开关） |
| 下拉只展示配了 key 的模型 | 置灰未配置项 | 用户拍板；未配置模型占位 300+ 项全是噪音 |
| cost 全 0 的自定义模型 | 手填价格 | 自定义端点计费不可知，0 是"未知"的诚实表达；usage 统计是后续路线项 |

## 5. 在 Cogent 的落点

- `src/agent-service/runtime/custom-providers.ts`：CustomProviderRegistry
  （snapshotBuiltin/sync/buildCustomProvider/buildOverrideProvider）；
- `src/agent-service/runtime/session.ts`：SessionManager 持有 registry，
  `syncCustomProviders()` 委托；
- `src/agent-service/index.ts`：`providers.custom.sync` handler（入口逐项形状收窄）；
- `src/electron/main/custom-providers/store.ts`：明文 JSON 持久化
  （userData/custom-providers.json，损坏报错不重建）；
- `src/electron/main/ipc/custom-providers.ts`：get/set（set 时引擎 running 即推 sync）；
- `src/renderer/src/stores/engine.ts`：customProviders/overrides 状态 + saveProviders
  （落盘→sync→重拉目录）+ load() 时把落盘定义推回引擎；
- `src/renderer/src/features/settings/sections.tsx`：ModelsSection
  （常用 6 家 + baseUrl 覆盖输入 + CustomProvidersCard 表单）；
- `src/renderer/src/features/chat/ChatInput.tsx`：下拉只渲染可用模型
  （usableModels 过滤）+ activeModelId 失效回落第一个可用。
