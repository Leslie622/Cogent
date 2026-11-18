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
import { CompactionBar } from './CompactionBar'
import type { MessageUsage } from '@/env.d'

/** 消息的最小渲染形状（chat store 的 ChatMessage，props 单向传入；会话视图
    件 —— ConversationIndex 等 —— 共享，经 HomeChat 再导出）。role 含
    'compaction'（压缩折叠条）：MessageItem 联合随协议扩了角色，
    MessageRow 是其类型流的终点，跟上才有完备分支（常态由 TurnGroup 的
    独立行快路接管，进不到这里） */
export type MessageLike = {
  id: string
  role: 'user' | 'assistant' | 'compaction'
  content: string
  thinking?: string
  /** 活跃流式占位标记（chat store 本地字段）：驱动 Reasoning/Markdown 的
   *  流式态 —— 不挂在 id 上，id 是渲染 key 素材（封段不换名，见
   *  docs/模块/消息呈现.md） */
  placeholder?: boolean
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
export function formatCost(usd: number, estimated?: boolean): string {
  if (usd < 0.0001) return '<$0.0001'
  return `${estimated ? '≈' : ''}$${parseFloat(usd.toFixed(4))}`
}

/**
 * assistant 消息元信息行（shadcn message 的 footer 位）：输入/输出 token +
 * 缓存读/写 + 成本 + 模型耗时（+ 工具耗时，回合聚合行）。数据无则整行不渲染 ——
 * 流式占位没有 usage，统计行随 run.completed 在回答完成时出现。零值省略：
 * 无缓存命中的回答不显示缓存项、无定价模型不显示成本（"没发生"与"值为 0"
 * 在此同义，常显一排 0 是噪音）。时长呈现：单条消息/纯工具回合只有模型时长，
 * 裸数字（主流形态）；回合聚合行带工具打点时两者并挂标签（`5.7s 模型 ·
 * 1.4s 工具`）—— 三数分解对得上头条墙钟（模型 + 工具 + 引擎开销 ≈ 墙钟）。
 */
export function UsageLine({
  usage,
  durationMs,
  toolMs
}: {
  usage?: MessageUsage
  durationMs?: number
  /** 工具执行墙钟（区间并集，TurnGroup sumToolMs）；仅回合聚合行传入 */
  toolMs?: number
}) {
  const parts: string[] = []
  if (usage) {
    parts.push(`↑ ${formatTokens(usage.input)}`, `↓ ${formatTokens(usage.output)}`)
    if (usage.cacheRead > 0) parts.push(`缓存读 ${formatTokens(usage.cacheRead)}`)
    if (usage.cacheWrite > 0) parts.push(`缓存写 ${formatTokens(usage.cacheWrite)}`)
    const cost = usage.totalCost
    if (cost !== undefined && cost > 0) parts.push(formatCost(cost, !usage.totalCostFromProvider))
  }
  if (durationMs !== undefined) {
    if (toolMs !== undefined) {
      parts.push(`${formatDuration(durationMs)} 模型`, `${formatDuration(toolMs)} 工具`)
    } else {
      parts.push(formatDuration(durationMs))
    }
  }
  if (parts.length === 0) return null
  // select-none：统计行是 chrome（消息流容器放开的 select-text 只该落在
  // 正文上，UI 方针 5）—— 拖划正文不把数字行蓝选成片
  return <div className="text-[11px] text-muted-foreground tabular-nums select-none">{parts.join(' · ')}</div>
}

/** 单条消息：用户 = 灰气泡右挂 + 时间戳/复制/编辑（纯文本，主流一致）；助手 =
 *  平铺 Markdown 正文（Streamdown）+ 用量统计行。memo：chat store 每 delta 全量
 *  setState 换数组，但历史消息对象引用稳定 —— memo 后逐 token 的重解析只落在
 *  流式占位这一条上（那条由 Streamdown 块级 memo 兜底），历史消息零重渲染 */
export const MessageRow = memo(function MessageRow({ message }: { message: MessageLike }) {
  // 压缩折叠条（类型完备分支，常态走 TurnGroup 独立行快路）
  if (message.role === 'compaction') {
    return <CompactionBar message={message} />
  }
  if (message.role === 'user') {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted" align="end">
            <BubbleContent>{message.content}</BubbleContent>
          </Bubble>
          <MessageFooter className="gap-1 px-0">
            {/* 时间戳是 chrome：select-none（气泡正文保持可选，zcode 时间戳同款） */}
            <span className="text-[11px] text-muted-foreground select-none">{formatTime(message.timestamp)}</span>
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
      {/* 行距/左缘对齐 live 容器（gap-3、零缩进，2026-11-18 用户验收）：段内
          思考行/正文/统计行与平级工具行同一节奏 —— 此前 gap-1 px-0.5 让段内
          行距 4px（思考→正文视觉 13px vs 思考→工具行 22px）且整体右移 2px
          （图标与工具行错位，违背决定 18 平级零缩进的逐像素对齐） */}
      <MessageContent className="gap-3">
        {/* 思考流：流式占位且正文未开始 = 还在思考阶段（收起单行 + 末行摘要
            滚动，docs/模块/消息呈现.md）；交错思考（commentary）
            的精确信号属 content blocks 件，当前模型思考都先于正文 */}
        {message.thinking && (
          <Reasoning
            text={message.thinking}
            running={message.placeholder === true && message.content.length === 0}
          />
        )}
        {/* 正文 Markdown 渲染（路线空位 4 前半）：活跃占位（placeholder）传
            streaming，未闭合的代码围栏在流式中即按代码块渲染（remend 修复）。
            空 content 不挂载：纯思考段的空 md-body 是 0 高 flex 子项，仍吃
            两侧 gap 的死空白（行距统一 gap-3 后从隐性 4px 变显性 12px，
            2026-11-18 用户验收）；首个正文 delta 到达时自然挂载 */}
        {message.content !== '' && (
          <Markdown content={message.content} streaming={message.placeholder === true} />
        )}
        <UsageLine usage={message.usage} durationMs={message.durationMs} />
      </MessageContent>
    </Message>
  )
})
