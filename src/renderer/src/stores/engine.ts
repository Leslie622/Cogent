/**
 * 引擎资源状态：模型目录、provider key 配置、自定义 provider 定义、当前选中模型/推理力度。
 * 挂载时拉取一次 + 把落盘的自定义 provider 定义推给引擎（覆盖引擎重启后定义丢失的窗口）；
 * key/定义保存后经 refresh 同步（模型下拉随之解锁）。
 */
import { create } from 'zustand'
import type { CustomProviderDef, CustomProvidersPayload, ModelSummary, ProviderOverrideDef, ThinkingLevelWithOff } from '@/env.d'

/** 思考档位全序（off + 六档）：偏好回填的值域校验与"就近取整"共用 */
const THINKING_ORDER: readonly ThinkingLevelWithOff[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 常用内置 provider 的显示名册（模型下拉分组/设置页卡片共用）。
 * pi 目录有 40+ 家，全量名册维护不过来 —— 没收录的兜底显示原始 id。
 */
export const BUILTIN_PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  zai: 'Z.AI',
}

/** provider 显示名：自定义走 def.name；内置查名册，未收录兜底原 id */
export function providerDisplayName(providerId: string, providers: CustomProviderDef[]): string {
  if (providerId.startsWith('custom/')) {
    return providers.find((p) => p.id === providerId)?.name ?? providerId
  }
  return BUILTIN_PROVIDER_NAMES[providerId] ?? providerId
}

interface EngineState {
  /** pi 目录 + 自定义 provider 的全部模型（models.list） */
  models: ModelSummary[]
  /** providerId → 是否已配 key（credentials.list + listApiKeys 合并） */
  keyConfigured: Record<string, boolean>
  /** 自定义 provider 定义（设置页编辑的数据源） */
  customProviders: CustomProviderDef[]
  /** 内置 provider 的本地调整（baseUrl 覆盖 + 模型增删），providerId → 完整定义 */
  overrides: Record<string, ProviderOverrideDef>
  /** 当前选中模型 id（session 提交时随 agent.submit 下发） */
  activeModelId: string
  /** 选中模型的 provider（同名模型跨 provider 收录时 id 单键有歧义，双键才能
      区分"zai 的 glm-5.3"与"自定义网关的 glm-5.3"；null = 旧偏好回填无此字段，
      按 id 退化查找，用户点一次选择后即补全） */
  activeProviderId: string | null
  /** 推理力度（pi ThinkingLevel；随 agent.submit 下发） */
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 新会话默认权限（审批交互升级 D6：设置页「默认权限」开关两态，开 = auto /
   *  关/缺省 = ask；chat store createSession 在显式选择缺席时消费） */
  defaultPermissionMode: 'ask' | 'auto'
  loaded: boolean
  /** 引擎链路失败的原因（load 失败时；App 横幅呈现 + 重试入口）。null = 正常 */
  engineError: string | null
  load: () => Promise<void>
  refreshKeys: () => Promise<void>
  refreshModels: () => Promise<void>
  /** 全量保存自定义 provider 定义：落盘 → 引擎 sync → 重拉目录 */
  saveProviders: (providers: CustomProviderDef[], overrides: ProviderOverrideDef[]) => Promise<void>
  setActiveModel: (modelId: string, providerId?: string | null) => void
  setThinkingLevel: (level: EngineState['thinkingLevel']) => void
  /** 设置页「默认权限」开关：落盘 + 内存态（新会话物化缺省随动） */
  setDefaultPermissionMode: (mode: 'ask' | 'auto') => void
}

function toKeyMap(status: Array<{ providerId: string; keyConfigured: boolean }>): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const { providerId, keyConfigured } of status) {
    map[providerId] = keyConfigured
  }
  return map
}

function toOverrideMap(payload: CustomProvidersPayload): Record<string, ProviderOverrideDef> {
  const map: Record<string, ProviderOverrideDef> = {}
  for (const override of payload.overrides) {
    map[override.providerId] = override
  }
  return map
}

/**
 * 会话级偏好（选中模型/思考力度）的宿主侧持久化：落 ~/.cogent/settings.json
 * （main 写，计划 D2 单写者分工——壳配置归 main）。引擎重启/应用重启都从这里
 * 回填；无文件/损坏由 main 归一为默认值返回，这里不再包 catch —— 真实故障
 * （IPC 未注册等）应炸给 load → engineError 横幅（约定.md 1.2-1 吞错反模式）。
 */
interface AppSettings {
  activeModelId?: string
  activeProviderId?: string
  thinkingLevel?: string
  defaultPermissionMode?: 'ask' | 'auto'
}

/** 载入落盘偏好；thinkingLevel 做值域归一（未来版本的档位/手改文件按缺省处理，偏好可再生） */
async function loadSettings(): Promise<AppSettings> {
  const file = await window.cogent.getSettings()
  return {
    activeModelId: file.activeModelId,
    activeProviderId: file.activeProviderId,
    thinkingLevel: file.thinkingLevel,
    defaultPermissionMode: file.defaultPermissionMode
  }
}

function normalizeThinkingLevel(value: string | undefined): EngineState['thinkingLevel'] {
  if (value === undefined) return 'off'
  return (THINKING_ORDER as readonly string[]).includes(value)
    ? (value as EngineState['thinkingLevel'])
    : 'off'
}

export const useEngineStore = create<EngineState>((set, get) => ({
  models: [],
  keyConfigured: {},
  customProviders: [],
  overrides: {},
  activeModelId: '',
  activeProviderId: null,
  thinkingLevel: 'off',
  defaultPermissionMode: 'ask',
  loaded: false,
  engineError: null,

  // 失败落 engineError（App 横幅 + 重试），不再裸抛成 unhandled rejection
  load: async () => {
    try {
      const [modelsResult, keyStatus, customPayload, settings] = await Promise.all([
        window.cogent.engineRequest('models.list', {}),
        window.cogent.listApiKeys(),
        window.cogent.getCustomProviders(),
        loadSettings()
      ])
      const keys = toKeyMap(keyStatus)
      // 默认模型随 models.list 回带（协议 additive）：不再 renderer 侧复制
      // DEFAULT_MODEL 常量 —— 无机制保证一致，漂移后回填偏好指向不可用模型
      const defaultModel = modelsResult.defaultModel ?? {
        provider: null as string | null,
        id: modelsResult.models[0]?.id ?? ''
      }
      set({
        models: modelsResult.models,
        keyConfigured: keys,
        customProviders: customPayload.providers,
        overrides: toOverrideMap(customPayload),
        // 偏好回填：落盘的模型可能已不在目录（改名/删除）→ 校验一次再落
        activeModelId: settings.activeModelId ?? defaultModel.id,
        activeProviderId: settings.activeProviderId ?? defaultModel.provider,
        thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel),
        defaultPermissionMode: settings.defaultPermissionMode ?? 'ask',
        loaded: true,
        engineError: null
      })
      // 引擎（重）启动后定义清零：把宿主落盘的定义经唯一写路径重推
      // （setCustomProviders = 落盘 + 推引擎合一；providers.custom.sync 已退出
      // renderer 白名单，防"盘上不变、引擎内存态被直改"的分叉）。starting 期
      // 请求会在引擎 stdin 排队、握手后作答，不因"还没 running"失败
      if (customPayload.providers.length > 0 || customPayload.overrides.length > 0) {
        await window.cogent.setCustomProviders(customPayload.providers, customPayload.overrides)
        await get().refreshModels()
      }
    } catch (error) {
      set({ engineError: error instanceof Error ? error.message : String(error), loaded: false })
    }
  },

  refreshKeys: async () => {
    const keyStatus = await window.cogent.listApiKeys()
    set({ keyConfigured: toKeyMap(keyStatus) })
  },

  refreshModels: async () => {
    const { models } = await window.cogent.engineRequest('models.list', {})
    set({ models })
  },

  saveProviders: async (providers, overrides) => {
    await window.cogent.setCustomProviders(providers, overrides)
    set({ customProviders: providers, overrides: toOverrideMap({ providers, overrides }) })
    await get().refreshModels()
  },

  // 选中模型/思考力度的 setter 都同步落盘（fire-and-forget：写失败不回滚内存态，
  // 下次改动会重写；getSettings 读失败走默认——首启无文件是常态不是错误）。
  // 切模型时校验当前力度是否被新模型支持：不支持则 clamp 到最近可用档
  // （避免"滑杆显示 medium、实际下发 high"的静默降级，见 getSupportedThinkingLevels）。
  // providerId 成对落：思考档 clamp 的查靶同样按双键限定，否则同名模型会拿
  // 别家的 thinkingLevels 来 clamp
  setActiveModel: (activeModelId, activeProviderId) => {
    const state = get()
    const target = state.models.find(
      (m) => m.id === activeModelId && (activeProviderId == null || m.provider === activeProviderId)
    )
    const supported = target?.thinkingLevels
    const patch: Partial<EngineState> = { activeModelId, activeProviderId: activeProviderId ?? null }
    if (supported && supported.length > 0 && !supported.includes(state.thinkingLevel)) {
      patch.thinkingLevel = nearestThinkingLevel(state.thinkingLevel, supported)
    }
    set(patch)
    void window.cogent.saveSettings({
      activeModelId,
      ...(activeProviderId != null && { activeProviderId }),
      ...(patch.thinkingLevel !== undefined && { thinkingLevel: patch.thinkingLevel })
    })
  },
  setThinkingLevel: (thinkingLevel) => {
    set({ thinkingLevel })
    void window.cogent.saveSettings({ thinkingLevel })
  },
  setDefaultPermissionMode: (defaultPermissionMode) => {
    set({ defaultPermissionMode })
    void window.cogent.saveSettings({ defaultPermissionMode })
  }
}))

/**
 * 力度就近取整：目标档不被支持时，先向更高档找、再向低档找（宁多想不少想，
 * 与 pi clampThinkingLevel 的"就近可用"语义一致）。调用点保证 supported 非空，
 * 全序遍历必命中 —— 不可达出口直接 throw（兜底返回 'off' 会掩盖非法状态，约定 1.2-6）。
 */
function nearestThinkingLevel(level: ThinkingLevelWithOff, supported: ThinkingLevelWithOff[]): ThinkingLevelWithOff {
  if (supported.includes(level)) return level
  const from = THINKING_ORDER.indexOf(level)
  for (let d = 1; d < THINKING_ORDER.length; d++) {
    const higher = THINKING_ORDER.at(from + d)
    if (higher !== undefined && supported.includes(higher)) return higher
    const lower = THINKING_ORDER.at(from - d)
    if (lower !== undefined && supported.includes(lower)) return lower
  }
  throw new Error('unreachable: supported 档位为空或不含任何已知档位')
}

/**
 * 可用模型过滤：只保留 provider 已配 key 的（用户拍板：下拉不展示无 key 的，
 * 而非置灰）。顺序保持目录原序（内置在前、自定义在后）。
 */
export function usableModels(models: ModelSummary[], keyConfigured: Record<string, boolean>): ModelSummary[] {
  return models.filter((m) => keyConfigured[m.provider] === true)
}

/**
 * 活动模型查找（双键）：provider 在场时限定同 provider —— 同名模型跨 provider
 * 收录且两家都配了 key 时（zai 目录与自定义网关都有 glm-5.3），id 单键永远命中
 * 目录在前那份，自定义厂商"选不上"即此（2026-11-10）。provider 为 null（旧
 * 偏好回填）退化为 id 单键，用户下一次点选即补全双键。
 */
export function findActiveModel(
  models: ModelSummary[],
  keyConfigured: Record<string, boolean>,
  activeModelId: string,
  activeProviderId: string | null
): ModelSummary | undefined {
  const usable = usableModels(models, keyConfigured)
  if (activeProviderId !== null) {
    return usable.find((m) => m.id === activeModelId && m.provider === activeProviderId)
  }
  return usable.find((m) => m.id === activeModelId)
}
