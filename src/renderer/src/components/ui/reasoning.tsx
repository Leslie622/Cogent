/**
 * 思考流（AI Elements Reasoning pattern 本地落地，底层 = ui/trace + ui/collapsible）。
 * 数据 = 一段流式思考文本（协议 ChatMessage.thinking），无 SDK 依赖。
 * 形态（docs/计划/对话过程呈现打磨.md §3.4，zcode reasoning.tsx 同构）：
 * 收起单行 = 静态脑图标 + 标题（running 扫光）+ 末行摘要横向滚动（增长推到
 * 末尾、超宽渐隐）—— **默认收起，含流式期间**（此前 open ?? running 的
 * 自动展开让逐 token 增长不断撑高布局，是工作中行上下跳动的主源）；
 * 展开态限高内部滚动 + 底部跟随（贴近底部才吸底，上翻即停），纯文本渲染
 * （不走 Markdown —— 每 chunk 重跑解析是卡顿源）。
 * 开合语义：用户手动优先，缺省收起；完成态标题「思考」+「持续了 Xs」尾标。
 */
import { useEffect, useRef, useState } from 'react'
import { BrainIcon } from 'lucide-react'
import { cn } from 'cn'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { formatDuration } from '@/components/ui/run-trace'

/** 流式摘要取末个非空行（zcode resolveReasoningStreamingSummary 同款）：
 *  思考文本常以换行分段，末行即"正在想什么"的当下快照 */
function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line !== '') return line
  }
  return ''
}

export function Reasoning({
  text,
  running,
  defaultOpen,
  durationMs,
}: {
  /** 思考文本（流式增长中；空文本时只显示标题行） */
  text: string
  /** 思考进行中：标题「正在思考」扫光 + 收起态挂滚动摘要行 */
  running: boolean
  /** 手动开合的初值；缺省收起（含流式期间，见文件头） */
  defaultOpen?: boolean
  /** 思考耗时（完成态「持续了 Xs」尾标；流式期间无值不显示） */
  durationMs?: number
}) {
  const [open, setOpen] = useState(defaultOpen)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const [summaryOverflowing, setSummaryOverflowing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 收起态摘要行：内容增长把单行视口推到末尾（最新内容可见，旧内容向左
  // 让位），溢出才挂左右渐隐 mask —— 状态切换不惊动 React 树（仅 mask 布尔）
  useEffect(() => {
    const viewport = summaryRef.current
    if (viewport === null || open) return
    viewport.scrollLeft = viewport.scrollWidth
    const overflowing = viewport.scrollWidth > viewport.clientWidth + 1
    setSummaryOverflowing((prev) => (prev === overflowing ? prev : overflowing))
  }, [text, open])

  // 展开态底部跟随：贴近底部（<24px）时新内容吸底；用户上翻即停跟随
  useEffect(() => {
    const viewport = scrollRef.current
    if (viewport === null || !open) return
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [text, open])

  const line = (
    <TraceLine status={running ? 'running' : undefined}>
      <TraceIcon>
        <BrainIcon />
      </TraceIcon>
      <TraceTitle className="shrink-0">{running ? '正在思考' : '思考'}</TraceTitle>
      {running && !open && text.length > 0 && (
        <span
          ref={summaryRef}
          className={cn(
            'min-w-0 flex-1 overflow-hidden whitespace-nowrap text-xs text-muted-foreground/70',
            summaryOverflowing && 'scroll-fade-x'
          )}
        >
          {lastNonEmptyLine(text)}
        </span>
      )}
      {!running && durationMs !== undefined && (
        <TraceDescription>持续了 {formatDuration(durationMs)}</TraceDescription>
      )}
    </TraceLine>
  )

  if (text.length === 0) return line

  return (
    <TraceCollapsible open={open ?? false} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        {/* 限高 + 内部滚动 + 底部跟随：思考全文不再撑开消息流布局 */}
        <div ref={scrollRef} className="max-h-60 overflow-y-auto text-[13px] whitespace-pre-wrap">
          {text}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
