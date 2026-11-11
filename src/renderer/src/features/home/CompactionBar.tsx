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
import { IconArrowRight, IconFolderFilled } from '@tabler/icons-react'
import { TraceIcon, TraceLine, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from '@/components/ui/trace'
import { formatTokens } from './ContextIndicator'
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
