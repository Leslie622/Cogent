/** engine store：启动恢复与刷新模型列表时按当前模型能力重新 clamp 思考力度。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEngineStore } from '@/stores/engine'
import type { ModelSummary } from '@/env.d'

const initialEngine = { ...useEngineStore.getState() }
const previousCogent = window.cogent

const reasonerStrict: ModelSummary = {
  id: 'o3-custom',
  name: 'o3',
  provider: 'custom/oai',
  reasoning: true,
  thinkingLevels: ['low', 'medium', 'high'],
  contextWindow: 200_000,
  maxTokens: 100_000
}

const reasonerWide: ModelSummary = {
  ...reasonerStrict,
  thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'max']
}

beforeEach(() => {
  useEngineStore.setState(initialEngine, true)
})

afterEach(() => {
  useEngineStore.setState(initialEngine, true)
  window.cogent = previousCogent
})

describe('engine store 思考档位自动收窄', () => {
  it('load() 时若活动模型不支持保存的 off 档，自动 clamp 到最近可用档', async () => {
    window.cogent = {
      ...previousCogent,
      engineRequest: vi.fn((method: string) => {
        if (method === 'models.list') return Promise.resolve({ models: [reasonerStrict] })
        if (method === 'session.defaults.get') return Promise.resolve({ defaultPermissionMode: 'ask' })
        return Promise.resolve({})
      }) as typeof window.cogent.engineRequest,
      listApiKeys: vi.fn().mockResolvedValue([{ providerId: 'custom/oai', keyConfigured: true }]),
      getCustomProviders: vi.fn().mockResolvedValue({ providers: [], overrides: [] }),
      getSettings: vi.fn().mockResolvedValue({
        activeModelId: 'o3-custom',
        activeProviderId: 'custom/oai',
        thinkingLevel: 'off'
      })
    }

    await useEngineStore.getState().load()
    expect(useEngineStore.getState().thinkingLevel).toBe('low')
  })

  it('refreshModels() 后当前模型收窄了档位，同步 clamp 并回写 settings', async () => {
    const saveSettings = vi.fn().mockResolvedValue({ ok: true })
    window.cogent = {
      ...previousCogent,
      engineRequest: vi.fn().mockResolvedValue({ models: [reasonerStrict] }) as typeof window.cogent.engineRequest,
      saveSettings
    }
    useEngineStore.setState({
      models: [reasonerWide],
      keyConfigured: { 'custom/oai': true },
      activeModelId: 'o3-custom',
      activeProviderId: 'custom/oai',
      thinkingLevel: 'max'
    })

    await useEngineStore.getState().refreshModels()
    expect(useEngineStore.getState().thinkingLevel).toBe('high')
    expect(saveSettings).toHaveBeenCalledWith({ thinkingLevel: 'high' })
  })

  it('refreshKeys() 与 setThinkingLevel() 对禁 Off 模型同样执行 clamp', async () => {
    const saveSettings = vi.fn().mockResolvedValue({ ok: true })
    window.cogent = {
      ...previousCogent,
      listApiKeys: vi.fn().mockResolvedValue([{ providerId: 'custom/oai', keyConfigured: true }]),
      saveSettings
    }
    useEngineStore.setState({
      models: [reasonerStrict],
      keyConfigured: {},
      activeModelId: 'o3-custom',
      activeProviderId: 'custom/oai',
      thinkingLevel: 'off'
    })

    await useEngineStore.getState().refreshKeys()
    expect(useEngineStore.getState().thinkingLevel).toBe('low')

    useEngineStore.getState().setThinkingLevel('off')
    expect(useEngineStore.getState().thinkingLevel).toBe('low')
  })
})
