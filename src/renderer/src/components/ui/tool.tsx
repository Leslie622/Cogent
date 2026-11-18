/**
 * 工具调用卡 —— shadcn AI Elements Tool pattern 官方配方落地
 * （https://ui.shadcn.com/docs/ai-elements/base/tool：Tool = Trace + TraceCollapsible
 *  + CodeBlock 的组合件，官方即"装原语照配方组合"，无独立可 add 的组件）。
 * 头行结构（docs/模块/消息呈现.md，zcode ToolLayout 同构）：
 * 图标 + 类别词（tool-display）+ 主文案（summary 剥壳 / MCP server.tool）
 * + diff 计数尾标 + 状态词 —— 状态语义全在词上，不再整行变色。
 * 失败 = 行尾「执行失败」点状下划线，hover 出 Tooltip 看原因（含复制），
 * 折叠体仍是全量输出（手动展开，default 变体）。
 * 运行中：图标静态 + 类别词扫光（zcode 定调：旋转图标长期占用渲染资源），
 * bash 流式尾部快照挂定高直播窗 + indeterminate 扫光细条。
 */
import { useState } from 'react'
import {
  CircleHelpIcon,
  FileDiffIcon,
  FileTextIcon,
  FolderSearchIcon,
  ListChecksIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { askUserSummary, diffCount, mcpDisplayName, parseToolSummary, toolKindLabel, type ToolDisplayStatus } from './tool-display'

export type ToolStatus = ToolDisplayStatus

/** 工具名 → 图标（官方配方：TraceIcon 放工具自身的图标，状态走类别词扫光/状态词） */
const TOOL_ICON: Record<string, React.ReactNode> = {
  read: <FileTextIcon />,
  glob: <FolderSearchIcon />,
  grep: <SearchIcon />,
  ls: <FolderSearchIcon />,
  write: <WrenchIcon />,
  edit: <FileDiffIcon />,
  ask_user: <CircleHelpIcon />,
  todo_write: <ListChecksIcon />
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

/** bash 运行中的直播尾行：定高两行槽（不足补空 —— 行数翻动不推挤下方，
 *  流稳定化 §3.4），上方挂 indeterminate 扫光细条（活着」的信号替 spinner） */
function ProgressTail({ progress }: { progress: string }) {
  const lines = progress.split('\n').filter((l) => l.trim() !== '')
  const tail = lines.slice(-2)
  return (
    <div className="ml-7 mt-1 flex flex-col gap-1">
      <span
        className="relative block h-1 w-16 overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        <span className="progress-sweep absolute inset-y-0 w-1/3 rounded-full bg-foreground/50" />
      </span>
      <div className="font-mono text-[11px] leading-4 text-muted-foreground">
        {[tail[0] ?? '', tail[1] ?? ''].map((line, i) => (
          <div key={i} className="truncate">
            {line === '' ? '\u00A0' : line}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 失败状态词：点状下划线 + Tooltip（原因 + 复制）。无原因（result 缺失）
 *  时退化为纯文字 —— 悬停目标只属于有详情可看的场合 */
function ErrorStatus({ message }: { message?: string }) {
  const [copied, setCopied] = useState(false)
  if (message === undefined || message === '') {
    return <TraceDescription className="text-destructive">执行失败</TraceDescription>
  }
  return (
    /* delay 与 Hint 同口径（400ms）：消息流快速划过时不闪气泡 */
    <TooltipProvider delay={400}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="shrink-0 cursor-help whitespace-nowrap text-[11px] text-destructive underline decoration-dotted underline-offset-2" />
          }
        >
          执行失败
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-96">
          <div className="flex max-w-96 items-start gap-2">
            <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words">
              {message}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 shrink-0 text-background/70 hover:bg-background/10 hover:text-background"
              aria-label="复制失败原因"
              onClick={() => {
                void navigator.clipboard.writeText(message).then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? <span className="text-xs">已复制</span> : <span className="text-xs">复制</span>}
            </Button>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
  /** 工具名（read/glob/grep/write/edit/bash…，图标与类别词映射键） */
  name: string
  /** 参数一行摘要（引擎生成 `read(src/index.ts)` 形态），剥壳出主文案 */
  summary: string
  status: ToolStatus
  /** 结果一行摘要（截断；错误时为失败原因 —— Tooltip 内容源） */
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
  const kindLabel = toolKindLabel(name, status)
  // 主文案：MCP 显示 server.tool（裸工具名无识别量），ask_user 数问题数
  // （参数是 questions 数组，裸剥壳会给用户看原始 JSON），其余剥 summary 壳
  const primary =
    mcpDisplayName(name) ?? (name === 'ask_user' ? askUserSummary(summary) : parseToolSummary(name, summary))
  const counts = diff !== undefined ? diffCount(diff) : undefined

  /** 头行（icon + 类别词 + 主文案 + 尾标）；running 的扫光由 TraceLine
   *  data-status=running 对 trace-title 的 shimmer 带出（类别词即标题） */
  const line = (
    <TraceLine status={status === 'running' ? 'running' : status === 'blocked' ? 'pending' : undefined}>
      <TraceIcon>{toolIcon}</TraceIcon>
      <TraceTitle className="shrink-0">{kindLabel}</TraceTitle>
      {primary !== '' && (
        <span className="min-w-0 truncate font-mono text-xs">{primary}</span>
      )}
      {counts !== undefined && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{counts.added}</span>{' '}
          <span className="text-red-600 dark:text-red-400">-{counts.removed}</span>
        </span>
      )}
      {status === 'error' && <ErrorStatus message={result} />}
      {status === 'blocked' && <TraceDescription>已拒绝</TraceDescription>}
    </TraceLine>
  )

  if (status === 'running' || status === 'blocked') {
    // 运行中：类别词扫光、图标静态（zcode 定调）；拒绝：置灰单行。
    // 运行中且有流式进度（bash）：单行下挂定高直播尾行 + 扫光细条
    return (
      <div>
        {line}
        {status === 'running' && progress !== undefined && progress !== '' && <ProgressTail progress={progress} />}
      </div>
    )
  }

  const hasResult = result !== undefined && result !== ''
  const hasDiff = diff !== undefined && diff !== ''
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      {(hasResult || hasDiff) && (
        <TraceCollapsibleContent>
          {/* diff 块在前（edit 的"改了什么"是主内容），结果摘要在后；
              失败原因已由行尾 Tooltip 承担，CodeBlock 统一 default 变体不再红 */}
          {hasDiff && <DiffBlock diff={diff} />}
          {hasResult && (
            <CodeBlock size="sm">
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
