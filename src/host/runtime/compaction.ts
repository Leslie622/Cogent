/**
 * 上下文压缩域的残留两面（阶段 1.2a 瘦身后）—— 手搓压缩内核
 * （L1 裁剪 / 切点算法 / 摘要提示词 / 原位插入）已整体让位 pi 内置压缩
 * （全局架构 D6：pi 会话树靠 message_end 追加，原位 splice 会分叉；pi 的
 * reserve/keep 窗口与溢出恢复覆盖全部触发场景）。本文件只剩两个消费面：
 *
 * - convertToLlmMessages：上下文明细估算的转录整形（session.ts estimateContext
 *   的输入）。pi 的真实请求组装走 sdk 的 convertToLlmWithBlockImages，两者
 *   同为"压缩条 → user 摘要消息"口径，估算与预算近似同源（明细本就是粗估）。
 *   compactionSummary 角色由 pi coding-agent 原生声明（core/messages.ts 的
 *   CustomAgentMessages 合并），本文件不再自行声明；
 * - compactionThreshold 族：models.list 目录随发的有效阈值（UI 指示器预警线，
 *   完备化 R1 的 dsh 同构公式）。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Message } from '@earendil-works/pi-ai'
import type { CompactionParamsOverride } from '../../protocol'

// ———— 转录整形（D9 保留式投影） ————

/**
 * 压缩条投影前导语（dsh CHECKPOINT_PREAMBLE 同款措辞，完备化 R4）：把摘要
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

// ———— 触发阈值（完备化 R1：dsh 同构公式 + 特小窗阈值兜底 + 按模型覆盖） ————

/** 占比触发线（缺省；dsh 0.8 / Codex 90% 封顶同量级，pi 靠 reserve 兜） */
export const COMPACTION_THRESHOLD = 0.9
/** 输出预算余量下限（token）：小窗下占比线会让输出预算饿死，换余量线 */
export const ROOM_FLOOR_TOKENS = 8_192
/** 特小窗兜底：占比线与余量线都低于半窗时，退到半窗（0 = 每回合必触发） */
const SMALL_WINDOW_THRESHOLD_FLOOR = 0.5

/**
 * Model.compaction 附加字段（完备化 R1，声明合并 —— 上游 Model 无此维度）：
 * 用户在 ModelDef 上按模型覆盖触发参数；pi 不读它（pi 用自己的
 * CompactionSettings），Cogent 目录下发预警线时消费。
 */
declare module '@earendil-works/pi-ai' {
  // 类型参数表须与原接口一致（合并语法要求），TApi 未用属刻意
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Model<TApi extends Api> {
    compaction?: CompactionParamsOverride
  }
}

/**
 * 有效压缩触发阈值：max(半窗兜底, min(占比线, 余量线))。
 * ctx ≤ 0（目录缺数据的怪模型）→ Infinity（永不触发，渲染端回落 0.9）。
 */
export function compactionThreshold(contextWindow: number, override?: CompactionParamsOverride): number {
  if (contextWindow <= 0) return Number.POSITIVE_INFINITY
  const ratio = override?.thresholdRatio ?? COMPACTION_THRESHOLD
  const floor = override?.roomFloorTokens ?? ROOM_FLOOR_TOKENS
  const byRatio = contextWindow * ratio
  const byRoom = contextWindow - floor
  const ceiling = Math.min(byRatio, byRoom)
  return Math.max(contextWindow * SMALL_WINDOW_THRESHOLD_FLOOR, ceiling)
}
