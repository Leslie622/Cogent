/**
 * 上下文压缩域的两个消费面 —— 压缩内核 = pi AgentSession 内置
 * （决定 26：reserve/keep 窗口、溢出恢复、摘要请求全在 prompt()
 * 生命周期内自管），Cogent 侧不再有压缩驱动。本文件只剩：
 *
 * - convertToLlmMessages：上下文明细估算的转录整形（session.ts estimateContext
 *   的输入）。pi 的真实请求组装走 sdk 的 convertToLlmWithBlockImages，两者
 *   同为"压缩条 → user 摘要消息"口径，估算与预算近似同源（明细本就是粗估）。
 *   compactionSummary 角色由 pi coding-agent 原生声明（core/messages.ts 的
 *   CustomAgentMessages 合并），本文件不再自行声明；
 * - piTriggerRatio：models.list 目录随发的触发占比（UI 指示器预警线）
 *   —— pi reserve 制的真值口径。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Message } from '@earendil-works/pi-ai'
import type { CompactionParamsOverride } from '../../protocol'

// ———— 转录整形（保留式投影） ————

/**
 * 压缩条投影前导语（dsh CHECKPOINT_PREAMBLE 同款措辞）：把摘要
 * 框定为「既定背景」而非「压缩事件」—— 模型直接续任务，不复述也不承认
 * 检查点。pi 官方前缀（"history before this point was compacted…"）会诱导
 * 模型把压缩本身当话题，dsh 措辞消除这层噪音。标签用 Cogent 一贯的
 * <summary>（dsh 是 <compacted-summary>，语义等价，不跟）。
 */
export const COMPACTION_SUMMARY_PREFIX = `This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<summary>
`
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`

/**
 * AgentMessage[] → LLM Message[]（估算口径）：[全转录 system 原序] + [末条
 * 压缩条 → user 摘要消息（前缀包裹）] + [末条压缩条之后的非 system 消息]。
 * 影子区（末条压缩条之前的历史对话）不计 —— pi 的会话树投影本身已丢弃
 * 影子区（buildContextEntries 只保留压缩条 + 保留区起的消息），此函数对
 * v1 旧转录（影子区尚在）与 pi 投影（已裁）给出同一口径。无压缩条时返回
 * 原引用直通（热路径零拷贝）。
 */
export function convertToLlmMessages(messages: AgentMessage[]): Message[] {
  let lastBarIndex = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'compactionSummary') lastBarIndex = i
  }
  if (lastBarIndex === -1) return messages as Message[]
  // 索引访问不随循环里的 role 比较窄化，显式收窄到压缩条成员（联合来自
  // pi coding-agent 的全局声明合并，此 as 是同源窄化非形状抽查）
  const bar = messages[lastBarIndex] as Extract<AgentMessage, { role: 'compactionSummary' }>
  // system 全局收集而非只取活区：状态消息可能落在影子区，随摘要丢弃会静默
  // 失权限语义；领头 system 的工具声明重放同理
  const result: Message[] = []
  for (const message of messages) {
    if (message.role === 'system') result.push(message)
  }
  result.push({
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_SUMMARY_PREFIX + bar.summary + COMPACTION_SUMMARY_SUFFIX }],
    timestamp: bar.timestamp
  })
  for (let i = lastBarIndex + 1; i < messages.length; i++) {
    if (messages[i].role !== 'system') result.push(messages[i] as Message)
  }
  return result
}

// ———— 触发线（pi reserve 制的口径镜像） ————

/** pi 压缩 reserve 缺省（settings-defaults.ts；与 SettingsManager 解析一致） */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384

/**
 * pi 真实触发线占比：`1 − reserve/ctx`，reserve 经窗口自适应
 * （adaptCompactionToWindow 同款：min(16384, ctx/4)）—— models.list 随目录
 * 下发（ModelSummary.compactionThresholdRatio），指示器预警线/变色带据此
 * 画**引擎真值**（画线偏离真值 = 用户看到"未到线就压了"）。窗口缺数据
 * （≤0）返回 NaN，下发处 Number.isFinite 守卫。
 */
export function piTriggerRatio(contextWindow: number): number {
  if (contextWindow <= 0) return Number.NaN
  const reserve = Math.min(PI_DEFAULT_RESERVE_TOKENS, Math.floor(contextWindow / 4))
  return (contextWindow - reserve) / contextWindow
}

/**
 * Model.compaction 附加字段（声明合并 —— 上游 Model 无此维度）：盘上兼容
 * 字段 —— pi 不读（触发线走 pi reserve 制 + 引擎自适应），引擎也不消费，
 * 仅为旧盘上 ModelDef 数据的类型兼容保留。
 */
declare module '@earendil-works/pi-ai' {
  // 类型参数表须与原接口一致（合并语法要求），TApi 未用属刻意
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Model<TApi extends Api> {
    compaction?: CompactionParamsOverride
  }
}

// ———— pi CompactionSettings 的小窗自适应 ————

/** pi 压缩参数形状（settings-manager getCompactionSettings 的返回面） */
export interface PiCompactionSettings {
  enabled: boolean
  reserveTokens: number
  keepRecentTokens: number
}

/**
 * 小窗下收敛 pi 的 reserve/keep：pi 默认固定 reserve 16384 / keep 20000，
 * 小窗（ctx ≤ keep 时被摘要区间为空）会「触发线早早响、压缩无可压缩收场」。
 * 收敛公式：keep = min(keep, 半窗)、reserve = min(reserve,
 * 四分之一窗) —— 标准窗（≥ 40K/64K）两个 min 都取原值，行为零变化；
 * 窗口未知（≤ 0，含目录缺数据）不碰 pi 解析结果。
 */
export function adaptCompactionToWindow(settings: PiCompactionSettings, contextWindow: number): PiCompactionSettings {
  if (contextWindow <= 0) return settings
  return {
    ...settings,
    keepRecentTokens: Math.min(settings.keepRecentTokens, Math.floor(contextWindow / 2)),
    reserveTokens: Math.min(settings.reserveTokens, Math.floor(contextWindow / 4))
  }
}
