/**
 * 观测时间线：选中会话的条目按 run 分组顺时排列，实时追加（inspect.event）+
 * 跟随滚动。行 = 时刻 | 层色点+图标 | 标题 | 概览摘要；点击行 → 右侧详情。
 * 分组头展示 run 的提问预览与状态（进行中呼吸点 / 完成 / 失败红）。
 */
import { useEffect, useMemo, useRef } from 'react'
import { IconArrowBarToDown, IconPlayerPause } from '@tabler/icons-react'
import type { InspectEntrySummary } from '@/env.d'
import { useConsoleStore } from '@/stores/console'
import { KINDS, layerDot, summarizeOverview } from './kinds'
import { Button } from '@/components/ui/button'

/** 时刻 → HH:mm:ss.mmm（毫秒是观学习重点：分片节奏/耗时都要看得到） */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

interface RunGroup {
  run: number
  entries: InspectEntrySummary[]
}

export function ConsoleTimeline() {
  const sessionId = useConsoleStore((s) => s.sessionId)
  const entries = useConsoleStore((s) => s.entries)
  const layers = useConsoleStore((s) => s.layers)
  const selectedSeq = useConsoleStore((s) => s.selectedSeq)
  const follow = useConsoleStore((s) => s.follow)
  const setFollow = useConsoleStore((s) => s.setFollow)
  const selectEntry = useConsoleStore((s) => s.selectEntry)

  const scrollRef = useRef<HTMLDivElement>(null)

  // 过滤 + 按 run 分组（组内条目必然连续 —— seq 单调、run 号只增）
  const groups = useMemo<RunGroup[]>(() => {
    const visible = entries.filter((e) => layers[KINDS[e.kind].layer])
    const result: RunGroup[] = []
    for (const entry of visible) {
      const last = result.at(-1)
      if (last !== undefined && last.run === entry.run) last.entries.push(entry)
      else result.push({ run: entry.run, entries: [entry] })
    }
    return result
  }, [entries, layers])

  // 实时跟随：可见条目数变化且 follow 开着 → 滚到底。follow 关着（正在翻历史）
  // 不打扰；重新开启时立即回底
  const visibleCount = groups.reduce((n, g) => n + g.entries.length, 0)
  useEffect(() => {
    if (!follow) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visibleCount, follow])

  const lastEntry = entries.at(-1)
  const running = lastEntry !== undefined && !['run.completed', 'run.failed'].includes(lastEntry.kind)

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* 工具条：条数/运行态 + 跟随开关 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-4">
        <span className="text-[12px] tabular-nums text-muted-foreground">{visibleCount} 条</span>
        {running && (
          <span className="flex items-center gap-1.5 text-[12px] text-emerald-600">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            运行中
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1.5 px-2 text-[12px]"
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
        >
          {follow ? <IconArrowBarToDown className="size-[14px]" /> : <IconPlayerPause className="size-[14px]" />}
          {follow ? '实时跟随' : '已暂停'}
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {sessionId === null ? (
          <EmptyHint text="左侧选择一个会话，或去主窗口发一条消息。" />
        ) : groups.length === 0 ? (
          <EmptyHint text="暂无观测记录 —— 发送一条消息后这里会实时出现（最近记录落盘，重启应用也可回看）。控制台上线前的历史对话没有观测存档。" />
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <RunBlock
                key={`${group.run}-${group.entries[0].seq}`}
                group={group}
                selectedSeq={selectedSeq}
                onSelect={(seq) => void selectEntry(seq)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <p className="px-2 py-8 text-[13px] leading-relaxed text-muted-foreground">{text}</p>
}

/** 一个 run 的分组：头行（预览 + 状态）+ 条目行列表 */
function RunBlock({
  group,
  selectedSeq,
  onSelect,
}: {
  group: RunGroup
  selectedSeq: number | null
  onSelect: (seq: number) => void
}) {
  const started = group.entries[0]
  const preview = started.kind === 'run.started' ? started.title.replace(/^run #\d+ · /, '') : ''
  const lastKind = group.entries.at(-1)!.kind
  const status =
    lastKind === 'run.completed' ? '完成' : lastKind === 'run.failed' ? '失败' : '进行中'
  const statusClass =
    lastKind === 'run.failed' ? 'text-destructive' : status === '进行中' ? 'text-emerald-600' : 'text-muted-foreground'

  return (
    <section>
      <header className="flex items-center gap-2 px-1 pb-1.5">
        <span className="text-[13px] font-semibold">Run #{group.run}</span>
        {preview !== '' && (
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{preview}</span>
        )}
        <span className={`ml-auto flex items-center gap-1.5 text-[12px] ${statusClass}`}>
          {status === '进行中' && <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />}
          {status}
        </span>
      </header>
      <ul className="flex flex-col rounded-lg border">
        {group.entries.map((entry) => (
          <EntryRow key={entry.seq} entry={entry} selected={entry.seq === selectedSeq} onSelect={onSelect} />
        ))}
      </ul>
    </section>
  )
}

function EntryRow({
  entry,
  selected,
  onSelect,
}: {
  entry: InspectEntrySummary
  selected: boolean
  onSelect: (seq: number) => void
}) {
  const kind = KINDS[entry.kind]
  const Icon = kind.icon
  const dot = layerDot(kind.layer)
  const summary = summarizeOverview(entry)

  return (
    <li>
      <button
        type="button"
        className={`flex h-8 w-full items-center gap-2 border-b px-2.5 text-left last:border-b-0 ${
          selected ? 'bg-foreground/5' : 'hover:bg-foreground/5'
        }`}
        title={`${entry.title}${summary !== '' ? ` · ${summary}` : ''}`}
        onClick={() => void onSelect(entry.seq)}
      >
        <span className="w-[86px] shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatTime(entry.ts)}
        </span>
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <Icon className="size-[15px] shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px]">{entry.title}</span>
        {summary !== '' && (
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">{summary}</span>
        )}
      </button>
    </li>
  )
}
