/**
 * 回合轨迹容器（ZCode 式两态呈现的头条/工作中行，见 docs/计划/对话过程呈现打磨.md）：
 * 一个回合（run）的过程（思考/工具/中间正文）收进一条可展开的轨迹 ——
 * RunTrace = 头条 + Trace 家族折叠体。头条是**终态**形态（已工作 Xs /
 * 已停止 / 出错了）；live 期间不渲染本件（顶部头条只在收尾出现），
 * 底部由 WorkingLine 常驻「工作中」（静态图标 + 标题扫光 + 码表）。
 * 无过程体（D8 修订：纯文本回合也恒挂头条）时退化为单行头条、不可展开 ——
 * 空折叠体挂个开合箭头是噪音。
 * 底层 = ui/trace（与 Reasoning/ToolCard 同家族，视觉一套）；图标走 lucide
 * 同家族惯例（AGENTS 方针 2 的"原语内部小图标"例外，与 tool.tsx 同理）。
 * 开合语义：所有终态缺省收起，用户手动选择优先；末条正文由外层常驻，
 * 收起详情不会隐藏半截终答，与 Reasoning 的缺省收起语义一致。
 */
import { Children, useEffect, useState } from 'react'
import { CircleXIcon, ClockIcon, SquareIcon } from 'lucide-react'
import { MessageScrollerDecoration } from '@/components/ui/message-scroller'
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
 *  定义在此导出给 MessageRow 的 UsageLine / Reasoning 的时长尾标共用
 *  （单一实现避免多处口径漂移） */
export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

/** 回合终态 */
export type RunPhase = 'done' | 'stopped' | 'failed'

/** 头条文案：done 带墙钟时长（数据缺失兜底不带数）；stopped/failed 用状态词 */
function headerLabel(phase: RunPhase, durationMs: number | undefined): string {
  if (phase === 'stopped') return '已停止'
  if (phase === 'failed') return '出错了'
  return durationMs !== undefined ? `已工作 ${formatDuration(durationMs)}` : '已工作'
}

/** 工作行局部时钟：源与视觉副本共用一次取值，不惊动外层流式树。
 *  秒粒度走字（2026-11-18 修订）：亚秒码表（10Hz 文字宽度变化）在高分屏
 *  分数缩放下叠加滚动 snap 二态，是「工作中」行可感抖动的加成项；秒粒度
 *  把数字变化频率降到 1Hz，focus/visibility 即刻对齐口径保留。终态头条的
 *  formatDuration（两位小数）口径不变 —— 那是「已工作多久」的结算语义。 */
function useElapsed(startTs: number): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    // 250ms 采样对齐秒跳：1s 粒度的显示值每秒才变，采样再密只浪费重渲染
    const timer = setInterval(() => setNow(Date.now()), 250)
    const refresh = (): void => setNow(Date.now())
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [startTs])
  return `${Math.floor(Math.max(now - startTs, 0) / 1000)}s`
}

/** 回合过程轨迹：终态头条 + 折叠体（children = 过程项，间距在此统一 ——
 *  Trace 家族内容区已平级无导线，只带纵向内边距；头条下常驻分割线在此挂）。
 *  children 为空（无过程回合）= 单行头条不可展开（D8 修订） */
export function RunTrace({
  phase,
  durationMs,
  children,
}: {
  phase: RunPhase
  durationMs?: number
  children?: React.ReactNode
}) {
  // undefined = 未被用户动过，交出控制权跟随默认（D4）
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  const header = (
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
    <TraceCollapsible open={open ?? false} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{header}</TraceCollapsibleTrigger>
      {/* 分割线**常驻**（2026-11-16 用户定调）：不随折叠体收起 —— 收起态
          也是「头条 + 线」的完整行。挂在触发器与面板之间（折叠机构外，
          不参与开合动画）：线到头条间距 mt-2 恒定，线到条目间距 = 折叠体
          内层 pt（决定 17 既定，随开合收拢）。进面板内则收起即 hidden，
          常驻语义即破（回归钉 turn-group.render.test.tsx） */}
      <div data-slot="run-trace-divider" className="mt-2 border-t" />
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-3">{children}</div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** 流内工作行是唯一业务与读屏源；溢出跟随时另画根内视觉副本。
 * 时钟只在此处运行一份；收尾由流内 RunTrace 接棒，不等待视觉队列。
 * 2026-11-18 消融定案：四件套（秒粒度码表 / rAF 整数贴底 / 24px 行高 /
 * 关 anchoring）+ 副本 = 真机不抖；四件套单独（剥离副本）= 图标仍抖 ——
 * 副本保留，勿再以「简化」名义拆除（证据链见 docs/计划/底部工作行抖动归因交接.md）。 */
export function WorkingLine({ startTs, stopping = false }: { startTs: number; stopping?: boolean }) {
  const elapsed = useElapsed(startTs)
  return (
    <MessageScrollerDecoration>
      <TraceLine status="running">
        <TraceIcon><ClockIcon /></TraceIcon>
        <TraceTitle>{stopping ? '正在停止' : '工作中'}</TraceTitle>
        <TraceDescription>{elapsed}</TraceDescription>
      </TraceLine>
    </MessageScrollerDecoration>
  )
}
