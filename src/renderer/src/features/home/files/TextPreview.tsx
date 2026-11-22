/** 源码预览以 Pierre File + Virtualizer 渲染；原文坐标、搜索与阅读状态由标签持有。 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { File, Virtualizer, type FileOptions } from '@pierre/diffs/react'
import type { FileLocation } from '@shared/files'
import { useIsDarkMode } from '@/stores/appearance'
import { useFilePreviewStore } from '@/stores/file-preview'
import { CodeSearch } from './visual/code-search'
import { codeDocument, codeLineAt, codeLocation, EMPTY_CODE_QUERY, findCodeMatches, type CodeSearchQuery } from './visual/code-text'
import { useCodeView } from './visual/code-view'

interface TextPreviewProps { text: string; name: string; location?: FileLocation; tabId?: string; active?: boolean }

export default function TextPreview(props: TextPreviewProps) {
  // 内容版本变化重新创建行模型；隐藏/明暗切换保留 File 实例。
  const identity = useMemo(() => crypto.randomUUID(), [props.text, props.name, props.tabId])
  return <CodeDocument key={identity} {...props} />
}

function CodeDocument({ text, name, location, tabId, active = true }: TextPreviewProps) {
  const source = useMemo(() => codeDocument(text), [text])
  // Pierre的扩展名表不含svg；它的源码是XML，显式指定才能获得与文档源码相同的高亮。
  const file = useMemo(() => ({ name, contents: source.contents, ...(/\.svg$/i.test(name) ? { lang: 'xml' as const } : {}) }), [name, source])
  const dark = useIsDarkMode()
  const highlightName = 'cogent-code-' + useId().replace(/[^a-zA-Z0-9-]/g, '')
  const [query, setQuery] = useState<CodeSearchQuery>(() => {
    const saved = tabId === undefined ? undefined : useFilePreviewStore.getState().views[tabId]
    return saved?.searchQuery ?? EMPTY_CODE_QUERY
  })
  const [searchOpen, setSearchOpen] = useState(false)
  const [matchIndex, setMatchIndex] = useState(-1)
  const [status, setStatus] = useState<string | null>(null)
  const result = useMemo(() => findCodeMatches(text, query), [text, query])
  const view = useCodeView(source, tabId, active, query, result.matches, highlightName)
  const { choose, hasSavedSelection } = view
  const firstLocation = useRef(true)
  const locationKey = location === undefined ? '' : `${location.line}:${location.column ?? 1}:${location.endLine ?? ''}`

  useEffect(() => {
    setStatus(null)
    if (location === undefined) return
    if (firstLocation.current && hasSavedSelection) { firstLocation.current = false; return }
    firstLocation.current = false
    const result = codeLocation(source, location)
    if ('warning' in result) setStatus(result.warning)
    else { choose(result.selection); setStatus(result.status) }
    // 相同定位的新对象不重置用户阅读位置。
  }, [source, locationKey, choose, hasSavedSelection])

  const move = useCallback((direction: number) => {
    if (result.matches.length === 0) return
    let next: number
    if (matchIndex < 0) {
      const after = result.matches.findIndex(match => match.from >= Math.min(view.selection.anchor, view.selection.head))
      next = direction > 0 ? (after < 0 ? 0 : after) : (after < 0 ? result.matches.length - 1 : (after - 1 + result.matches.length) % result.matches.length)
    } else next = (matchIndex + direction + result.matches.length) % result.matches.length
    const match = result.matches[next]
    setMatchIndex(next)
    choose({ anchor: match.from, head: match.to })
  }, [result.matches, matchIndex, view.selection, choose])
  const changeQuery = (next: CodeSearchQuery) => { setQuery(next); setMatchIndex(-1) }
  const options = useMemo<FileOptions<undefined>>(() => ({
    disableFileHeader: true,
    disableLineNumbers: false,
    overflow: 'wrap',
    theme: { light: 'pierre-light', dark: 'pierre-dark' },
    themeType: dark ? 'dark' : 'light',
    preferredHighlighter: 'shiki-wasm',
    tokenizeMaxLineLength: 1000,
    useTokenTransformer: false,
    onPostRender: view.postRender,
    unsafeCSS: `:host { --diffs-gap-block: 0px; } ::highlight(${highlightName}) { background-color: Mark; color: MarkText; } ::highlight(${highlightName}-selection) { background-color: Highlight; color: HighlightText; }`
  }), [dark, highlightName, view.postRender])
  const style = useMemo<CSSProperties>(() => ({ colorScheme: dark ? 'dark' : 'light' }), [dark])
  const selectedLines = useMemo(() => {
    const from = Math.min(view.selection.anchor, view.selection.head), to = Math.max(view.selection.anchor, view.selection.head)
    return { start: codeLineAt(source, from) + 1, end: codeLineAt(source, to > from ? to - 1 : to) + 1 }
  }, [source, view.selection])

  return <div className="flex h-full min-h-0 flex-col select-text" data-code-preview onKeyDown={event => {
    if (active && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true) }
  }}>
    {status !== null && <p role="status" className="px-3 py-2 text-xs">{status}</p>}
    {searchOpen && active && <CodeSearch query={query} onChange={changeQuery} count={result.matches.length} index={matchIndex} truncated={result.truncated} error={result.error} onMove={move} onClose={() => setSearchOpen(false)} />}
    <div ref={view.container} className="code-typography min-h-0 flex-1">
      <Virtualizer className="h-full overflow-auto" contentClassName="min-h-full">
        <File key={view.lineHeight} file={file} options={options} metrics={view.metrics} selectedLines={selectedLines} className="min-h-full" style={style} />
      </Virtualizer>
    </div>
  </div>
}
