/**
 * 模型目录投影：将 pi catalog 映射为协议层的 ModelSummary 列表。
 * 从 session.ts 拆出以隔离 pi-ai 模型元数据与压缩阈值计算。
 */
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import type { ModelSummary } from '../../protocol'
import { piTriggerRatio } from './compaction'

export function projectModelSummaries(
  models: readonly Model<Api>[],
  isUserDefined: (provider: string, id: string) => boolean
): ModelSummary[] {
  return models.map((m) => {
    const ratio = piTriggerRatio(m.contextWindow)
    return {
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: m.reasoning,
      input: m.input,
      thinkingLevels: getSupportedThinkingLevels(m),
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      userDefined: isUserDefined(m.provider, m.id),
      ...(Number.isFinite(ratio) && { compactionThresholdRatio: ratio })
    }
  })
}
