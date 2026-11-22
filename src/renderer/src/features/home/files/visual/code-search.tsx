/** 源码搜索使用 Nova 控件；与代码渲染器分离，避免控件排版进入 Shadow DOM。 */
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CodeSearchQuery } from './code-text'

export function CodeSearch({ query, onChange, count, index, truncated, error, onMove, onClose }: {
  query: CodeSearchQuery; onChange: (query: CodeSearchQuery) => void
  count: number; index: number; truncated: boolean; error: string | null
  onMove: (direction: number) => void; onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current!.focus(); input.current!.select() }, [])
  return <div className="flex flex-wrap items-center gap-2 px-3 pb-2" role="search" aria-label="源码搜索">
    <Input ref={input} className="w-52" aria-label="搜索源码" value={query.search} aria-invalid={error !== null} onChange={event => onChange({ ...query, search: event.target.value })}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); onMove(event.shiftKey ? -1 : 1) }
        if (event.key === 'Escape') onClose()
      }} />
    <Button variant="ghost" size="sm" aria-label="区分大小写" aria-pressed={query.caseSensitive} onClick={() => onChange({ ...query, caseSensitive: !query.caseSensitive })}>Aa</Button>
    <Button variant="ghost" size="sm" aria-label="全字匹配" aria-pressed={query.wholeWord} onClick={() => onChange({ ...query, wholeWord: !query.wholeWord })}>全字</Button>
    <Button variant="ghost" size="sm" aria-label="正则表达式" aria-pressed={query.regexp} onClick={() => onChange({ ...query, regexp: !query.regexp })}>.*</Button>
    <Button variant="ghost" size="sm" aria-label="上一个匹配" disabled={count === 0 || error !== null} onClick={() => onMove(-1)}>上一个</Button>
    <Button variant="ghost" size="sm" aria-label="下一个匹配" disabled={count === 0 || error !== null} onClick={() => onMove(1)}>下一个</Button>
    <span role="status" className="text-xs">{error !== null ? `搜索表达式无效：${error}` : `${index < 0 ? 0 : index + 1} / ${count}${truncated ? '+' : ''}`}</span>
    <Button variant="ghost" size="sm" aria-label="关闭搜索" onClick={onClose}>关闭</Button>
  </div>
}
