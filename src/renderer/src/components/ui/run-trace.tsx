/**
 * 回合轨迹容器（ZCode 式两态呈现的头条/工作中行，见 docs/模块/消息呈现.md）：
 * 一个回合（run）的过程（思考/工具/中间正文）收进一条可展开的轨迹 ——
 * RunTrace = 头条 + Trace 家族折叠体。头条是**终态**形态（用时 X 秒 /
 * 已停止 / 出错了）；live 期间不渲染本件（顶部头条只在收尾出现），
 * 底部由 WorkingLine 常驻「工作中」（光环动效图标 WorkingSpinner + 标题扫光 + 码表）。
 * 无过程体（纯文本回合也恒挂头条）时退化为单行头条、不可展开 ——
 * 空折叠体挂个开合箭头是噪音。
 * 底层 = ui/trace（与 Reasoning/ToolCard 同家族，视觉一套）；终态头条
 * 不带图标（2026-11-18 用户定调：状态词自足，failed 红字兜底异常性）。
 * 开合语义：所有终态缺省收起，用户手动选择优先；末条正文由外层常驻，
 * 收起详情不会隐藏半截终答，与 Reasoning 的缺省收起语义一致。
 */
import { Children, useEffect, useState } from 'react'
import { WorkingSpinner } from '@/components/WorkingSpinner'
import { MessageScrollerPinnedRow } from '@/components/ui/message-scroller'
import { useAppearanceStore } from '@/stores/appearance'
import { formatDuration, type DurationPrecision } from '@/lib/format-duration'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

/** 回合终态 */
export type RunPhase = 'done' | 'stopped' | 'failed'

/** 头条文案：done 带墙钟时长（数据缺失兜底不带数）；stopped/failed 用状态词 */
function headerLabel(phase: RunPhase, durationMs: number | undefined, precision: DurationPrecision): string {
  if (phase === 'stopped') return '已停止'
  if (phase === 'failed') return '出错了'
  return durationMs !== undefined ? `用时 ${formatDuration(durationMs, precision, 'chinese')}` : '用时'
}

/** 工作行局部时钟：只更新工作行自身，不惊动外层流式树。
 *  亚秒走字是刻意为之（2026-11-11「计时器卡住」排障定论）：1s 粒度的首跳在
 *  +1s，而快回合（预热后问候语 ~1s 跑完）全程只剩挂载零头「6ms」死数字 ——
 *  观感即秒表停走；码表式滚动（6ms→140ms→380ms→1s…）才与「计时中」语义
 *  相符。focus/visibility 即刻对齐：被环境节流的残余路径下，看向窗口瞬间
 *  数字就是准的 */
function useElapsed(startTs: number): string {
  const precision = useAppearanceStore((state) => state.durationPrecision)
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
  return formatDuration(Math.max(now - startTs, 0), precision, 'chinese')
}

/** 回合过程轨迹：终态头条 + 折叠体（children = 过程项，间距在此统一 ——
 *  Trace 家族内容区已平级无导线，只带纵向内边距；头条下常驻分割线在此挂）。
 *  children 为空（无过程回合）= 单行头条不可展开 */
export function RunTrace({
  phase,
  durationMs,
  children,
  revealKey,
}: {
  revealKey?: number
  phase: RunPhase
  durationMs?: number
  children?: React.ReactNode
}) {
  // undefined = 未被用户动过，交出控制权跟随默认
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  // 一次搜索意图只展开一次；随后仍尊重用户手动收起。
  useEffect(() => { if (revealKey !== undefined) setOpen(true) }, [revealKey])
  const precision = useAppearanceStore((state) => state.durationPrecision)
  const header = (
    <TraceLine status={phase === 'failed' ? 'error' : undefined}>
      {/* 终态头条一律不带图标（2026-11-18 用户定调）：状态词自足，failed 的
          异常性由整行红字（TraceLine data-status=error）承担 */}
      <TraceTitle>{headerLabel(phase, durationMs, precision)}</TraceTitle>
    </TraceLine>
  )
  // 无过程体（纯文本回合）：头条单行直出，不挂折叠机构（空折叠体 + 箭头是噪音）
  if (Children.count(children) === 0) return header
  return (
    <TraceCollapsible open={open ?? false} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{header}</TraceCollapsibleTrigger>
      {/* 头条下分割线已取消（2026-11-20 用户定调，推翻 11-16 的常驻线）：
          收起态即单行头条。折叠体展开后的纵向分隔由内层 pt 承担 */}
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-3">{children}</div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** 始终只有一份工作行；跟随时仅切换定位，收尾不等待正文视觉队列。 */
export function WorkingLine({ startTs, stopping = false }: { startTs: number; stopping?: boolean }) {
  const elapsed = useElapsed(startTs)
  return (
    <MessageScrollerPinnedRow>
      <TraceLine status="running">
        <TraceIcon><WorkingSpinner /></TraceIcon>
        <TraceTitle>{stopping ? '正在停止' : '工作中'}</TraceTitle>
        <TraceDescription>{elapsed}</TraceDescription>
      </TraceLine>
    </MessageScrollerPinnedRow>
  )
}
