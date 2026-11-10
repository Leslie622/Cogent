/**
 * 工具调用卡 —— shadcn AI Elements Tool pattern 官方配方落地
 * （https://ui.shadcn.com/docs/ai-elements/base/tool：Tool = Trace + TraceCollapsible
 *  + CodeBlock 的组合件，官方即"装原语照配方组合"，无独立可 add 的组件）。
 * 状态映射照官方表：运行中 = 单行 TraceLine（不可折叠）；有输出 = 可折叠卡
 * （CodeBlock 展示结果，错误走 destructive 变体）；拒绝 = 置灰单行（denied）。
 * 数据 = ToolItem（协议 tool.started/completed 事件与 ChatMessage.toolCalls 共用投影）。
 */
import { useState } from 'react'
import {
  BanIcon,
  CircleXIcon,
  FileTextIcon,
  FolderSearchIcon,
  LoaderCircleIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'

export type ToolStatus = 'running' | 'ok' | 'error' | 'blocked'

/** 状态 → 尾标文案（头行右侧小字；blocked = 审批拒绝/中止，批次 2 起会出现） */
const STATUS_LABEL: Record<ToolStatus, string> = {
  running: '执行中',
  ok: '完成',
  error: '失败',
  blocked: '已拒绝'
}

/** 工具名 → 图标（官方配方：TraceIcon 放工具自身的图标，状态走标题 shimmer/配色） */
const TOOL_ICON: Record<string, React.ReactNode> = {
  read: <FileTextIcon />,
  glob: <FolderSearchIcon />,
  grep: <SearchIcon />,
  write: <WrenchIcon />
}

export function ToolCard({
  name,
  summary,
  status,
  result
}: {
  /** 工具名（read/glob/grep/write…，图标映射键） */
  name: string
  /** 参数一行摘要（如 read("src/index.ts")，引擎生成） */
  summary: string
  status: ToolStatus
  /** 结果一行摘要（截断；错误/拒绝时为原因） */
  result?: string
}) {
  // 开合只在"有输出可看"时有意义；运行中/拒绝是单行（官方同款），
  // 折叠状态留给完成/失败态
  const [open, setOpen] = useState(false)
  const toolIcon = TOOL_ICON[name] ?? <TerminalIcon />
  // 摘要含文件路径/模式 —— 等宽对齐观感更好（--font-mono token）
  const title = <TraceTitle className="font-mono text-xs">{summary}</TraceTitle>

  if (status === 'running' || status === 'blocked') {
    // 运行中：shimmer 标题 + spinner；拒绝：置灰单行（denied，无 status 色）
    return (
      <TraceLine status={status === 'running' ? 'running' : 'pending'}>
        <TraceIcon>{status === 'running' ? <LoaderCircleIcon className="animate-spin" /> : <BanIcon />}</TraceIcon>
        {title}
        <span className="text-[11px]">{STATUS_LABEL[status]}</span>
      </TraceLine>
    )
  }

  const hasResult = result !== undefined && result !== ''
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={status === 'error' ? 'error' : undefined}>
          <TraceIcon>{status === 'ok' ? toolIcon : <CircleXIcon />}</TraceIcon>
          {title}
          <span className="text-[11px]">{STATUS_LABEL[status]}</span>
        </TraceLine>
      </TraceCollapsibleTrigger>
      {hasResult && (
        <TraceCollapsibleContent>
          {/* 官方配方：CodeBlock size="sm" + wrap + max-h 展示工具输出；
              失败原因走 destructive 变体（红调） */}
          <CodeBlock size="sm" variant={status === 'error' ? 'destructive' : 'default'}>
            <CodeBlockContent wrap className="max-h-64">
              {result}
            </CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      )}
    </TraceCollapsible>
  )
}
