/**
 * 引擎资源状态：模型目录、provider key 配置、自定义 provider 定义、当前选中模型/推理力度。
 * 挂载时拉取一次 + 把落盘的自定义 provider 定义推给引擎（覆盖引擎重启后定义丢失的窗口）；
 * key/定义保存后经 refresh 同步（模型下拉随之解锁）。
 */
import { create } from 'zustand'
import type { CustomProviderDef, CustomProvidersPayload, ModelSummary, ProviderOverrideDef } from '@/env.d'

/** 默认选中模型（与引擎侧 SessionManager 的 DEFAULT_MODEL 一致） */
const DEFAULT_MODEL = 'claude-sonnet-4-5'

interface EngineState {
  /** pi 目录 + 自定义 provider 的全部模型（models.list） */
  models: ModelSummary[]
  /** providerId → 是否已配 key（credentials.list + listApiKeys 合并） */
  keyConfigured: Record<string, boolean>
  /** 自定义 provider 定义（设置页编辑的数据源） */
  customProviders: CustomProviderDef[]
  /** 内置 provider 的 baseUrl 覆盖（providerId → baseUrl） */
  overrides: Record<string, string>
  /** 当前选中模型 id（session 提交时随 agent.submit 下发） */
  activeModelId: string
  /** 推理力度（pi ThinkingLevel；随 agent.submit 下发） */
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  loaded: boolean
  load: () => Promise<void>
  refreshKeys: () => Promise<void>
  refreshModels: () => Promise<void>
  /** 全量保存自定义 provider 定义：落盘 → 引擎 sync → 重拉目录 */
  saveProviders: (providers: CustomProviderDef[], overrides: ProviderOverrideDef[]) => Promise<void>
  setActiveModel: (modelId: string) => void
  setThinkingLevel: (level: EngineState['thinkingLevel']) => void
}

function toKeyMap(status: Array<{ providerId: string; keyConfigured: boolean }>): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const { providerId, keyConfigured } of status) {
    map[providerId] = keyConfigured
  }
  return map
}

function toOverrideMap(payload: CustomProvidersPayload): Record<string, string> {
  const map: Record<string, string> = {}
  for (const { providerId, baseUrl } of payload.overrides) {
    map[providerId] = baseUrl
  }
  return map
}

export const useEngineStore = create<EngineState>((set, get) => ({
  models: [],
  keyConfigured: {},
  customProviders: [],
  overrides: {},
  activeModelId: DEFAULT_MODEL,
  thinkingLevel: 'off' as EngineState['thinkingLevel'],
  loaded: false,

  load: async () => {
    const [modelsResult, keyStatus, customPayload] = await Promise.all([
      window.cogent.engineRequest('models.list', {}),
      window.cogent.listApiKeys(),
      window.cogent.getCustomProviders()
    ])
    set({
      models: modelsResult.models,
      keyConfigured: toKeyMap(keyStatus),
      customProviders: customPayload.providers,
      overrides: toOverrideMap(customPayload),
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

  setActiveModel: (activeModelId) => set({ activeModelId }),
  setThinkingLevel: (thinkingLevel) => set({ thinkingLevel })
}))

/**
 * 可用模型过滤：只保留 provider 已配 key 的（用户拍板：下拉不展示无 key 的，
 * 而非置灰）。顺序保持目录原序（内置在前、自定义在后）。
 */
export function usableModels(models: ModelSummary[], keyConfigured: Record<string, boolean>): ModelSummary[] {
  return models.filter((m) => keyConfigured[m.provider] === true)
}
