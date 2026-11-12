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
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import type { Api, Model, MutableModels, Provider, ThinkingBudgets } from '@earendil-works/pi-ai'
import type { CustomProviderDef, ModelDef, ProviderCompatDef, ProviderOverrideDef } from '../../protocol'

/**
 * Model 对象上的思考预算通道（完备化 R7，声明合并 —— compaction.ts 的
 * compaction 字段同款手法）：buildModel 从 ModelDef.thinkingBudgets 透传，
 * pi 自身不读；session 侧在 ensureAgent/模型切换时同步到 Agent
 * .thinkingBudgets（pi 的预算消费在请求选项层，不在 Model 层）。
 */
declare module '@earendil-works/pi-ai' {
  // 类型参数表须与原接口一致（合并语法要求），TApi 未用属刻意
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Model<TApi extends Api> {
    thinkingBudgets?: ThinkingBudgets
  }
}

/** 自定义模型的兜底参数：无成本的通用 OpenAI-compatible 档位（用户端点上实际可用为准） */
const CUSTOM_MODEL_CONTEXT_WINDOW = 128_000
const CUSTOM_MODEL_MAX_TOKENS = 32_768

/** 方言 → pi 请求实现（懒加载工厂，调 factory 才加载对应 SDK）。
    openai 系两方言走官方 OpenAI SDK：只在 baseUrl 后拼 /chat/completions 或
    /responses（baseUrl 需带 /v1 段）；anthropic 走官方 Anthropic SDK：自拼
    /v1/messages（baseUrl 填根地址）。有网关按路由放行模型权限，三方言即
    三套端点路径 —— 2026-11-10 实测某 New API 令牌仅 /v1/responses 可用而补齐 */
const API_BY_FORMAT = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi
} as const

/** ModelDef → pi Model：merge 语义 —— catalogBase（目录同 id 条目）在时以它为基底，
    用户 def 显式设置的字段才覆盖；全新 id 无基底则兜底（context/maxTokens/input/reasoning）。
    cost 一律不取自 def（协议 ModelDef 无此字段，用户不可配价）：有目录基底 = 继承
    目录定价（同 id 用户条目本质是"编辑目录行"，丢定价等于静默抹掉成本统计），
    全新自定义模型 = 全 0（自定义端点计费对外不可知，UI 不显示价格即可）。
    thinkingLevels → thinkingLevelMap：选中的等级原值透传（openai 方言直落
    reasoning_effort），未选中置 null（显式不支持）；不选 = 继承基底映射或不下发跟端点默认 */
function buildModel(
  def: ModelDef,
  api: Api,
  providerId: string,
  baseUrl: string,
  catalogBase?: Model<Api>,
  compat?: ProviderCompatDef
): Model<Api> {
  const ALL_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  return {
    id: def.id,
    name: def.name ?? catalogBase?.name ?? def.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: def.reasoning ?? catalogBase?.reasoning ?? false,
    input: def.input ?? catalogBase?.input ?? ['text'],
    ...(def.thinkingLevels !== undefined && def.reasoning === true &&{
      thinkingLevelMap: Object.fromEntries(
        ALL_LEVELS.map((level) => [level, def.thinkingLevels?.includes(level) ? level : null])
      )
    }),
    // def 未配思考档且基底有映射（pi 目录生成）→ 继承，"编辑目录行"不动未配置的维度
    ...(def.thinkingLevels === undefined && catalogBase?.thinkingLevelMap !== undefined && {
      thinkingLevelMap: catalogBase.thinkingLevelMap
    }),
    cost: catalogBase?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: def.contextWindow ?? catalogBase?.contextWindow ?? CUSTOM_MODEL_CONTEXT_WINDOW,
    maxTokens: def.maxTokens ?? catalogBase?.maxTokens ?? CUSTOM_MODEL_MAX_TOKENS,
    // 压缩参数覆盖（完备化 R1）：Cogent 附加字段走 compaction.ts 的声明合并通道，
    // pi 不读；目录基底无此维度（pi 目录不标压缩参数），用户没配 = 引擎默认公式
    ...(def.compaction !== undefined && { compaction: def.compaction }),
    // 思考预算（完备化 R7）：同样走声明合并附加字段，session 侧同步到 Agent
    ...(def.thinkingBudgets !== undefined && { thinkingBudgets: def.thinkingBudgets }),
    // 端点兼容覆盖（完备化 R7）：provider 级 compat 下沉到每个模型（pi 上游
    // provider-composer 同位语义）。字段同名直通（ProviderCompatDef 是
    // OpenAICompletionsCompat 的子集）；anthropic 方言不经此面 —— 调用处不传
    ...(compat !== undefined && { compat })
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
   * 模型是否用户添加（自定义供应商注册，或内置 provider 的目录外新增）。
   * 判定基准 = originals 快照里的纯 pi 目录（覆盖重建后的 models 集合混入了
   * 用户条目，不可作基准）。UI 据此区分"默认模型 vs 自定义模型"：默认模型
   * 编辑时锁 id（目录身份不可改），显示一律用 id（2026-11-10 定调）。
   */
  isUserDefined(providerId: string, modelId: string): boolean {
    if (this.customIds.has(providerId)) return true
    const original = this.originals.get(providerId)
    // 未知 provider（快照前的非常规注册）按目录原生对待：宁可少锁不误锁
    if (!original) return false
    return !original.getModels().some((m) => m.id === modelId)
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
   * defs → pi Provider。方言由 def.apiFormat 决定（三档，工厂见 API_BY_FORMAT）：
   * openai-completions 是中转站/网关/Ollama 的通用方言；openai-responses 对接
   * Responses 端点；anthropic-messages 对接 Claude 原生端点。
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
    // compat 仅 openai 系方言消费（anthropic-messages 走官方 budget_tokens，
    // 形状不同不经此面）—— 门在此处，buildModel 只管透传
    const compat = apiFormat === 'anthropic-messages' ? undefined : def.compat
    for (const modelDef of advanced) {
      if (disabled.has(modelDef.id) || seen.has(modelDef.id)) continue
      seen.add(modelDef.id)
      models.push(buildModel(modelDef, apiFormat, def.id, def.baseUrl, undefined, compat))
    }
    for (const modelId of def.models) {
      if (disabled.has(modelId) || seen.has(modelId)) continue
      seen.add(modelId)
      models.push(buildModel({ id: modelId }, apiFormat, def.id, def.baseUrl, undefined, compat))
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
      api: API_BY_FORMAT[apiFormat]()
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
    // 目录同 id 条目作 merge 基底：用户条目 = "编辑目录行"而非凭空新模型，
    // 未配置的维度（定价/思考映射/命名）继承目录，见 buildModel 注释
    const catalogById = new Map(original.getModels().map((m) => [m.id, m]))
    // added 也要滤 disabledModels（与目录行同语义）：此前只滤目录行，用户在内置
    // provider 上新增的模型开关关了照样注册（2026-11-10 补）。被禁的覆盖行
    // （同 id 编辑目录）两层都滤掉 = 不注册，def 留在 override.models 可再打开
    const added = (override.models ?? [])
      .filter((m) => !disabled.has(m.id))
      .map((m) => buildModel(m, api, original.id, baseUrl, catalogById.get(m.id)))
    const addedIds = new Set((override.models ?? []).map((m) => m.id))
    const models: Model<Api>[] = [
      // 目录在前（保 pi 快照原序），用户新增排后；同 id 目录项被新增覆盖（不重复注册）。
      // 目录模型浅拷贝重写 baseUrl（目录模型是纯数据对象）：baseUrl 覆盖要对整个
      // provider 生效 —— 此前只有 override.models 新增条目走新端点，目录透传模型
      // 仍打官方端点（流式又委托原实例，覆盖形同虚设，直到 401/连接错误才暴露）
      ...original
        .getModels()
        .filter((m) => !disabled.has(m.id) && !addedIds.has(m.id))
        .map((m) => ({ ...m, baseUrl })),
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
