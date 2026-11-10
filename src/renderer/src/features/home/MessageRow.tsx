/**
 * 单条消息渲染件（自 HomeChat 拆出，2026-11-10 回合分组改造）：
 * 用户 = 灰气泡右挂 + 时间戳/复制/编辑（纯文本，主流一致）；助手 = 平铺
 * Markdown 正文（Streamdown）+ 思考流（Reasoning，先思考后正文）+ 用量统计行。
 * 与回合容器（TurnGroup）分工：容器管层级（过程体/终答/聚合行），本件管单条。
 * MessageLike 是这组会话视图件共享的消息渲染形状（ConversationIndex 等经
 * HomeChat 再导出使用），定义在此、经 props 单向下发。
 */
import { memo } from 'react'
import { IconCopy, IconPencil } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Markdown } from '@/components/ui/markdown'
import { Reasoning } from '@/components/ui/reasoning'
import { formatDuration } from '@/components/ui/run-trace'
import { formatTokens } from './ContextIndicator'
import type { MessageUsage } from '@/env.d'

/** 消息的最小渲染形状（chat store 的 ChatMessage，props 单向传入；会话视图
    各件 —— ConversationIndex 等 —— 共享，经 HomeChat 再导出） */
export type MessageLike = {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  usage?: MessageUsage
  durationMs?: number
  timestamp: number
}

/** 消息时间戳：HH:MM（气泡下小字） */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * 成本 USD：四位小数去尾零（0.0031 → $0.0031）；不足 $0.0001 标下限而非抹成 $0。
 * 目录估价加 ≈ 前缀（端点不报账单，单价是汇率/分时快照，如 DeepSeek 分时半价未建模）；
 * 下限分支不加 —— "<" 本身已传达"不精确"，再叠 ≈ 是双重标记。
 */
function formatCost(usd: number, estimated?: boolean): string {
  if (usd < 0.0001) return '<$0.0001'
  return `${estimated ? '≈' : ''}$${parseFloat(usd.toFixed(4))}`
}

/**
 * assistant 消息元信息行（shadcn message 的 footer 位）：输入/输出 token +
 * 缓存读/写 + 成本 + 模型耗时。数据无则整行不渲染 —— 流式占位没有 usage，
 * 统计行随 run.completed 在回答完成时出现。零值省略：无缓存命中的回答不显示
 * 缓存项、无定价模型不显示成本（"没发生"与"值为 0"在此同义，常显一排 0 是噪音）。
 * 回合聚合口径（TurnGroup 终答下方的合计行）复用本行 —— 单一格式不漂移。
 */
export function UsageLine({ usage, durationMs }: { usage?: MessageUsage; durationMs?: number }) {
  const parts: string[] = []
  if (usage) {
    parts.push(`↑ ${formatTokens(usage.input)}`, `↓ ${formatTokens(usage.output)}`)
    if (usage.cacheRead > 0) parts.push(`缓存读 ${formatTokens(usage.cacheRead)}`)
    if (usage.cacheWrite > 0) parts.push(`缓存写 ${formatTokens(usage.cacheWrite)}`)
    const cost = usage.totalCost
    if (cost !== undefined && cost > 0) parts.push(formatCost(cost, !usage.totalCostFromProvider))
  }
  if (durationMs !== undefined) parts.push(formatDuration(durationMs))
  if (parts.length === 0) return null
  return <div className="text-[11px] text-muted-foreground tabular-nums">{parts.join(' · ')}</div>
}

/** 单条消息：用户 = 灰气泡右挂 + 时间戳/复制/编辑（纯文本，主流一致）；助手 =
 *  平铺 Markdown 正文（Streamdown）+ 用量统计行。memo：chat store 每 delta 全量
 *  setState 换数组，但历史消息对象引用稳定 —— memo 后逐 token 的重解析只落在
 *  流式占位这一条上（那条由 Streamdown 块级 memo 兜底），历史消息零重渲染 */
export const MessageRow = memo(function MessageRow({ message }: { message: MessageLike }) {
  if (message.role === 'user') {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted" align="end">
            <BubbleContent>{message.content}</BubbleContent>
          </Bubble>
          <MessageFooter className="gap-1 px-0">
            <span className="text-[11px] text-muted-foreground">{formatTime(message.timestamp)}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
              aria-label="复制"
              onClick={() => void navigator.clipboard.writeText(message.content)}
            >
              <IconCopy className="size-3.5" />
            </Button>
            {/* 编辑：重发用户消息属后续件（依赖消息级编辑协议），先占位 */}
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
              aria-label="编辑"
            >
              <IconPencil className="size-3.5" />
            </Button>
          </MessageFooter>
        </MessageContent>
      </Message>
    )
  }
  return (
    <Message align="start">
      <MessageContent className="gap-1 px-0.5">
        {/* 思考流：流式占位且正文未开始 = 还在思考阶段（自动展开）；正文一来自动收起。
            交错思考（commentary）的精确信号属 content blocks 件，当前模型思考都先于正文 */}
        {message.thinking && (
          <Reasoning
            text={message.thinking}
            running={message.id === 'streaming' && message.content.length === 0}
          />
        )}
        {/* 正文 Markdown 渲染（路线空位 4 前半）：流式占位消息传 streaming，
            未闭合的代码围栏在流式中即按代码块渲染（remend 修复） */}
        <Markdown content={message.content} streaming={message.id === 'streaming'} />
        <UsageLine usage={message.usage} durationMs={message.durationMs} />
      </MessageContent>
    </Message>
  )
})
