/** CustomProviderRegistry：thinkingLevelMap 闭合映射、off 禁用与 model 级 compat 覆盖。 */
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { CustomProviderRegistry } from '../../../src/host/runtime/custom-providers'

function setupRegistry() {
  const models = builtinModels()
  const runtime = {
    registerNativeProvider: vi.fn(),
    unregisterProvider: vi.fn()
  } as unknown as ModelRuntime
  const registry = new CustomProviderRegistry(models, runtime)
  registry.snapshotBuiltin()
  return { models, registry }
}

describe('CustomProviderRegistry thinkingLevelMap 与 compat', () => {
  it('thinkingLevelMap 支持 off: null 禁用关闭，且未列出的非 off 档自动闭合为 null', () => {
    const { models, registry } = setupRegistry()
    registry.sync([
      {
        id: 'custom/oai',
        name: 'OAI',
        baseUrl: 'https://example.com/v1',
        apiFormat: 'openai-responses',
        models: [],
        modelDefs: [
          {
            id: 'o3-custom',
            reasoning: true,
            thinkingLevelMap: { off: null, low: 'low', high: 'high' }
          },
          {
            id: 'gpt-5-2-custom',
            reasoning: true,
            thinkingLevelMap: { off: 'none', low: 'low', xhigh: 'xhigh' }
          }
        ]
      }
    ], [])

    const o3 = models.getModel('custom/oai', 'o3-custom')!
    expect(getSupportedThinkingLevels(o3)).toEqual(['low', 'high'])
    expect(clampThinkingLevel(o3, 'off')).toBe('low')
    expect(clampThinkingLevel(o3, 'minimal')).toBe('low')

    const gpt52 = models.getModel('custom/oai', 'gpt-5-2-custom')!
    expect(getSupportedThinkingLevels(gpt52)).toEqual(['off', 'low', 'xhigh'])
    expect(gpt52.thinkingLevelMap?.off).toBe('none')
    expect(gpt52.thinkingLevelMap?.minimal).toBeNull()
  })

  it('旧 thinkingLevels 字段保持向后兼容，模型级 compat 覆盖供应商级且按方言过滤', () => {
    const { models, registry } = setupRegistry()
    registry.sync([
      {
        id: 'custom/gw',
        name: 'Gateway',
        baseUrl: 'https://gw.example/v1',
        apiFormat: 'openai-completions',
        compat: { thinkingFormat: 'openai', maxTokensField: 'max_completion_tokens', supportsDeveloperRole: true },
        models: [],
        modelDefs: [
          {
            id: 'legacy-reasoner',
            reasoning: true,
            thinkingLevels: ['low', 'high'],
            compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens', forceAdaptiveThinking: true }
          }
        ]
      },
      {
        id: 'custom/ant',
        name: 'Ant',
        baseUrl: 'https://ant.example',
        apiFormat: 'anthropic-messages',
        models: [],
        modelDefs: [
          {
            id: 'claude-4-6',
            reasoning: true,
            thinkingLevelMap: { low: 'low', max: 'max' },
            compat: { forceAdaptiveThinking: true, thinkingFormat: 'deepseek' }
          }
        ]
      }
    ], [])

    const legacy = models.getModel('custom/gw', 'legacy-reasoner')!
    expect(getSupportedThinkingLevels(legacy)).toEqual(['off', 'low', 'high'])
    expect(legacy.compat).toEqual({
      thinkingFormat: 'deepseek',
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: true
    })

    const ant = models.getModel('custom/ant', 'claude-4-6')!
    expect(ant.compat).toEqual({ forceAdaptiveThinking: true })
  })
})
