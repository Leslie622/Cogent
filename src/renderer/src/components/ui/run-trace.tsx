/**
 * 回合轨迹容器（ZCode 式两态呈现的头条/工作中行，见 docs/计划/回合过程折叠.md）：
 * 一个回合（run）的过程（思考/工具/中间正文）收进一条可展开的轨迹 ——
 * RunTrace = 头条 + Trace 家族折叠体。头条三形：终答开流后的 live 态
 * （工作中 + 计时，过程即时折叠）、终态（已工作 Xs / 已停止 / 出错了）；
 * 过程还在直播（终答未开流）时不渲染本件，底部由 WorkingLine 常驻「工作中」。
 * 无过程体（D8 修订：纯文本回合也恒挂头条）时退化为单行头条、不可展开 ——
 * 空折叠体挂个开合箭头是噪音。
 * 底层 = ui/trace（与 Reasoning/ToolCard 同家族，视觉一套）；图标走 lucide
 * 同家族惯例（AGENTS 方针 2 的"原语内部小图标"例外，与 tool.tsx 同理）。
 * 开合语义：用户手动优先（open ?? 默认），缺省 = stopped 展开（半截正文别藏）、
 * 其余收起 —— 与 Reasoning 的 open ?? running 同款，家族一致。
 */
import { Children, useEffect, useState } from 'react'
import { CircleXIcon, ClockIcon, LoaderCircleIcon, SquareIcon } from 'lucide-react'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

/** 时长统一 s 两位小数（2026-11-11 用户定调：不显 ms，码表口径亚秒可见 ——
 *  6ms → 0.01s、140ms → 0.14s、2400ms → 2.40s）。
 *  定义在此导出给 MessageRow 的 UsageLine 共用（单一实现避免两处口径漂移） */
export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

/** 回合终态；'live' = 终答已开流、run 未收尾的折叠态（2026-11-10 用户定调：
 *  结果出来了就直接把过程折叠，不等终态事件） */
export type RunPhase = 'done' | 'stopped' | 'failed'

/** 头条文案：done 带墙钟时长（数据缺失兜底不带数）；stopped/failed 用状态词 */
function headerLabel(phase: RunPhase, durationMs: number | undefined): string {
  if (phase === 'stopped') return '已停止'
  if (phase === 'failed') return '出错了'
  return durationMs !== undefined ? `已工作 ${formatDuration(durationMs)}` : '已工作'
}

/** 计时尾标：100ms 自持重渲染（只重渲染自身这个 span，不惊动外层流式树）。
 *  亚秒走字是刻意为之（2026-11-11「计时器卡住」排障定论）：1s 粒度的首跳在
 *  +1s，而快回合（预热后问候语 ~1s 跑完）全程只剩挂载零头「6ms」死数字 ——
 *  观感即秒表停走；码表式滚动（6ms→140ms→380ms→1s…）才与「计时中」语义
 *  相符。focus/visibility 即刻对齐：被环境节流的残余路径下，看向窗口瞬间
 *  数字就是准的 */
function Elapsed({ startTs }: { startTs: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    const refresh = (): void => setNow(Date.now())
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [startTs])
  return <TraceDescription>{formatDuration(Math.max(now - startTs, 0))}</TraceDescription>
}

/** 回合过程轨迹：头条 + 折叠体（children = 过程项，间距在此统一 ——
 *  Trace 家族内容区自带左轨与内边距）。phase 'live' = 终答开流后的即时折叠：
 *  头条是工作中态（spinner + 计时，run 收尾翻「已工作 Xs」），默认收起。
 *  children 为空（无过程回合）= 单行头条不可展开（D8 修订） */
export function RunTrace({
  phase,
  durationMs,
  startTs,
  children,
}: {
  phase: RunPhase | 'live'
  durationMs?: number
  /** live 头条计时起点（提问 timestamp） */
  startTs?: number
  children?: React.ReactNode
}) {
  // undefined = 未被用户动过，交出控制权跟随默认（D4）
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  const header = phase === 'live' ? (
    <TraceLine status="running">
      <TraceIcon>
        <LoaderCircleIcon className="animate-spin" />
      </TraceIcon>
      <TraceTitle>工作中</TraceTitle>
      {startTs !== undefined && <Elapsed startTs={startTs} />}
    </TraceLine>
  ) : (
    <TraceLine status={phase === 'failed' ? 'error' : undefined}>
      <TraceIcon>
        {phase === 'failed' ? (
          <CircleXIcon />
        ) : phase === 'stopped' ? (
          <SquareIcon />
        ) : (
          <ClockIcon />
        )}
      </TraceIcon>
      <TraceTitle>{headerLabel(phase, durationMs)}</TraceTitle>
    </TraceLine>
  )
  // 无过程体（纯文本回合）：头条单行直出，不挂折叠机构（空折叠体 + 箭头是噪音）
  if (Children.count(children) === 0) return header
  return (
    <TraceCollapsible open={open ?? phase === 'stopped'} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{header}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-3">{children}</div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** 进行中的常驻工作行：输出的位置一直显示「工作中」（spinner + 计时）——
 *  过程间隙（等首轮 delta / 工具执行 / 轮间往返）的唯一活动信号。
 *  终答开流后由 RunTrace 的 live 头条接管，本行退场 */
export function WorkingLine({ startTs }: { startTs: number }) {
  return (
    <TraceLine status="running">
      <TraceIcon>
        <LoaderCircleIcon className="animate-spin" />
      </TraceIcon>
      <TraceTitle>工作中</TraceTitle>
      <Elapsed startTs={startTs} />
    </TraceLine>
  )
}
