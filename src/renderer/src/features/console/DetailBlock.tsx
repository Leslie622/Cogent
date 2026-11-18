/** 数据块的标题、动作统一在一行；查看器仅承载正文，原文与复制共用留存字符串。 */
import { lazy, Suspense, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { InspectEntryDetail } from '@/env.d'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { DetailSection } from './DetailSection'

const InspectCodeViewer = lazy(() => import('@/components/InspectCodeViewer'))

export function DetailBlock({ block }: { block: InspectEntryDetail['blocks'][number] }) {
  const [raw, setRaw] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [copyState, setCopyState] = useState<string | null>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.content)
      setCopyState('已复制留存原文')
    } catch (error) {
      setCopyState(`复制失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const title = block.name.split('（')[0]
  return <Suspense fallback={<p>正在加载{title}…</p>}>
    <InspectCodeViewer content={block.content} format={block.format} label={block.name} raw={raw} wrap={wrap} render={(controls, body) => (
      <DetailSection title={title} actions={<div className="flex flex-wrap items-center">
        {controls}
        <Button variant="disclosure" size="console" onClick={() => void copy()}>复制</Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="disclosure" size="console" aria-label={`${title}更多选项`} />}><MoreHorizontal /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{block.format.toUpperCase()} · {block.content.length.toLocaleString()} 字符 · {block.content.split('\n').length.toLocaleString()} 行</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={raw} onCheckedChange={setRaw}>原文</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>自动换行</DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}>
        {copyState !== null && <p role="status" className="py-2 break-words">{copyState}</p>}
        {block.content.includes('…[已截断，原始 ') && <p className="py-2 text-warning">此块已在采集时截断；当前展示与复制仅包含留存部分。</p>}
        <div title={block.name} className="mt-2 overflow-hidden rounded-lg bg-muted/40">{body}</div>
      </DetailSection>
    )} />
  </Suspense>
}
