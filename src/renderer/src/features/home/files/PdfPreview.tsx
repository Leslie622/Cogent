/** react-pdf与PDF.js同版；隐藏卸载活动Page，文档与文字层交由库管理。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'react-pdf/dist/Page/TextLayer.css'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Hint } from '@/components/Hint'
import { useFilePreviewStore, type Preview } from '@/stores/file-preview'
import { useVisualScroll } from './visual/use-visual-scroll'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
const options = {
  enableXfa: false, useSystemFonts: true, maxImageSize: 40_000_000,
  cMapUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/cmaps/', window.location.href).href,
  cMapPacked: true,
  standardFontDataUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/standard_fonts/', window.location.href).href,
  wasmUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/wasm/', window.location.href).href
}

export default function PdfPreview({ url, tabId, active = true }: { url: string; tabId?: string; active?: boolean }) {
  // 换版文件拥有新的Document代次；旧文件异步完成不能写入新文件页数与尺寸。
  return <PdfDocumentPreview key={url} url={url} tabId={tabId} active={active} />
}

function PdfDocumentPreview({ url, tabId, active }: { url: string; tabId?: string; active: boolean }) {
  const generation = useRef(tabId === undefined ? undefined : (useFilePreviewStore.getState().byTab[tabId] as Preview | undefined)?.generation).current
  const saved = useFilePreviewStore(state => tabId === undefined ? undefined : state.views[tabId])
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [localPage, setLocalPage] = useState(1)
  const [localZoom, setLocalZoom] = useState(1)
  const [width, setWidth] = useState(0)
  const [natural, setNatural] = useState<{ page: number; width: number; height: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const page = saved?.page ?? localPage, zoom = saved?.zoom ?? localZoom
  const setPage = (value: number) => { setLocalPage(value); if (tabId !== undefined) useFilePreviewStore.getState().setView(tabId, { page: value }, generation) }
  const setZoom = (value: number) => { setLocalZoom(value); if (tabId !== undefined) useFilePreviewStore.getState().setView(tabId, { zoom: value }, generation) }
  useEffect(() => {
    const node = viewport.current!
    const measure = () => { if (node.clientWidth > 0) setWidth(node.clientWidth) }
    const observer = new ResizeObserver(measure); observer.observe(node); measure()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (document === null || !active) return
    let current = true
    setNatural(null); setError(null)
    void document.getPage(page).then(value => {
      if (current) { const size = value.getViewport({ scale: 1 }); setNatural({ page, width: size.width, height: size.height }) }
    }, (cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { current = false }
  }, [document, page, active])
  const scale = natural === null ? 1 : Math.max(0.1, (width - 24) / natural.width) * zoom
  const pixels = natural === null ? 0 : natural.width * natural.height * scale ** 2 * window.devicePixelRatio ** 2
  const ready = active && width > 0 && natural?.page === page && pixels <= 40_000_000
  const renderGeneration = useMemo(() => crypto.randomUUID(), [page, scale, active])
  const latestRender = useRef(renderGeneration); latestRender.current = renderGeneration
  const [rendered, setRendered] = useState<string | null>(null)
  // 元数据就绪并不等于Canvas已有高度；占位/隐藏/像素预算拒绝期间不能把旧滚动夹成0后保存。
  const scroll = useVisualScroll(tabId ?? '', active, ready && rendered === renderGeneration)
  return <div className="flex h-full min-h-0 flex-col" onKeyDown={event => {
    if (!active || event.target instanceof HTMLInputElement) return
    if (event.key === 'ArrowLeft' && page > 1) { event.preventDefault(); setPage(page - 1) }
    if (event.key === 'ArrowRight' && document !== null && page < document.numPages) { event.preventDefault(); setPage(page + 1) }
  }}>
    <div className="shrink-0 overflow-x-auto" data-pdf-toolbar>
      <div role="group" aria-label="PDF页面与缩放" className="mx-auto flex w-max flex-nowrap items-center gap-1.5 p-2">
        <div className="flex shrink-0 items-center gap-1.5">
          <Hint tip="上一页"><Button variant="ghost" size="icon-xs" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft /></Button></Hint>
          <Input size="xs" aria-label="PDF页码" className="w-9 shrink-0" type="number" min={1} max={document?.numPages ?? 1} value={page} onChange={event => {
            const value = Number(event.target.value)
            if (Number.isInteger(value) && value >= 1 && document !== null && value <= document.numPages) setPage(value)
          }} />
          <span className="shrink-0 text-xs whitespace-nowrap tabular-nums">/ {document?.numPages ?? '…'}</span>
          <Hint tip="下一页"><Button variant="ghost" size="icon-xs" aria-label="下一页" disabled={document === null || page >= document.numPages} onClick={() => setPage(page + 1)}><ChevronRight /></Button></Hint>
        </div>
        <Separator orientation="vertical" className="my-1" />
        <div className="flex shrink-0 items-center gap-0.5">
          <Hint tip="缩小"><Button variant="ghost" size="icon-xs" aria-label="缩小" disabled={zoom <= 0.25} onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}><Minus /></Button></Hint>
          <Hint tip="相对适配宽度的倍率，点击恢复100%"><Button variant="ghost" size="xs" aria-label="适配" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button></Hint>
          <Hint tip="放大"><Button variant="ghost" size="icon-xs" aria-label="放大" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + 0.25))}><Plus /></Button></Hint>
        </div>
      </div>
    </div>
    {error !== null && <p role="alert" className="p-3 text-sm text-destructive">{error}</p>}
    {pixels > 40_000_000 && <p role="alert" className="p-3 text-sm">页面像素超过预览预算，请缩小倍率或用系统打开。</p>}
    {/* 预留滚动条位置，避免 Canvas/加载占位交替改变 clientWidth，再反向触发缩放重绘。 */}
    <div ref={node => { viewport.current = node; scroll.ref.current = node }} onScroll={scroll.onScroll} className="scrollbar-gutter-stable min-h-0 flex-1 overflow-auto p-3 select-text" data-pdf-viewport>
      <Document file={url} options={options} onLoadSuccess={value => { setDocument(value); if (page > value.numPages) setPage(value.numPages) }} onLoadError={cause => setError(cause.message)} loading={<p role="status" className="text-sm">正在加载PDF…</p>}>
        {ready && <Page key={page} pageNumber={page} scale={scale} renderAnnotationLayer={false} renderTextLayer loading={<p role="status" className="text-sm">正在加载页面…</p>} onRenderSuccess={() => { if (latestRender.current === renderGeneration) setRendered(renderGeneration) }} onRenderError={cause => setError(cause.message)} />}
      </Document>
    </div>
  </div>
}
