/**
 * chat store 的纯函数层（2026-11-17 会话状态重构 P2 自 chat.ts 拆出）：
 * 段化消息 → 消息流元素的展平、run 终态整段替换与并回手术。全部无副作用，
 * 单测直测（flatten.test.ts）；事件层（events.ts）与历史加载（store.ts
 * selectSession）共用。
 */
import type { ChatMessage } from '@/env.d'
import type { ApprovalItem, MessageItem, PrunedItem } from './types'

/**
 * 段化消息 → 消息流元素展平（终态替换与历史加载共用）：
 * 每段先落它的工具卡（toolCalls 按序），再落消息本体；纯工具段（无正文无思考）
 * 不落消息本体 —— 只留卡，避免空消息占行。
 * 2026-11-12 导出：单测直测（同上）。
 */
export function flattenSegments(segments: ChatMessage[]): MessageItem[] {
  const items: MessageItem[] = []
  for (const segment of segments) {
    for (const call of segment.toolCalls ?? []) {
      items.push({
        id: call.callId,
        type: 'tool',
        name: call.name,
        toolKind: call.kind,
        summary: call.summary,
        status: call.status,
        resultSummary: call.resultSummary,
        diff: call.diff,
        fileRefs: call.fileRefs,
        startedAt: call.startedAt,
        endedAt: call.endedAt
      })
    }
    if (segment.content !== '' || segment.thinking !== undefined || (segment.attachments?.length ?? 0) > 0 || (segment.directories?.length ?? 0) > 0) {
      items.push({ ...segment, toolCalls: undefined })
    }
  }
  return items
}

/**
 * 终态替换并回：审批痕迹行锚回各自工具卡之前（run.completed 内联逻辑提出，
 * 2026-11-12，行为不变 —— 单测直测）。kept = 替换区里要保留的痕迹行；
 * 新事件按 callId 精确关联，旧事件沿用名称与摘要锚位；配不上时退尾部保留。
 */
export function flatWithApprovals(flat: MessageItem[], kept: ApprovalItem[]): MessageItem[] {
  if (kept.length === 0) return flat
  const anchored = [...flat]
  for (const trace of kept) {
    const at = anchored.findIndex(
      (item) => item.type === 'tool' && (trace.callId !== undefined
        ? item.id === trace.callId
        : item.name === trace.toolName && item.summary === trace.summary)
    )
    anchored.splice(at >= 0 ? at : anchored.length, 0, trace)
  }
  return anchored
}

/** 并回行的时间序键：工具卡用执行终点（endedAt ?? startedAt），审批痕迹行无
 *  时间戳（undefined = 比较跳过、位置退化），其余用 timestamp */
function itemTime(item: MessageItem): number | undefined {
  if (item.type === 'tool') return item.endedAt ?? item.startedAt
  if (item.type === 'approval') return undefined
  return item.timestamp
}

/**
 * 终态替换并回：压缩条/裁剪副行按时间序并回替换区（D9 —— 压缩发生在 run
 * 边界/轮间，completed/pruned 事件插进替换区，run.completed 整段替换不得吞掉；
 * run.completed 内联逻辑提出，2026-11-12，行为不变 —— 单测直测）。
 */
export function flatWithCompaction(flat: MessageItem[], kept: Array<ChatMessage | PrunedItem>): MessageItem[] {
  if (kept.length === 0) return flat
  const merged = [...flat]
  for (const extra of kept) {
    let at = -1
    for (let i = 0; i < merged.length; i++) {
      const t = itemTime(merged[i])
      if (t !== undefined && t > extra.timestamp) {
        at = i
        break
      }
    }
    merged.splice(at >= 0 ? at : merged.length, 0, extra)
  }
  return merged
}

/**
 * run 终态整段替换（run.completed / run.failed(messages) 共用）：
 * 定位本次 run 的边界（列表里最后一条用户消息），其后的流式占位/封段/工具卡
 * 全部换成引擎分段终态 —— 审批痕迹行锚回各自工具卡之前（用户裁决痕迹，
 * 转录里无对应物），压缩条/裁剪副行按时间序并回（D9：不是 run 的产物，
 * 替换不得吞掉；审批锚回在其后组合，卡匹配不受影响）。
 */
export function replaceRunTerminal(list: MessageItem[], segments: ChatMessage[]): MessageItem[] {
  let lastUser = -1
  for (let i = list.length - 1; i >= 0; i--) {
    // 先落局部再判别：元素访问（list[i]）不参与窄化，点号链才行
    const item = list[i]
    if (item.type === undefined && item.role === 'user') {
      lastUser = i
      break
    }
  }
  const keptApprovals: ApprovalItem[] =
    lastUser >= 0 ? list.slice(lastUser + 1).filter((m): m is ApprovalItem => m.type === 'approval') : []
  const keptCompaction = (
    lastUser >= 0
      ? list.slice(lastUser + 1).filter((m) => m.type === 'pruned' || (m.type === undefined && m.role === 'compaction'))
      : []
  ) as Array<ChatMessage | PrunedItem> // 谓词保证形状，联合收窄用断言（filter 不做类型谓词）
  return lastUser >= 0
    ? [
        ...list.slice(0, lastUser + 1),
        ...flatWithApprovals(flatWithCompaction(flattenSegments(segments), keptCompaction), keptApprovals)
      ]
    : list
}
