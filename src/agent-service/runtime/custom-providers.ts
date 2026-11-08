/**
 * 自定义 provider 注册表 —— 用户自建的 OpenAI-compatible 端点（中转站/网关/Ollama）。
 *
 * pi 的官方机制（README「createProvider」节）：createProvider 从零件拼 provider
 * （models.js:534 注释：内置厂商与 models.json 自定义厂商同走此路），
 * MutableModels.setProvider 运行时 upsert（models.js:52）。Cogent 把 pi coding-agent
 * 的 models.json 胶水换成"设置页表单 → 协议全量同步"：
 * 引擎只收 defs，无持久化（宿主持久化，握手/同步注入——见 docs/架构.md 凭据旅程）。
 *
 * 覆盖语义（全量替换）：每次 sync 以传入列表为准，本轮没出现的 custom id 被
 * deleteProvider 移除；内置 provider 的本地调整（ProviderOverrideDef：baseUrl
 * 覆盖 + 模型增删 + 模型禁用）同样全量替换——撤掉调整 = 重新 setProvider 原实例。
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import type { Api, Model, MutableModels, Provider } from '@earendil-works/pi-ai'
import type { CustomProviderDef, ModelDef, ProviderOverrideDef } from '../../protocol'

/** 自定义模型的兜底参数：无成本的通用 OpenAI-compatible 档位（用户端点上实际可用为准） */
const CUSTOM_MODEL_CONTEXT_WINDOW = 128_000
const CUSTOM_MODEL_MAX_TOKENS = 32_768

/** ModelDef → pi Model：缺省字段兜底（context/maxTokens/input/reasoning），cost 全 0
    （自定义端点计费对外不可知，UI 不显示价格即可）。
    thinkingLevels → thinkingLevelMap：选中的等级原值透传（openai 方言直落
    reasoning_effort），未选中置 null（显式不支持）；不选 = 不下发映射跟端点默认 */
function buildModel(def: ModelDef, api: Api, providerId: string, baseUrl: string): Model<Api> {
  const ALL_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  return {
    id: def.id,
    name: def.name ?? def.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: def.reasoning === true,
    input: def.input ?? ['text'],
    ...(def.thinkingLevels !== undefined && def.reasoning === true && {
      thinkingLevelMap: Object.fromEntries(
        ALL_LEVELS.map((level) => [level, def.thinkingLevels?.includes(level) ? level : null])
      )
    }),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: def.contextWindow ?? CUSTOM_MODEL_CONTEXT_WINDOW,
    maxTokens: def.maxTokens ?? CUSTOM_MODEL_MAX_TOKENS
  }
}

export class CustomProviderRegistry {
  /** 当前已注册的内置 provider 快照（overrides 委托流式行为用） */
  private originals = new Map<string, Provider>()
  /** 当前生效的自定义/覆盖 id（替换语义的比对基准） */
  private customIds = new Set<string>()
  private overriddenIds = new Set<string>()

  constructor(private models: MutableModels) {}

  /** 记录内置 provider 原始实例（SessionManager 构造完 builtinModels 后调用一次） */
  snapshotBuiltin(): void {
    for (const provider of this.models.getProviders()) {
      this.originals.set(provider.id, provider)
    }
  }

  /**
   * 全量同步：defs 建自定义 provider、overrides 覆盖内置 baseUrl，
   * 本轮未出现的 id 移除。返回同步数量（诊断用）。
   * disabled 的 def 保留在列表里但不注册（可逆开关）：它只是"本轮不出现在
   * 启用集里"，走同一条移除路径 —— 之前注册过的会被 deleteProvider 卸下。
   */
  sync(defs: CustomProviderDef[], overrides: ProviderOverrideDef[]): number {
    const active = defs.filter((def) => def.disabled !== true)

    // 自定义 provider：id 带 custom/ 前缀（与内置 id 空间隔离）
    for (const def of active) {
      this.models.setProvider(this.buildCustomProvider(def))
      this.customIds.add(def.id)
    }
    for (const existingId of this.customIds) {
      if (!active.some((def) => def.id === existingId)) {
        this.models.deleteProvider(existingId)
        this.customIds.delete(existingId)
      }
    }

    // 内置 provider 的本地调整（baseUrl 覆盖 / 模型增删）：同 id 新 provider，
    // 流式/auth 委托原实例。不用对象展开 —— provider 接口的方法要绑定原实例的
    // 闭包状态，浅拷贝会丢行为。
    for (const override of overrides) {
      const original = this.originals.get(override.providerId)
      if (!original) continue
      this.models.setProvider(this.buildOverrideProvider(original, override))
      this.overriddenIds.add(override.providerId)
    }
    for (const existingId of this.overriddenIds) {
      if (!overrides.some((override) => override.providerId === existingId)) {
        const original = this.originals.get(existingId)
        if (original) this.models.setProvider(original) // 撤覆盖 = 还原原实例
        this.overriddenIds.delete(existingId)
      }
    }

    return defs.length + overrides.length
  }

  /**
   * defs → pi Provider。方言由 def.apiFormat 决定：anthropic-messages 走官方
   * Anthropic SDK（它在 baseUrl 后自行拼 /v1/messages，baseUrl 填根地址），
   * openai-completions 是中转站/网关/Ollama 的通用方言（compat 按 baseUrl 探测）。
   * auth 从存储凭据取 key；未配 key 返回 undefined = provider 未配置。
   * pi 的 ApiKeyAuth.resolve 契约是返回 Promise（auth/types.d.ts:189），故用 async 形式
   */
  private buildCustomProvider(def: CustomProviderDef): Provider {
    const apiFormat = def.apiFormat ?? 'openai-completions'
    // disabledModels：可逆的"模型不注册"开关（定义保留，开关翻回即恢复）
    const disabled = new Set(def.disabledModels ?? [])
    // 模型清单 = modelDefs（完整定义）∪ models（简写 id）；同 id 时完整定义优先
    const advanced = def.modelDefs ?? []
    const seen = new Set<string>()
    const models: Model<Api>[] = []
    for (const modelDef of advanced) {
      if (disabled.has(modelDef.id) || seen.has(modelDef.id)) continue
      seen.add(modelDef.id)
      models.push(buildModel(modelDef, apiFormat, def.id, def.baseUrl))
    }
    for (const modelId of def.models) {
      if (disabled.has(modelId) || seen.has(modelId)) continue
      seen.add(modelId)
      models.push(buildModel({ id: modelId }, apiFormat, def.id, def.baseUrl))
    }
    return createProvider({
      id: def.id,
      name: def.name,
      baseUrl: def.baseUrl,
      auth: {
        apiKey: {
          name: def.name,
          resolve: async ({ credential }) => {
            const key = credential?.key
            if (!key) return undefined
            await Promise.resolve() // 满足接口的 Promise 契约（无实际异步工作）
            return { auth: { apiKey: key } }
          }
        }
      },
      models,
      api:
        apiFormat === 'anthropic-messages' ? anthropicMessagesApi() : openAICompletionsApi()
    })
  }

  /**
   * 内置 provider 的本地调整版：目录模型（滤 disabledModels）+ 用户新增模型
   * （override.models），流式/auth 委托原实例。baseUrl 空串 = 沿用官方端点。
   * api 基准取目录首个模型 —— 绝大多数厂商单方言；openai 这类混 api 的取第一项，
   * 真需要指定时后续在 ModelDef 上加 api 字段（用 .at(0) 取，空目录不炸）
   */
  private buildOverrideProvider(original: Provider, override: ProviderOverrideDef): Provider {
    const first = original.getModels().at(0)
    const api: Api = first?.api ?? 'openai-completions'
    const baseUrl = override.baseUrl.length > 0 ? override.baseUrl : (first?.baseUrl ?? original.baseUrl ?? '')
    const disabled = new Set(override.disabledModels ?? [])
    const added = (override.models ?? []).map((m) => buildModel(m, api, original.id, baseUrl))
    const addedIds = new Set(added.map((m) => m.id))
    const models: Model<Api>[] = [
      // 目录在前（保 pi 快照原序），用户新增排后；同 id 目录项被新增覆盖（不重复注册）
      ...original.getModels().filter((m) => !disabled.has(m.id) && !addedIds.has(m.id)),
      ...added
    ]
    return createProvider({
      id: original.id,
      name: original.name,
      baseUrl,
      auth: original.auth,
      models,
      // api 委托：把请求转回原 provider 的流式实现（保持 pi 内部的懒加载/重试行为）
      api: {
        stream: (model, context, options) => original.stream(model, context, options),
        streamSimple: (model, context, options) => original.streamSimple(model, context, options)
      }
    })
  }
}
