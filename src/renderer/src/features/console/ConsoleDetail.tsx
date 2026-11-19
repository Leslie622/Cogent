/** 详情以单一纵向滚动容器承载原文；记录信息集中收纳，避免装饰和嵌套滚动抢正文空间。 */
import { useConsoleStore } from '@/stores/console'
import { KINDS } from './kinds'
import { DetailSection } from './DetailSection'
import { DetailBlock } from './DetailBlock'
import { Table, TableBody, TableCell, TableHead, TableRow } from '@/components/ui/table'

export function ConsoleDetail() {
  const entries = useConsoleStore((s) => s.entries)
  const selectedSeq = useConsoleStore((s) => s.selectedSeq)
  const details = useConsoleStore((s) => s.details)
  const detailError = useConsoleStore((s) => s.detailError)
  const sessionId = useConsoleStore((s) => s.sessionId)
  const entry = entries.find((e) => e.seq === selectedSeq)

  if (entry === undefined) return <p className="px-4 py-8 text-sm text-muted-foreground">点击左侧时间线条目，这里展示它的底层详情。</p>

  const kind = KINDS[entry.kind]
  const detail = details[entry.seq]
  const overview = entry.overview ?? []

  return <div key={`${sessionId}-${entry.seq}`} data-console-detail-scroll className="h-full min-h-0 space-y-5 overflow-auto overscroll-contain px-5 py-4 text-sm leading-normal">
    <h3 className="break-words font-semibold">{entry.title}</h3>

    <DetailSection title="记录信息" defaultOpen={!entry.hasDetail}>
      <Table aria-label="记录信息" variant="inspect" className="table-fixed">
        <TableBody>
        {[
          { label: '记录', value: `#${entry.seq} · Run #${entry.run}` },
          { label: '类别', value: kind.label },
          { label: '事件', value: entry.kind },
          { label: '时间', value: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }) },
          { label: '时间戳', value: `${entry.ts} ms` },
          ...overview,
        ].map((row) => <TableRow key={row.label}>
          <TableHead scope="row" className="w-28">{row.label}</TableHead>
          <TableCell className="break-words whitespace-normal tabular-nums">{row.value}</TableCell>
        </TableRow>)}
        </TableBody>
      </Table>
      <p className="px-2 py-3 leading-relaxed">{kind.explain}</p>
    </DetailSection>

    {detailError !== null && <p role="alert" className="py-4 leading-relaxed text-destructive">{detailError}</p>}
    {!entry.hasDetail && detailError === null && <p className="py-4">该条目没有详情数据（概览即全部）。</p>}
    {entry.hasDetail && detail === undefined && detailError === null && <p className="py-4">详情拉取中…</p>}
    {detail !== undefined && <div className="space-y-5 pb-4">
      {detail.blocks.map((block) => <DetailBlock key={block.name} block={block} />)}
    </div>}
  </div>
}
