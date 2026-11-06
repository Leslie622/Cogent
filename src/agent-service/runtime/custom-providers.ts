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
 * deleteProvider 移除；内置 provider 的 baseUrl 覆盖（ProviderOverrideDef）同样
 * 全量替换——撤掉覆盖 = 重新 setProvider 原实例。
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { Model, MutableModels, Provider } from '@earendil-works/pi-ai'
import type { CustomProviderDef, ProviderOverrideDef } from '../../protocol'

/** 自定义模型的兜底参数：无成本的通用 OpenAI-compatible 档位（用户端点上实际可用为准） */
const CUSTOM_MODEL_CONTEXT_WINDOW = 128_000
const CUSTOM_MODEL_MAX_TOKENS = 32_768

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
   */
  sync(defs: CustomProviderDef[], overrides: ProviderOverrideDef[]): number {
    // 自定义 provider：id 带 custom/ 前缀（与内置 id 空间隔离）
    for (const def of defs) {
      this.models.setProvider(this.buildCustomProvider(def))
      this.customIds.add(def.id)
    }
    for (const existingId of this.customIds) {
      if (!defs.some((def) => def.id === existingId)) {
        this.models.deleteProvider(existingId)
        this.customIds.delete(existingId)
      }
    }

    // 内置 provider 的 baseUrl 覆盖：同 id 新 provider，流式/auth 委托原实例。
    // 不用对象展开 —— provider 接口的方法要绑定原实例的闭包状态，浅拷贝会丢行为。
    for (const override of overrides) {
      const original = this.originals.get(override.providerId)
      if (!original) continue
      this.models.setProvider(this.buildOverrideProvider(original, override.baseUrl))
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

  /** defs → pi Provider（OpenAI-compatible 方言；auth 从存储凭据取 key） */
  private buildCustomProvider(def: CustomProviderDef): Provider {
    return createProvider({
      id: def.id,
      name: def.name,
      baseUrl: def.baseUrl,
      // 存储凭据（credentials.set('custom/x', key)）经 resolve 到达请求层；
      // 未配 key 返回 undefined = provider 未配置（models.getAuth 判定），流式时报错。
      // pi 的 ApiKeyAuth.resolve 契约是返回 Promise（auth/types.d.ts:189），故用 async 形式
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
      models: def.models.map((modelId): Model<'openai-completions'> => ({
        id: modelId,
        name: modelId,
        api: 'openai-completions',
        provider: def.id,
        baseUrl: def.baseUrl,
        // reasoning=false：中转站端点的思考参数兼容性不可知，pi 会按 thinkingLevel
        // 附带 reasoning_effort 等参数，不支持的端点可能提前截断或报错。
        // 需要思考能力的模型（如 o 系列）后续可加"高级"配置项。
        reasoning: false,
        input: ['text'],
        // cost 全 0：自定义端点的计费对外不可知，UI 不显示价格即可
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CUSTOM_MODEL_CONTEXT_WINDOW,
        maxTokens: CUSTOM_MODEL_MAX_TOKENS
      })),
      // 中转站/网关/Ollama 的通用方言；compat 按 baseUrl 自动探测（pi-ai README）
      api: openAICompletionsApi()
    })
  }

  /** 内置 provider 的 baseUrl 覆盖版：getModels 沿用原清单，流式/auth 委托原实例 */
  private buildOverrideProvider(original: Provider, baseUrl: string): Provider {
    return createProvider({
      id: original.id,
      name: original.name,
      baseUrl,
      auth: original.auth,
      models: original.getModels(),
      // api 委托：把请求转回原 provider 的流式实现（保持 pi 内部的懒加载/重试行为）
      api: {
        stream: (model, context, options) => original.stream(model, context, options),
        streamSimple: (model, context, options) => original.streamSimple(model, context, options)
      }
    })
  }
}
