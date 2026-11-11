/**
 * 工具调用卡 —— shadcn AI Elements Tool pattern 官方配方落地
 * （https://ui.shadcn.com/docs/ai-elements/base/tool：Tool = Trace + TraceCollapsible
 *  + CodeBlock 的组合件，官方即"装原语照配方组合"，无独立可 add 的组件）。
 * 状态映射照官方表：运行中 = 单行 TraceLine（不可折叠）；有输出 = 可折叠卡
 * （CodeBlock 展示结果，错误走 destructive 变体）；拒绝 = 置灰单行（denied）。
 * 数据 = ToolItem（协议 tool.started/completed 事件与 ChatMessage.toolCalls 共用投影）。
 * 批次 3 扩展（2026-11-11）：运行中且有 progress（bash 流式尾部快照）时挂
 * 直播尾行；终态有 diff（edit 工具）时折叠体首块渲染 diff（+绿 -红 上下文灰）。
 */
import { useState } from 'react'
import {
  BanIcon,
  CircleXIcon,
  FileDiffIcon,
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
  ls: <FolderSearchIcon />,
  write: <WrenchIcon />,
  edit: <FileDiffIcon />
}

/** edit 的展示 diff 行染色：+ 增 / - 删 / 其余（行号上下文）灰 */
function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <CodeBlock size="sm">
      <CodeBlockContent wrap className="max-h-64 font-mono text-xs leading-5">
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith('+')
                ? 'text-emerald-600 dark:text-emerald-400'
                : line.startsWith('-')
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-muted-foreground'
            }
          >
            {line === '' ? '\u00A0' : line}
          </div>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** bash 运行中的直播尾行：progress 快照取末几行（窗口向上滚动的观感） */
function ProgressTail({ progress }: { progress: string }) {
  const lines = progress.split('\n').filter((l) => l.trim() !== '')
  const tail = lines.slice(-2)
  if (tail.length === 0) return null
  return (
    <div className="ml-7 mt-0.5 font-mono text-[11px] leading-4 text-muted-foreground">
      {tail.map((line, i) => (
        <div key={i} className="truncate">
          {line}
        </div>
      ))}
    </div>
  )
}

export function ToolCard({
  name,
  summary,
  status,
  result,
  progress,
  diff
}: {
  /** 工具名（read/glob/grep/write/edit/bash…，图标映射键） */
  name: string
  /** 参数一行摘要（如 read("src/index.ts")，引擎生成） */
  summary: string
  status: ToolStatus
  /** 结果一行摘要（截断；错误/拒绝时为原因） */
  result?: string
  /** 执行中的流式尾部快照（bash；终态由 result 接管） */
  progress?: string
  /** edit 的展示 diff（带行号 +-/ 上下文） */
  diff?: string
}) {
  // 开合只在"有输出可看"时有意义；运行中/拒绝是单行（官方同款），
  // 折叠状态留给完成/失败态
  const [open, setOpen] = useState(false)
  const toolIcon = TOOL_ICON[name] ?? <TerminalIcon />
  // 摘要含文件路径/模式 —— 等宽对齐观感更好（--font-mono token）
  const title = <TraceTitle className="font-mono text-xs">{summary}</TraceTitle>

  if (status === 'running' || status === 'blocked') {
    // 运行中：shimmer 标题 + spinner；拒绝：置灰单行（denied，无 status 色）
    // 运行中且有流式进度（bash）：单行下挂直播尾行（快照末两行，等宽灰字）
    return (
      <div>
        <TraceLine status={status === 'running' ? 'running' : 'pending'}>
          <TraceIcon>{status === 'running' ? <LoaderCircleIcon className="animate-spin" /> : <BanIcon />}</TraceIcon>
          {title}
          {/* shrink-0：标题 truncate 按比例分摊收缩时，普通文本项可被压到
              min-content —— 中文逐字可断，两字标签会被压成一列竖排（验收实录） */}
          <span className="shrink-0 whitespace-nowrap text-[11px]">{STATUS_LABEL[status]}</span>
        </TraceLine>
        {status === 'running' && progress !== undefined && progress !== '' && <ProgressTail progress={progress} />}
      </div>
    )
  }

  const hasResult = result !== undefined && result !== ''
  const hasDiff = diff !== undefined && diff !== ''
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={status === 'error' ? 'error' : undefined}>
          <TraceIcon>{status === 'ok' ? toolIcon : <CircleXIcon />}</TraceIcon>
          {title}
          <span className="shrink-0 whitespace-nowrap text-[11px]">{STATUS_LABEL[status]}</span>
        </TraceLine>
      </TraceCollapsibleTrigger>
      {(hasResult || hasDiff) && (
        <TraceCollapsibleContent>
          {/* diff 块在前（edit 的"改了什么"是主内容），结果摘要在后 */}
          {hasDiff && <DiffBlock diff={diff} />}
          {hasResult && (
            /* 官方配方：CodeBlock size="sm" + wrap + max-h 展示工具输出；
               失败原因走 destructive 变体（红调） */
            <CodeBlock size="sm" variant={status === 'error' ? 'destructive' : 'default'}>
              <CodeBlockContent wrap className="max-h-64">
                {result}
              </CodeBlockContent>
            </CodeBlock>
          )}
        </TraceCollapsibleContent>
      )}
    </TraceCollapsible>
  )
}
