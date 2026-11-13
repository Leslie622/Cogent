/**
 * 旧会话转录导入（阶段 1.2）—— 手搓持久化时代的 StoredSession.transcript
 *（~/.cogent/sessions/<id>.json，pi AgentMessage[]）逐条转写进 pi 会话树。
 *
 * 语义对齐的关键：pi 树里 compaction entry 的 firstKeptEntryId 指保留区
 * 起点、其前条目不进上下文 —— appendCompaction(summary, null, …) 的 null
 * 落成"保留区从压缩条自身开始"，恰是旧 compactionSummary 消息的语义
 *（它之前的消息已被摘要替代）；其后的活区消息继续 append 即可。
 * 摘要请求自身的账（summaryUsage，协议 MessageUsage 形状）不迁——与 pi 的
 * Usage 形状不同构，历史账目不值得转换（投影端 compaction 元数据缺省降级）。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionManager as PiSessionManager } from '@earendil-works/pi-coding-agent'

/** 逐条转写；返回导入条数（含压缩条）。compactionSummary → compaction entry，
 *  其余 → message entry；手搓时代不存在的角色（branchSummary 等，类型联合里有、
 *  旧盘上不会有）按边界校验原则跳过并计数进 skipped——不静默吞（返回值可诊断） */
export function importLegacyTranscript(
  piSm: PiSessionManager,
  transcript: AgentMessage[]
): { imported: number; skipped: number } {
  let imported = 0
  let skipped = 0
  for (const message of transcript) {
    if (message.role === 'compactionSummary') {
      piSm.appendCompaction(message.summary, null, message.tokensBefore, undefined, true)
      imported++
    } else if (message.role === 'system' || message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') {
      piSm.appendMessage(message)
      imported++
    } else {
      skipped++
    }
  }
  return { imported, skipped }
}
