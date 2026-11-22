/** PPTX只在独立leaf里交第三方绘制；隐藏释放页资源，懒页模型与本tab阅读状态继续保留。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import { renderSlide } from '@aiden0z/pptx-renderer/browser'
import type { PresentationData, SlideHandle } from '@aiden0z/pptx-renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useFilePreviewStore, type FileViewState } from '@/stores/file-preview'
import { documentUrl, installDocumentLinks } from './links'
import { disposePptxSlide, openPptxPresentation, PPTX_MAX_ZOOM, PPTX_MIN_ZOOM, PPTX_ZOOM_STEP } from './pptx-engine'
import type { VisualPreviewProps } from './types'
import { useVisualScroll } from './use-visual-scroll'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export default function PptxPreview({ buffer, name, tabId, active, onOpenUrl }: VisualPreviewProps) {
  const saved = useFilePreviewStore<FileViewState | undefined>(state => state.views[tabId])
  const [loaded, setLoaded] = useState<{ buffer: ArrayBuffer; presentation: PresentationData } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [pageInput, setPageInput] = useState(String(saved?.page ?? 1))
  const [size, setSize] = useState({ width: 0, height: 0 })
  const mount = useRef<HTMLDivElement>(null)
  const currentOpenUrl = useRef(onOpenUrl); currentOpenUrl.current = onOpenUrl
  const { ref: viewport, onScroll, restore } = useVisualScroll(tabId, active, ready)
  const presentation = loaded?.buffer === buffer ? loaded.presentation : null
  const pageCount = presentation?.slides.length ?? 0
  const page = Math.min(Math.max(1, saved?.page ?? 1), Math.max(1, pageCount))
  // views.zoom与图片/PDF共用倍率语义；PPTX的100%表示Zcode的适配比例。
  const zoomPercent = Math.min(PPTX_MAX_ZOOM, Math.max(PPTX_MIN_ZOOM, Math.round((saved?.zoom ?? 1) * 100)))
  const measurable = size.width > 0 && size.height > 0
  const scale = presentation === null || !measurable ? 1 : Math.min(Math.max(1, size.width - 32) / presentation.width, Math.max(1, size.height - 32) / presentation.height) * zoomPercent / 100

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setLoadError(null)
    setRenderError(null)
    setWarning(null)
    setReady(false)
    void openPptxPresentation(buffer).then(presentation => {
      if (!cancelled) setLoaded({ buffer, presentation })
    }, error => { if (!cancelled) setLoadError(message(error)) })
    // ZIP解析没有公开取消API；迟到模型只能解除引用，不能提交到下一份buffer。
    return () => { cancelled = true }
  }, [buffer])

  useLayoutEffect(() => {
    if (!active) return
    const element = viewport.current!
    const measure = () => { if (element.clientWidth > 0 && element.clientHeight > 0) setSize({ width: element.clientWidth, height: element.clientHeight }) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active, viewport])

  const goToPage = useCallback((target: number) => {
    const next = Math.min(Math.max(1, Math.round(target)), Math.max(1, pageCount))
    useFilePreviewStore.getState().setView(tabId, { page: next, scrollTop: 0, scrollLeft: 0 })
    setPageInput(String(next))
  }, [pageCount, tabId])
  useEffect(() => { setPageInput(String(page)) }, [page])

  useEffect(() => {
    setReady(false)
    if (!active || presentation === null || pageCount === 0 || !measurable) return
    const element = mount.current!
    let cancelled = false
    let handle: SlideHandle | undefined
    const showError = (error: unknown) => { if (!cancelled) setRenderError(message(error)) }
    const showWarning = (error: unknown) => { if (!cancelled) setWarning(message(error)) }
    const onResourceError = (event: Event) => {
      if (event.target instanceof Element && ['img', 'image', 'audio', 'video'].includes(event.target.tagName.toLowerCase())) showWarning('部分图片或媒体未能加载')
    }
    const resetInternalScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target !== element && (event.target.scrollTop !== 0 || event.target.scrollLeft !== 0)) { event.target.scrollTop = 0; event.target.scrollLeft = 0 }
    }
    const offLinks = installDocumentLinks(element, url => currentOpenUrl.current(url))
    element.addEventListener('error', onResourceError, true)
    element.addEventListener('scroll', resetInternalScroll, true)
    setRenderError(null)
    setWarning(null)
    try {
      handle = renderSlide(presentation, presentation.slides[page - 1], {
        pdfjs: {
          moduleUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/pdf.min.mjs', window.location.href).href,
          workerUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/pdf.worker.min.mjs', window.location.href).href
        },
        onNavigate: target => {
          if (cancelled) return
          if (target.slideIndex !== undefined) goToPage(target.slideIndex + 1)
          else if (target.url !== undefined) { const url = documentUrl(target.url); if (url !== null) currentOpenUrl.current(url) }
        },
        onNodeError: (_nodeId, error) => showWarning(error)
      })
      element.append(handle.element)
      void handle.ready.then(() => {
        if (cancelled) return
        setReady(true)
        return document.fonts.ready.then(() => { if (!cancelled) restore() })
      }).catch(showError)
    } catch (error) { showError(error) }
    return () => {
      cancelled = true
      setReady(false)
      offLinks()
      element.removeEventListener('error', onResourceError, true)
      element.removeEventListener('scroll', resetInternalScroll, true)
      if (handle !== undefined) disposePptxSlide(handle)
      element.replaceChildren()
    }
  }, [active, presentation, page, pageCount, measurable, goToPage, restore])

  const commitPage = () => {
    const parsed = Number.parseInt(pageInput.trim(), 10)
    if (Number.isNaN(parsed)) setPageInput(String(page))
    else goToPage(parsed)
  }
  const setZoom = (percent: number) => useFilePreviewStore.getState().setView(tabId, { zoom: Math.min(PPTX_MAX_ZOOM, Math.max(PPTX_MIN_ZOOM, percent)) / 100 })
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable)) return
    if (pageCount === 0) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); goToPage(page + (event.key === 'ArrowLeft' ? -1 : 1)) }
  }
  const error = loadError ?? renderError
  return <div className="flex h-full min-h-0 flex-col" tabIndex={0} onKeyDown={onKeyDown} aria-label={'PPTX 幻灯片：' + name} data-pptx-preview data-pptx-ready={active && ready}>
    {error !== null && <p role="alert" className="shrink-0 px-3 py-2 text-sm text-destructive">无法预览幻灯片：{error}</p>}
    {warning !== null && <p role="status" className="shrink-0 px-3 py-2 text-xs text-muted-foreground">部分内容未能呈现：{warning}</p>}
    <div ref={viewport} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto" data-pptx-viewport>
      {presentation === null ? error === null && <p role="status" className="p-3 text-sm text-muted-foreground">正在解析幻灯片…</p> : pageCount === 0 ? <p className="p-3 text-sm text-muted-foreground">此演示文稿没有幻灯片</p> : <div className="grid min-h-full min-w-full place-items-center p-4">
        <div className="relative shrink-0 overflow-hidden bg-white [&_*]:[scrollbar-width:none] [&_*::-webkit-scrollbar]:hidden" style={{ width: presentation.width * scale, height: presentation.height * scale }} data-pptx-slide data-pptx-page={page} data-pptx-scale={scale}>
          <div className="absolute top-0 left-0 origin-top-left" style={{ width: presentation.width, height: presentation.height, transform: `scale(${scale})` }}><div ref={mount} data-pptx-surface /></div>
        </div>
      </div>}
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-t px-2 py-1.5" aria-label="幻灯片控件">
      <Button variant="ghost" size="icon-sm" aria-label="上一张幻灯片" disabled={pageCount === 0 || page <= 1} onClick={() => goToPage(page - 1)}><ChevronLeft /></Button>
      <Input className="w-14 text-center" aria-label="幻灯片页码" inputMode="numeric" value={pageInput} disabled={pageCount === 0} onChange={event => setPageInput(event.target.value)} onBlur={commitPage} onKeyDown={event => { if (event.key === 'Enter') { commitPage(); event.currentTarget.blur() } }} />
      <span className="text-xs tabular-nums text-muted-foreground">/ {pageCount}</span>
      <Button variant="ghost" size="icon-sm" aria-label="下一张幻灯片" disabled={pageCount === 0 || page >= pageCount} onClick={() => goToPage(page + 1)}><ChevronRight /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="缩小幻灯片" disabled={pageCount === 0 || zoomPercent <= PPTX_MIN_ZOOM} onClick={() => setZoom(zoomPercent - PPTX_ZOOM_STEP)}><ZoomOut /></Button>
      <Button variant="ghost" size="sm" aria-label="适配幻灯片" disabled={pageCount === 0} onClick={() => setZoom(100)}>{zoomPercent}%</Button>
      <Button variant="ghost" size="icon-sm" aria-label="放大幻灯片" disabled={pageCount === 0 || zoomPercent >= PPTX_MAX_ZOOM} onClick={() => setZoom(zoomPercent + PPTX_ZOOM_STEP)}><ZoomIn /></Button>
    </div>
  </div>
}
