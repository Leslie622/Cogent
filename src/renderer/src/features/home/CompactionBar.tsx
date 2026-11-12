/**
 * 「已压缩」折叠条（批次 4 步骤 4.2）—— 消息流里压缩发生位置的常驻标记行：
 * 引擎把被摘要区换成一条 compactionSummary 转录消息，本件是它的 renderer
 * 呈现（历史回查投影与 compaction.completed 事件手术两条来源同一形状）。
 *
 * 形态走 run-trace 家族（TraceCollapsible）：收起 = 置灰单行（图标 + 文案 +
 * 前后 token），展开 = checkpoint 摘要全文。摘要正文是模型产出的结构化
 * markdown 纯文本，pre-wrap 直出（不进 Markdown 渲染 —— 折叠条是低频查看
 * 件，摘要里的 ## 标题按原文看反而保真），容器放开 select-text（UI 方针 5：
 * 正文类内容逐处放开）。
 */
import { IconArrowRight, IconFileScissorsFilled, IconFolderFilled } from '@tabler/icons-react'
import { TraceIcon, TraceLine, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from '@/components/ui/trace'
import { formatTokens } from './ContextIndicator'
import type { PrunedItem } from '@/stores/chat'
import type { ChatMessage } from '@/env.d'

export function CompactionBar({ message }: { message: ChatMessage }) {
  const { tokensBefore, tokensAfter } = message.compaction ?? {}
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status="pending">
          <TraceIcon>
            <IconFolderFilled />
          </TraceIcon>
          上下文已压缩
          {tokensBefore !== undefined && (
            /* token 变化小字：等宽对齐（同工具卡摘要/审批痕迹的口径） */
            <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums">
              {formatTokens(tokensBefore)}
              {tokensAfter !== undefined && (
                <>
                  <IconArrowRight className="size-3" />
                  {formatTokens(tokensAfter)}
                </>
              )}
            </span>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="max-h-64 overflow-y-auto select-text">
        <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">{message.content}</pre>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/**
 * L1 prune 副行（完备化 R3/D8）：「已裁剪 N 处工具输出」—— 与折叠条同区的
 * 置灰单行（TraceLine 家族一致）；展开列每处的字符量对账（N → M，格式化走
 * formatTokens 同款紧凑口径，字符非 token，行首注明）。历史回查不产此行
 * （转录真源是改写后的 toolResult，marker 自带痕迹），仅事件路径落
 */
export function PrunedBar({ item }: { item: PrunedItem }) {
  const saved = item.entries.reduce((sum: number, e: { originalChars: number; prunedChars: number }) => sum + (e.originalChars - e.prunedChars), 0)
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status="pending">
          <TraceIcon>
            <IconFileScissorsFilled />
          </TraceIcon>
          已裁剪 {item.entries.length} 处工具输出
          <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums">
            −{formatTokens(saved)} 字符
          </span>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="select-text">
        <div className="flex flex-col gap-1 font-mono text-[11px] tabular-nums">
          {item.entries.map((e) => (
            <div key={e.toolCallId}>
              {e.toolCallId}：{formatTokens(e.originalChars)} → {formatTokens(e.prunedChars)}
            </div>
          ))}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
