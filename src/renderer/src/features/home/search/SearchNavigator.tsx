/** 消息定位在 scroller 内消费：来源映射定位节点，CSS Highlight 不改 Markdown DOM 或选区。 */
import { useEffect, useRef } from 'react'
import { ArrowUpIcon, ArrowDownIcon, XIcon } from 'lucide-react'
import { matchSearchText, searchTokens } from '@shared/search-text'
import { Button } from '@/components/ui/button'
import { useMessageScroller } from '@/components/ui/message-scroller'
import { useSearchStore } from '@/stores/search'
import { useChatStore } from '@/stores/chat'
import { EMPTY_MESSAGES } from '@/stores/chat/selectors'

/** 仅在当前来源消息的正文里建范围，按钮/统计/思考不参与原文高亮。 */
export function renderedSearchRanges(root: HTMLElement, query: string): Range[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    const parent = node.parentElement!
    if (parent.closest('[data-slot=markdown-root], [data-search-body]') !== null && parent.closest('button, [aria-hidden=true], script, style') === null) nodes.push(node as Text)
    node = walker.nextNode()
  }
  const text = nodes.map((item) => item.data).join('')
  return matchSearchText(text, searchTokens(query)).map((match) => {
    const range = document.createRange()
    let offset = 0
    for (const item of nodes) {
      if (offset <= match.start && match.start < offset + item.length) range.setStart(item, match.start - offset)
      if (offset < match.end && match.end <= offset + item.length) { range.setEnd(item, match.end - offset); break }
      offset += item.length
    }
    return range
  })
}

export function SearchNavigator() {
  const navigation = useSearchStore((state) => state.navigation)
  const target = useSearchStore((state) => state.target)
  const busy = useSearchStore((state) => state.busy)
  const error = useSearchStore((state) => state.error)
  const active = useChatStore((state) => state.activeSessionId)
  const messages = useChatStore((state) => state.bySession[state.activeSessionId ?? '']?.messages ?? EMPTY_MESSAGES)
  const scroller = useMessageScroller()
  const positioned = useRef<number | null>(null)
  useEffect(() => {
    if (target === null || navigation === null || active !== target.sessionId) return
    const message = messages.find((item) => item.type === undefined && item.sources?.some((source) => source.id === target.hit.anchor.sourceId))
    if (message === undefined || message.type !== undefined) {
      useSearchStore.setState({ error: '命中来源已变化，请重新搜索。', busy: false })
      return
    }
    const element = Array.from(document.querySelectorAll<HTMLElement>('[data-search-message]')).find((node) => node.dataset.searchMessage === message.id)
    if (element === undefined) return
    let current = true
    let frame = 0
    const highlights = CSS.highlights
    const source = message.sources!.find((item) => item.id === target.hit.anchor.sourceId)!
    const raw = matchSearchText(message.content, searchTokens(navigation.query))
    const ordinal = Math.max(0, raw.findIndex((range) => range.start >= source.start + target.hit.anchor.offset))
    const position = () => {
      if (!current || useSearchStore.getState().target !== target) return
      const viewport = element.closest<HTMLElement>('[data-slot=message-scroller-viewport]')!
      if (element.closest('[hidden]') !== null) return
      const shouldPosition = positioned.current !== target.serial
      if (shouldPosition) scroller.scrollToMessage(message.id, { align: 'center', behavior: 'instant' })
      const ranges = renderedSearchRanges(element, navigation.query)
      highlights.set('cogent-search', new Highlight(...ranges))
      const selected = ranges.at(Math.min(ordinal, ranges.length - 1))
      const rect = selected?.getBoundingClientRect() ?? element.getBoundingClientRect()
      if (shouldPosition) {
        viewport.scrollTo({ top: viewport.scrollTop + rect.top - viewport.getBoundingClientRect().top - viewport.clientHeight / 2, behavior: 'instant' })
        const transitionRoot = element.closest('[data-slot=trace-collapsible]') ?? element
        if (!transitionRoot.getAnimations({ subtree: true }).some((animation) => animation instanceof CSSTransition && animation.playState === 'running')) positioned.current = target.serial
      }
      useSearchStore.setState({ error: ranges.length === 0 ? '已定位消息；匹配位于原始文本或附件名称中。' : null })
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position) }
    const observer = new MutationObserver(schedule)
    observer.observe(element.closest('[data-slot=trace-collapsible]') ?? element, { attributes: true, childList: true, subtree: true })
    const container = element.closest<HTMLElement>('[data-slot=trace-collapsible]') ?? element
    container.addEventListener('transitionend', schedule)
    schedule()
    return () => { current = false; cancelAnimationFrame(frame); observer.disconnect(); container.removeEventListener('transitionend', schedule); highlights.delete('cogent-search') }
  }, [target, navigation, active, messages, scroller])
  if (navigation === null || navigation.sessionId !== active) return error === null ? null : <div role="status" className="px-4 py-2">{error}</div>
  return <div className="flex flex-wrap items-center gap-2 px-4 py-2" role="region" aria-label="聊天搜索命中">
    <span className="min-w-0 flex-1 truncate">{navigation.query} · {navigation.index + 1}/{navigation.hits.length}{navigation.cursor === undefined ? '' : '+'}</span>
    <Button variant="ghost" size="icon-sm" aria-label="上一个命中" disabled={busy} onClick={() => { void useSearchStore.getState().move(-1) }}><ArrowUpIcon /></Button>
    <Button variant="ghost" size="icon-sm" aria-label="下一个命中" disabled={busy} onClick={() => { void useSearchStore.getState().move(1) }}><ArrowDownIcon /></Button>
    <Button variant="ghost" size="icon-sm" aria-label="关闭搜索高亮" onClick={() => useSearchStore.getState().clear()}><XIcon /></Button>
    {error !== null && <span role="status">{error}</span>}
  </div>
}
