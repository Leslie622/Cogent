/** 壳层常驻搜索入口；查询身份约束迟到响应，Command 只负责键盘与列表呈现。 */
import { useEffect, useRef, useState } from 'react'
import { MessageSquareIcon } from 'lucide-react'
import type { SearchPage } from '@shared/session-search'
import { Command, CommandDialog, CommandInput, CommandList, CommandGroup, CommandItem } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useSearchStore } from '@/stores/search'
import { useProjectStore } from '@/stores/project'
import { useChatStore } from '@/stores/chat'
import { unwrapIpcError } from '@/lib/ipc'
import { SearchHighlight } from './SearchHighlight'

export function SessionSearch() {
  const open = useSearchStore((state) => state.open)
  const setOpen = useSearchStore((state) => state.setOpen)
  const selecting = useSearchStore((state) => state.busy)
  const navigationError = useSearchStore((state) => state.error)
  const projects = useProjectStore((state) => state.projects)
  const summaries = useChatStore((state) => state.sessions)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<SearchPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [composing, setComposing] = useState(false)
  const identity = useRef(0)
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || event.altKey || event.shiftKey) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !(event.target instanceof Element && event.target.closest('.cm-editor'))) {
        event.preventDefault(); setOpen(!useSearchStore.getState().open)
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [setOpen])
  useEffect(() => {
    const current = ++identity.current
    if (!open || composing) return
    setLoading(true); setPage(undefined); setError(undefined)
    const timer = setTimeout(() => {
      void window.cogent.engineRequest('session.search', { query }).then((result) => {
        if (identity.current === current) { setPage(result); setLoading(false) }
      }, (cause: unknown) => { if (identity.current === current) { setError(unwrapIpcError(cause)); setLoading(false) } })
    }, query.trim() === '' ? 0 : 180)
    return () => { clearTimeout(timer); identity.current++ }
  }, [open, query, composing, revision, summaries])
  const more = async () => {
    const current = identity.current
    setLoading(true)
    try {
      const result = await window.cogent.engineRequest('session.search', { query, cursor: page!.nextCursor })
      if (identity.current !== current) return
      setPage((previous) => ({ ...result, items: [...previous!.items, ...result.items] }))
    } catch (cause) { if (identity.current === current) setError(unwrapIpcError(cause)) }
    finally { if (identity.current === current) setLoading(false) }
  }
  return <CommandDialog open={open} onOpenChange={setOpen} title="搜索聊天" description="搜索聊天标题和正文，选择结果打开原消息。" size="search">
    <Command label="搜索聊天" shouldFilter={false} loop onKeyDownCapture={(event) => {
      if ((composing || event.nativeEvent.isComposing) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation() }
    }}>
      <CommandInput aria-label="搜索聊天" placeholder="搜索标题或聊天正文…" value={query} maxLength={500}
        onValueChange={setQuery} autoFocus
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
      <div className="relative min-h-0 flex-1">
        {loading && <div className="absolute inset-0 grid place-items-center"><Spinner aria-label="正在搜索" className="size-6" /></div>}
        <CommandList layout="fill" hidden={loading} aria-busy={loading}>
        {(error !== undefined || navigationError !== null) && <div role="alert" className="p-3">
          {error ?? navigationError}
          <div className="flex gap-2 pt-2"><Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>重试</Button>
            <Button variant="ghost" size="sm" onClick={() => { void window.cogent.engineRequest('session.search.rebuild', {}).then(() => setRevision((value) => value + 1), (cause: unknown) => setError(unwrapIpcError(cause))) }}>重建索引</Button></div>
        </div>}
        {page !== undefined && page.issues.length > 0 && <div role="status" className="p-3">部分聊天读取失败，结果不完整。{page.issues.map((issue) => <p key={issue.sessionId}>{issue.message}</p>)}</div>}
        {!loading && error === undefined && page?.items.length === 0 && <div role="status" className="pointer-events-none absolute inset-0 grid place-items-center">{query.trim() === '' ? '还没有聊天' : '没有找到匹配的聊天'}</div>}
        {page !== undefined && page.items.length > 0 && <CommandGroup heading="聊天">
          {page.items.map((item) => {
          const projectName = projects.find((project) => project.id === item.session.projectId)?.name
          const hit = item.hits.at(0)
          return <CommandItem key={item.session.id} variant="search" value={`session:${item.session.id}`} disabled={selecting || loading} onSelect={() => { void useSearchStore.getState().select(item, query, hit) }}>
            <MessageSquareIcon />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate"><SearchHighlight text={item.session.title} ranges={item.titleRanges} /></span>
                {projectName !== undefined && <span className="text-xs max-w-1/2 truncate">{projectName}</span>}
              </div>
              {hit !== undefined && <div className="truncate"><SearchHighlight text={hit.snippet} ranges={hit.ranges} /></div>}
            </div>
          </CommandItem>
        })}</CommandGroup>}
        {page?.nextCursor !== undefined && <CommandItem variant="search" value="next-page" disabled={loading} onSelect={() => { void more() }}>更多结果</CommandItem>}
        </CommandList>
      </div>
      <div className="text-xs text-muted-foreground shrink-0 p-2">↑ ↓ 选择 · Enter 打开 · Esc 关闭</div>
    </Command>
  </CommandDialog>
}
