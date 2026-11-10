/**
 * 引擎资源状态：模型目录、provider key 配置、自定义 provider 定义、当前选中模型/推理力度。
 * 挂载时拉取一次 + 把落盘的自定义 provider 定义推给引擎（覆盖引擎重启后定义丢失的窗口）；
 * key/定义保存后经 refresh 同步（模型下拉随之解锁）。
 */
import { create } from 'zustand'
import type { CustomProviderDef, CustomProvidersPayload, ModelSummary, ProviderOverrideDef, ThinkingLevelWithOff } from '@/env.d'

/** 默认选中模型（与引擎侧 SessionManager 的 DEFAULT_MODEL 一致） */
const DEFAULT_MODEL = 'claude-sonnet-4-5'

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
  loaded: boolean
  load: () => Promise<void>
  refreshKeys: () => Promise<void>
  refreshModels: () => Promise<void>
  /** 全量保存自定义 provider 定义：落盘 → 引擎 sync → 重拉目录 */
  saveProviders: (providers: CustomProviderDef[], overrides: ProviderOverrideDef[]) => Promise<void>
  setActiveModel: (modelId: string, providerId?: string | null) => void
  setThinkingLevel: (level: EngineState['thinkingLevel']) => void
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
 * 回填；字段只增，读失败/文件缺失走默认值（首次启动常态，不报错）。
 */
interface AppSettings {
  activeModelId?: string
  activeProviderId?: string
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/** 载入落盘偏好（main 读 settings.json；无文件/损坏返回 {} 走默认） */
async function loadSettings(): Promise<AppSettings> {
  try {
    return await window.cogent.getSettings()
  } catch {
    return {}
  }
}

export const useEngineStore = create<EngineState>((set, get) => ({
  models: [],
  keyConfigured: {},
  customProviders: [],
  overrides: {},
  activeModelId: DEFAULT_MODEL,
  activeProviderId: null,
  thinkingLevel: 'off',
  loaded: false,

  load: async () => {
    const [modelsResult, keyStatus, customPayload, settings] = await Promise.all([
      window.cogent.engineRequest('models.list', {}),
      window.cogent.listApiKeys(),
      window.cogent.getCustomProviders(),
      loadSettings()
    ])
    const keys = toKeyMap(keyStatus)
    set({
      models: modelsResult.models,
      keyConfigured: keys,
      customProviders: customPayload.providers,
      overrides: toOverrideMap(customPayload),
      // 偏好回填：落盘的模型可能已不在目录（改名/删除）→ 校验一次再落
      activeModelId: settings.activeModelId ?? DEFAULT_MODEL,
      activeProviderId: settings.activeProviderId ?? null,
      thinkingLevel: settings.thinkingLevel ?? 'off',
      loaded: true
    })
    // 引擎（重）启动后定义清零：把宿主落盘的定义推回去（引擎 running 才有效；失败不阻塞首屏）
    try {
      await window.cogent.engineRequest('providers.custom.sync', {
        providers: customPayload.providers,
        overrides: customPayload.overrides
      })
      await get().refreshModels()
    } catch {
      // 引擎未就绪（启动中/失败）：定义已落盘，下次 load 再推
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
  }
}))

/**
 * 力度就近取整：目标档不被支持时，先向更高档找、再向低档找（宁多想不少想，
 * 与 pi clampThinkingLevel 的"就近可用"语义一致）。
 */
function nearestThinkingLevel(level: ThinkingLevelWithOff, supported: ThinkingLevelWithOff[]): ThinkingLevelWithOff {
  if (supported.includes(level)) return level
  const ORDER: ThinkingLevelWithOff[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const from = ORDER.indexOf(level)
  for (let d = 1; d < ORDER.length; d++) {
    const higher = ORDER.at(from + d)
    if (higher !== undefined && supported.includes(higher)) return higher
    const lower = ORDER.at(from - d)
    if (lower !== undefined && supported.includes(lower)) return lower
  }
  return 'off'
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
