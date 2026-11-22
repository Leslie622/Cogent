/** DOCX 以独立离屏根排版后提交；第三方解析不可取消，旧代次始终只能清理自己的 DOM。 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { renderAsync, type Options } from 'docx-preview'
import { Button } from '@/components/ui/button'
import { useFilePreviewStore, type FileViewState } from '@/stores/file-preview'
import { installDocumentLinks } from './links'
import { useVisualScroll } from './use-visual-scroll'
import type { VisualPreviewProps } from './types'

const LegacyDocPreview = lazy(() => import('./LegacyDocPreview'))
const DOCX_OPTIONS = {
  breakPages: true, experimental: true,
  ignoreFonts: false, ignoreHeight: false, ignoreWidth: false,
  // 0.4.0 的此默认值保留独立 section 及其 pgMar，不能为了额外分页合并同尺寸页面。
  ignoreLastRenderedPageBreak: true,
  inWrapper: true, renderAltChunks: false, renderChanges: false, renderComments: false,
  renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
  useBase64URL: true, debug: false,
} satisfies Partial<Options>
interface RenderedDocument { buffer: ArrayBuffer; pages: HTMLElement[] }
interface NaturalSize { width: number; height: number; available: number }

export default function DocxPreview(props: VisualPreviewProps) {
  return /\.doc$/i.test(props.name)
    ? <Suspense fallback={<div aria-busy="true" />}><LegacyDocPreview {...props} /></Suspense>
    : <ModernDocxPreview {...props} />
}

function ModernDocxPreview(props: VisualPreviewProps) {
  const { buffer, name, tabId, active } = props
  const latest = useRef(props); latest.current = props
  const [requested, setRequested] = useState<ArrayBuffer | null>(active ? buffer : null)
  const [rendered, setRendered] = useState<RenderedDocument | null>(null)
  const [failure, setFailure] = useState<{ buffer: ArrayBuffer; message: string } | null>(null)
  const [natural, setNatural] = useState<NaturalSize>({ width: 0, height: 0, available: 0 })
  const host = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const ready = rendered?.buffer === buffer
  const saved = useFilePreviewStore((state): FileViewState | undefined => state.views[tabId])
  const zoom = saved?.zoom ?? null
  const fit = natural.width > 0 && natural.available > 0 ? Math.min(1, natural.available / natural.width) : 1
  const scale = zoom ?? fit
  const scroll = useVisualScroll(tabId, active, ready)
  const runtime = useRef({ rendered, scale }); runtime.current = { rendered, scale }

  useEffect(() => { if (active) setRequested(buffer) }, [active, buffer])
  useEffect(() => {
    if (requested === null) return
    let current = true
    let removeLinks: (() => void) | undefined
    const container = host.current!
    const root = document.createElement('div')
    const styles = document.createElement('div'), body = document.createElement('div')
    const className = 'cogent-docx-' + crypto.randomUUID()
    root.dataset.docxDocument = className
    root.append(styles, body)
    const clear = (): void => { body.replaceChildren(); styles.replaceChildren(); root.replaceChildren(); root.remove() }
    container.replaceChildren()
    setRendered(null); setFailure(null)
    void renderAsync(requested, body, styles, { ...DOCX_OPTIONS, className }).then(() => {
      if (!current || latest.current.buffer !== requested) { clear(); return }
      const wrapper = body.querySelector<HTMLElement>('.' + className + '-wrapper')
      if (wrapper !== null) {
        wrapper.style.padding = '0'
        wrapper.style.background = 'transparent'
        wrapper.style.width = 'max-content'
      }
      removeLinks = installDocumentLinks(root, url => latest.current.onOpenUrl(url))
      container.replaceChildren(root)
      setRendered({ buffer: requested, pages: [...body.querySelectorAll<HTMLElement>('section.' + className)] })
    }).catch((error: unknown) => {
      clear()
      if (current && latest.current.buffer === requested) {
        setFailure({ buffer: requested, message: error instanceof Error ? error.message : String(error) })
      }
    })
    return () => {
      current = false
      removeLinks?.()
      clear()
    }
  }, [requested])

  useLayoutEffect(() => {
    if (!active || !ready) return
    let current = true
    const viewport = scroll.ref.current!, paper = content.current!
    const measure = (): void => {
      if (!current || viewport.clientWidth === 0 || paper.offsetWidth === 0 || paper.offsetHeight === 0) return
      const next = { width: paper.offsetWidth, height: paper.offsetHeight, available: viewport.clientWidth - 24 }
      setNatural(previous => previous.width === next.width && previous.height === next.height && previous.available === next.available ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport); observer.observe(paper)
    // 嵌入字体被样式加入后才会开始加载；字体就绪须按真实尺寸重新适配，而非沿用占位字体宽度。
    const fonts = (document as Partial<Pick<Document, 'fonts'>>).fonts
    if (fonts !== undefined) void fonts.ready.then(measure, measure)
    return () => { current = false; observer.disconnect() }
  }, [active, ready, rendered, scroll.ref])

  useLayoutEffect(() => {
    if (!active || !ready) return
    scroll.restore()
  }, [active, ready, scale, natural.height, scroll.restore])

  const saveScroll = (): void => {
    scroll.onScroll()
    const state = runtime.current
    if (!active || state.rendered?.buffer !== buffer) return
    const viewport = scroll.ref.current!
    const top = viewport.getBoundingClientRect().top
    const pages = state.rendered.pages
    const index = pages.findIndex(page => page.getBoundingClientRect().bottom > top + 1)
    if (index >= 0) useFilePreviewStore.getState().setView(tabId, { page: index + 1 })
  }
  const pageCount = ready ? rendered.pages.length : 0
  const page = Math.min(Math.max(1, saved?.page ?? 1), Math.max(1, pageCount))
  const navigate = (target: number): void => {
    const viewport = scroll.ref.current!, paper = rendered!.pages[target - 1]
    viewport.scrollTop += paper.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    useFilePreviewStore.getState().setView(tabId, { page: target })
    scroll.onScroll()
  }
  const setZoom = (value: number | null): void => useFilePreviewStore.getState().setView(tabId, { zoom: value })
  const error = failure?.buffer === buffer ? failure.message : null
  return <div className="flex h-full min-h-0 min-w-0 flex-col" data-visual-docx aria-label={name} aria-busy={!ready && error === null}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 p-2">
      <Button variant="ghost" size="sm" disabled={!ready || page <= 1} onClick={() => navigate(page - 1)}>上一页</Button>
      <span className="text-xs" aria-label="文档页码">{page} / {pageCount || '…'}</span>
      <Button variant="ghost" size="sm" disabled={!ready || page >= pageCount} onClick={() => navigate(page + 1)}>下一页</Button>
      <Button variant="ghost" size="sm" onClick={() => setZoom(Math.max(0.1, scale - 0.25))}>缩小</Button>
      <Button variant="ghost" size="sm" onClick={() => setZoom(null)}>适配</Button>
      <Button variant="ghost" size="sm" onClick={() => setZoom(Math.min(4, scale + 0.25))}>放大</Button>
    </div>
    {error !== null && <p role="alert" className="break-words p-3 text-sm">无法预览 {name}：{error}</p>}
    <div ref={scroll.ref} onScroll={saveScroll} className="min-h-0 min-w-0 flex-1 overflow-auto p-3" aria-hidden={!ready}>
      <div className="relative mx-auto" data-docx-scaled-frame style={ready && natural.width > 0 ? { width: natural.width * scale, height: natural.height * scale } : undefined}>
        <div ref={content} data-docx-content className="w-max select-text" style={ready && natural.width > 0 ? { position: 'absolute', left: 0, top: 0, transform: `scale(${scale})`, transformOrigin: 'top left' } : undefined}>
          <div ref={host} />
        </div>
      </div>
    </div>
  </div>
}
