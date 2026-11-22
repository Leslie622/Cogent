/** 旧 .doc 沿用 Zcode 的现成 WASM/editor 查看链；解析器拒绝的文件明确失败，不另建转换服务。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DocxEditorViewer, setWasmSource, useDocxEditor, useDocxModel, type DocModel, type DocxPageVirtualizationOptions } from '@extend-ai/react-docx'
import wasmUrl from '@extend-ai/react-docx/docx_wasm_bg.wasm?url'
import { Button } from '@/components/ui/button'
import { useFilePreviewStore, type FileViewState } from '@/stores/file-preview'
import { installDocumentLinks } from './links'
import { useVisualScroll } from './use-visual-scroll'
import type { VisualPreviewProps } from './types'

setWasmSource(wasmUrl)

export default function LegacyDocPreview(props: VisualPreviewProps) {
  // useDocxModel 自己取消旧 worker；新 buffer 仍须换掉只读取初始 starterModel 的 editor controller。
  const sourceKey = useMemo(() => crypto.randomUUID(), [props.buffer])
  return <LegacyParser key={sourceKey} {...props} />
}

function LegacyParser(props: VisualPreviewProps) {
  const [started, setStarted] = useState(props.active)
  useEffect(() => { if (props.active) setStarted(true) }, [props.active])
  const { model, error, isLoading } = useDocxModel(started ? props.buffer : undefined)
  if (error !== undefined) return <p role="alert" className="break-words p-3 text-sm">无法预览 {props.name}：{error.message}</p>
  if (model === undefined || isLoading) return <div data-visual-doc aria-busy="true" />
  return <LegacyDocument {...props} model={model} />
}

function LegacyDocument({ model, ...props }: VisualPreviewProps & { model: DocModel }) {
  const { active, name, tabId } = props
  const editor = useDocxEditor({ starterModel: model, initialFileName: name, initialDocumentTheme: 'light' })
  const saved = useFilePreviewStore((state): FileViewState | undefined => state.views[tabId])
  const zoom = saved?.zoom ?? null
  const scroll = useVisualScroll(tabId, active, true)
  const content = useRef<HTMLDivElement>(null)
  const latest = useRef(props); latest.current = props
  const [natural, setNatural] = useState({ width: 0, height: 0, available: 0 })
  const [pageCount, setPageCount] = useState(0)
  const fit = natural.width > 0 && natural.available > 0 ? Math.min(1, natural.available / natural.width) : 1
  const scale = zoom ?? fit
  // transform 不会改变原始布局坐标；必须把同一倍率交给虚拟列表，才能正确挂载末页。
  const pageVirtualization = useMemo<DocxPageVirtualizationOptions>(() => ({ zoomScale: scale }), [scale])
  useLayoutEffect(() => installDocumentLinks(content.current!, url => latest.current.onOpenUrl(url)), [])
  useLayoutEffect(() => {
    if (!active) return
    let current = true
    const viewport = scroll.ref.current!, paper = content.current!
    const measure = (): void => {
      if (!current || viewport.clientWidth === 0 || paper.offsetWidth === 0 || paper.offsetHeight === 0) return
      const next = { width: paper.offsetWidth, height: paper.offsetHeight, available: viewport.clientWidth - 24 }
      setNatural(previous => previous.width === next.width && previous.height === next.height && previous.available === next.available ? previous : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport); observer.observe(paper)
    measure()
    const fonts = (document as Partial<Pick<Document, 'fonts'>>).fonts
    if (fonts !== undefined) void fonts.ready.then(measure, measure)
    return () => { current = false; observer.disconnect() }
  }, [active, scroll.ref])
  useLayoutEffect(() => { if (active) scroll.restore() }, [active, scale, pageCount, natural.height, scroll.restore])
  const onScroll = (): void => {
    scroll.onScroll()
    if (!active) return
    const viewport = scroll.ref.current!
    const top = viewport.getBoundingClientRect().top
    const first = [...content.current!.querySelectorAll<HTMLElement>('[data-docx-page-wrapper][data-docx-page-index]')]
      .find(page => page.getBoundingClientRect().bottom > top + 1)
    if (first !== undefined) useFilePreviewStore.getState().setView(tabId, { page: Number(first.dataset.docxPageIndex) + 1 })
  }
  const setZoom = (value: number | null): void => useFilePreviewStore.getState().setView(tabId, { zoom: value })
  return <div className="flex h-full min-h-0 min-w-0 flex-col" data-visual-doc aria-label={name}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 p-2">
      <span className="text-xs" aria-label="文档页码">{saved?.page ?? 1} / {pageCount || '…'}</span>
      <Button variant="ghost" size="sm" onClick={() => setZoom(Math.max(0.1, scale - 0.25))}>缩小</Button>
      <Button variant="ghost" size="sm" onClick={() => setZoom(null)}>适配</Button>
      <Button variant="ghost" size="sm" onClick={() => setZoom(Math.min(4, scale + 0.25))}>放大</Button>
    </div>
    <div ref={scroll.ref} onScroll={onScroll} className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
      <div className="relative mx-auto" data-doc-scaled-frame style={natural.width > 0 ? { width: natural.width * scale, height: natural.height * scale } : undefined}>
        <div ref={content} className="w-max select-text" data-doc-content style={natural.width > 0 ? { position: 'absolute', left: 0, top: 0, transform: `scale(${scale})`, transformOrigin: 'top left' } : undefined}>
          <DocxEditorViewer editor={editor} mode="read-only" pageGapBackgroundColor="transparent" pageVirtualization={pageVirtualization} onPageCountChange={setPageCount} />
        </div>
      </div>
    </div>
  </div>
}
