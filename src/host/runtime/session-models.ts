/**
 * 模型目录投影：将 pi catalog 映射为协议层的 ModelSummary 列表。
 * 从 session.ts 拆出以隔离 pi-ai 模型元数据与压缩阈值计算。
 */
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import type { ModelSummary, ProviderCompatDef } from '../../protocol'
import { piTriggerRatio } from './compaction'

const COMPAT_KEYS: ReadonlyArray<keyof ProviderCompatDef> = [
  'thinkingFormat',
  'supportsReasoningEffort',
  'supportsDeveloperRole',
  'thinkingTokenBudgetField',
  'supportsThinkingTokenBudget',
  'maxTokensField',
  'forceAdaptiveThinking',
  'supportsTemperature'
]

function extractCompatSummary(raw: Model<Api>['compat']): ProviderCompatDef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of COMPAT_KEYS) {
    if (record[key] !== undefined) out[key] = record[key]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function projectModelSummaries(
  models: readonly Model<Api>[],
  isUserDefined: (provider: string, id: string) => boolean
): ModelSummary[] {
  return models.map((m) => {
    const ratio = piTriggerRatio(m.contextWindow)
    const compat = extractCompatSummary(m.compat)
    return {
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: m.reasoning,
      input: m.input,
      thinkingLevels: getSupportedThinkingLevels(m),
      ...(m.thinkingLevelMap !== undefined && { thinkingLevelMap: m.thinkingLevelMap }),
      ...(compat !== undefined && { compat }),
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      userDefined: isUserDefined(m.provider, m.id),
      ...(Number.isFinite(ratio) && { compactionThresholdRatio: ratio })
    }
  })
}
