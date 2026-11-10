/**
 * 思考流（AI Elements Reasoning pattern 本地落地，底层 = ui/trace + ui/collapsible）。
 * 数据 = 一段流式思考文本（协议 ChatMessage.thinking），无 SDK 依赖。
 * 开合语义（官方 open ?? running）：思考中自动展开 + 标题 shimmer，思考结束自动收起；
 * 用户手动开合后以用户为准，不再被状态抢走。
 * 图标（2026-11-10 用户定调换脑）：完成态 = 脑（对齐 ZCode 的 🧠 思考意象；
 * 此前对勾与"完成"语义无关），进行中仍是 spinner。
 */
import { useState } from 'react'
import { BrainIcon, LoaderCircleIcon } from 'lucide-react'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

export function Reasoning({
  text,
  running,
  defaultOpen,
}: {
  /** 思考文本（流式增长中；空文本时只显示标题行） */
  text: string
  /** 思考进行中：标题 shimmer + 默认展开 */
  running: boolean
  /** 手动开合的初值；缺省 = 跟随 running（undefined 交出控制权） */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  const line = (
    <TraceLine status={running ? 'running' : undefined}>
      <TraceIcon>
        {running ? <LoaderCircleIcon className="animate-spin" /> : <BrainIcon />}
      </TraceIcon>
      <TraceTitle>{running ? '思考中' : '深度思考'}</TraceTitle>
    </TraceLine>
  )

  if (text.length === 0) return line

  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
