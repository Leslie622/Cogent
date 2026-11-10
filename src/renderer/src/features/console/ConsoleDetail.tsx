/**
 * 观测详情面板：选中条目的完整解剖 —— 类型徽标 + "这是什么"学习注释 +
 * 概览键值表 + 数据块（请求体 JSON / 分片 NDJSON / 提示词全文…）。
 * 详情按需拉取（inspect.entry），拉过即缓存；内容区放开文本选择（学习材料要能复制）。
 */
import { useConsoleStore } from '@/stores/console'
import { KINDS } from './kinds'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function ConsoleDetail() {
  const entries = useConsoleStore((s) => s.entries)
  const selectedSeq = useConsoleStore((s) => s.selectedSeq)
  const details = useConsoleStore((s) => s.details)
  const detailError = useConsoleStore((s) => s.detailError)

  const entry = entries.find((e) => e.seq === selectedSeq)

  if (entry === undefined) {
    return (
      <PanelShell>
        <p className="px-2 py-8 text-[13px] leading-relaxed text-muted-foreground">
          点击左侧时间线条目，这里展示它的底层详情。
        </p>
      </PanelShell>
    )
  }

  const kind = KINDS[entry.kind]
  const Icon = kind.icon
  const detail = details[entry.seq]

  return (
    <PanelShell>
      {/* 头两行：徽标 + 时刻一行，标题独立一行（视觉评审：挤一行会截断） */}
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {kind.label}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatTime(entry.ts)}
        </span>
      </div>
      <h3 className="mt-2 break-all text-sm font-semibold">{entry.title}</h3>

      {/* 学习注释：这条记录对应引擎里发生了什么 */}
      <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
        {kind.explain}
      </p>

      {/* 概览键值表 */}
      {entry.overview !== undefined && entry.overview.length > 0 && (
        <dl className="mt-4 divide-y rounded-lg border">
          {entry.overview.map((row) => (
            <div key={row.label} className="flex items-baseline gap-3 px-3 py-1.5">
              <dt className="w-24 shrink-0 text-[12px] text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 break-all text-[13px] tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* 数据块 */}
      {detailError !== null && (
        <p className="mt-4 rounded-lg border border-destructive/30 px-3 py-2.5 text-[12px] leading-relaxed text-destructive">
          {detailError}
        </p>
      )}
      {!entry.hasDetail && detailError === null && (
        <p className="mt-4 text-[12px] text-muted-foreground">该条目没有详情数据（概览即全部）。</p>
      )}
      {entry.hasDetail && detail === undefined && detailError === null && (
        <p className="mt-4 text-[12px] text-muted-foreground">详情拉取中…</p>
      )}
      {detail !== undefined && (
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
          {detail.blocks.map((block) => (
            <section key={block.name} className="flex min-h-0 flex-1 flex-col">
              <span className="mb-1.5 text-[12px] font-medium text-muted-foreground">{block.name}</span>
              <pre className="min-h-24 flex-1 select-text overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
                {block.content}
              </pre>
            </section>
          ))}
        </div>
      )}
    </PanelShell>
  )
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-3">{children}</div>
}
