/** 模型家族预设与思考档位映射纯函数回归。 */
import { describe, expect, it } from 'vitest'
import {
  buildClosedThinkingMap,
  DEFAULT_REASONING_MAP,
  formatThinkingSummary,
  matchModelPreset,
  resolveSupportedThinkingLevels
} from '@shared/model-presets'

describe('model-presets', () => {
  it('buildClosedThinkingMap 显式禁用未选非 off 档，支持禁关与自定义 wire', () => {
    const mandatory = buildClosedThinkingMap({ low: 'low', high: 'high' }, false)
    expect(mandatory).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: null
    })
    expect(resolveSupportedThinkingLevels(true, mandatory)).toEqual(['low', 'high'])

    const withWireOff = buildClosedThinkingMap({ off: 'none', low: 'low', xhigh: 'xhigh' }, true)
    expect(withWireOff.off).toBe('none')
    expect(withWireOff.minimal).toBeNull()
    expect(resolveSupportedThinkingLevels(true, withWireOff)).toEqual(['off', 'low', 'xhigh'])
  })

  it('DEFAULT_REASONING_MAP 禁用 minimal 避免常见端点 400', () => {
    expect(resolveSupportedThinkingLevels(true, DEFAULT_REASONING_MAP)).toEqual(['off', 'low', 'medium', 'high'])
  })

  it('matchModelPreset 命中主流模型家族与方言 compat', () => {
    const o3 = matchModelPreset('openai/o3-mini', 'openai-responses')
    expect(o3?.reasoning).toBe(true)
    expect(o3?.thinkingLevelMap?.off).toBeNull()
    expect(resolveSupportedThinkingLevels(true, o3?.thinkingLevelMap)).toEqual(['low', 'medium', 'high'])

    const gpt54 = matchModelPreset('gpt-5.4', 'openai-responses')
    expect(gpt54?.thinkingLevelMap?.off).toBe('none')
    expect(resolveSupportedThinkingLevels(true, gpt54?.thinkingLevelMap)).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh'
    ])

    const opus47 = matchModelPreset('claude-opus-4-7', 'anthropic-messages')
    expect(opus47?.compat?.forceAdaptiveThinking).toBe(true)
    expect(resolveSupportedThinkingLevels(true, opus47?.thinkingLevelMap)).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max'
    ])

    const ds = matchModelPreset('deepseek-v4-pro', 'openai-completions')
    expect(ds?.compat?.thinkingFormat).toBe('deepseek')
    expect(ds?.compat?.supportsDeveloperRole).toBe(false)
    expect(resolveSupportedThinkingLevels(true, ds?.thinkingLevelMap)).toEqual(['off', 'low', 'high', 'max'])

    expect(matchModelPreset('my-unknown-local-model')).toBeUndefined()
  })

  it('formatThinkingSummary 区分允许关闭与必思考模型', () => {
    expect(formatThinkingSummary(['off', 'low', 'high'])).toEqual({
      badge: '思考 · 2 档',
      tooltip: '支持档位：Off / Low / High'
    })
    expect(formatThinkingSummary(['low', 'medium', 'high'])).toEqual({
      badge: '思考 · 3 档 · 必思考',
      tooltip: '支持档位：Low / Medium / High'
    })
  })
})
