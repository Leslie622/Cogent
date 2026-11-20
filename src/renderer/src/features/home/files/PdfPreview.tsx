/** PDF.js 真页面预览；一次只渲染当前页，切页/缩放/卸载取消 canvas 工作与文档 worker。 */
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { Button } from '@/components/ui/button'
export default function PdfPreview({ url }: { url: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    const isActive = () => !controller.signal.aborted
    let destroy: (() => Promise<void>) | undefined
    void (async () => {
      const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
      if (!isActive()) return
      pdf.GlobalWorkerOptions.workerSrc = workerUrl
      const task = pdf.getDocument({
        url,
        enableXfa: false,
        useSystemFonts: true,
        maxImageSize: 40_000_000,
        canvasMaxAreaInBytes: 160_000_000,
        cMapUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/cmaps/', window.location.href).href,
        cMapPacked: true,
        standardFontDataUrl: new URL(
          import.meta.env.BASE_URL + 'pdfjs/standard_fonts/',
          window.location.href
        ).href,
        wasmUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/wasm/', window.location.href).href
      })
      destroy = () => task.destroy()
      const result = await task.promise
      if (isActive()) {
        setDocument(result)
        setPage(1)
        setError(null)
      }
    })().catch((error: unknown) => {
      if (isActive()) setError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      controller.abort()
      setDocument(null)
      void destroy?.()
    }
  }, [url])
  useEffect(() => {
    if (document === null) return
    const controller = new AbortController()
    const isActive = () => !controller.signal.aborted
    let cancel: (() => void) | undefined
    void (async () => {
      const pdfPage = await document.getPage(page)
      if (!isActive()) {
        pdfPage.cleanup()
        return
      }
      const element = canvas.current!
      const natural = pdfPage.getViewport({ scale: 1 })
      const scale =
        Math.min(2, Math.max(0.1, (viewport.current!.clientWidth - 24) / natural.width)) * zoom
      const pixels = pdfPage.getViewport({ scale: scale * window.devicePixelRatio })
      // 极端页面尺寸不能分配无界 canvas；保留缩小倍率入口。
      if (pixels.width * pixels.height > 40_000_000)
        throw new Error('页面像素超过预览预算，请缩小倍率或用系统打开')
      element.width = pixels.width
      element.height = pixels.height
      element.style.width = `${pixels.width / window.devicePixelRatio}px`
      element.style.height = `${pixels.height / window.devicePixelRatio}px`
      const render = pdfPage.render({
        canvas: element,
        canvasContext: element.getContext('2d')!,
        viewport: pixels
      })
      cancel = () => {
        render.cancel()
        pdfPage.cleanup()
      }
      await render.promise
      if (isActive()) setError(null)
    })().catch((error: unknown) => {
      if (isActive()) setError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      controller.abort()
      cancel?.()
    }
  }, [document, page, zoom])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span className="text-xs">
          {page} / {document?.numPages ?? '…'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={document === null || page >= document.numPages}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}>
          缩小
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(1)}>
          适配
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(Math.min(4, zoom + 0.25))}>
          放大
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="p-3 text-sm">
          {error}
        </p>
      )}
      <div ref={viewport} className="min-h-0 flex-1 overflow-auto p-3">
        <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />
      </div>
    </div>
  )
}
