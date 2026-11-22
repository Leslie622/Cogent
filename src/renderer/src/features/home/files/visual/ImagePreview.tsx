/** 文件图片与SVG共用安全img；倍率/拖动留在本tab，原图保存交给既有租约动作。 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Copy, Download, Maximize, Minus, Plus, Scan } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useFilePreviewStore, type FileViewState } from '@/stores/file-preview'
import { useVisualScroll } from './use-visual-scroll'
import { copyImagePreview } from './image-preview-clipboard'
import { imagePreviewGeometry } from './image-preview-geometry'

export interface ImagePreviewProps {
  url: string
  name: string
  tabId: string
  active: boolean
  scrollMode?: 'source' | 'render'
  onSave: () => Promise<{ canceled: boolean }>
}
interface NaturalSize { url: string; width: number; height: number }
interface Anchor { x: number; y: number; imageX: number; imageY: number }
interface Drag { pointerId: number; x: number; y: number; left: number; top: number }
const EMPTY_SIZE = { width: 1, height: 1 }
const CHECKERBOARD = {
  backgroundColor: 'var(--background)',
  backgroundImage: 'linear-gradient(45deg,var(--muted) 25%,transparent 25%),linear-gradient(-45deg,var(--muted) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--muted) 75%),linear-gradient(-45deg,transparent 75%,var(--muted) 75%)',
  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0', backgroundSize: '16px 16px'
}

export default function ImagePreview({ url, name, tabId, active, scrollMode = 'source', onSave }: ImagePreviewProps) {
  const saved = useFilePreviewStore<FileViewState | undefined>(state => state.views[tabId])
  const [natural, setNatural] = useState<NaturalSize | null>(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [failure, setFailure] = useState<{ url: string; text: string } | null>(null)
  const [feedback, setFeedback] = useState<{ url: string; error: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const image = useRef<HTMLImageElement>(null)
  const anchor = useRef<Anchor | null>(null)
  const drag = useRef<Drag | null>(null)
  const operation = useRef<object | null>(null)
  const alive = useRef(true)
  const current = useRef({ url, tabId, active }); current.current = { url, tabId, active }
  const ready = natural?.url === url
  const currentFailure = failure?.url === url ? failure.text : null
  const { ref: viewport, onScroll } = useVisualScroll(tabId, active, ready, scrollMode === 'render')
  const geometry = imagePreviewGeometry(ready ? natural : EMPTY_SIZE, viewportSize, name, saved?.zoom ?? null)
  const canPan = ready && (geometry.width + 32 > viewportSize.width || geometry.height + 32 > viewportSize.height)
  const latest = useRef({ geometry, onScroll, ready }); latest.current = { geometry, onScroll, ready }

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; operation.current = null }
  }, [])
  useEffect(() => {
    setFeedback(null); setBusy(false); setMenuOpen(false)
    operation.current = null; anchor.current = null; drag.current = null; setDragging(false)
    const element = viewport.current!
    return () => {
      const gesture = drag.current
      drag.current = null; anchor.current = null; operation.current = null
      if (gesture !== null && element.hasPointerCapture(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId)
    }
  }, [url, tabId, viewport])
  useLayoutEffect(() => {
    if (!active) return
    const element = viewport.current!
    const measure = () => { if (element.clientWidth > 0 && element.clientHeight > 0) setViewportSize({ width: element.clientWidth, height: element.clientHeight }) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active, viewport])
  useEffect(() => {
    if (active) return
    const element = viewport.current!
    const gesture = drag.current
    drag.current = null; setDragging(false); setMenuOpen(false); anchor.current = null
    if (gesture !== null && element.hasPointerCapture(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId)
  }, [active, viewport])

  const zoomTo = useRef<(scale: number, point?: { x: number; y: number }) => void>(() => {})
  zoomTo.current = (scale, point) => {
    if (!current.current.active || !latest.current.ready) return
    const element = viewport.current!, source = image.current!, rect = element.getBoundingClientRect(), imageRect = source.getBoundingClientRect()
    const x = point?.x ?? rect.left + element.clientWidth / 2, y = point?.y ?? rect.top + element.clientHeight / 2
    const { geometry } = latest.current
    anchor.current = { x: x - rect.left, y: y - rect.top, imageX: (x - imageRect.left) / geometry.scale, imageY: (y - imageRect.top) / geometry.scale }
    useFilePreviewStore.getState().setView(tabId, { zoom: Math.min(geometry.maxScale, Math.max(geometry.minScale, scale)) })
  }
  useLayoutEffect(() => {
    const point = anchor.current
    if (!active || !ready || point === null) return
    anchor.current = null
    const element = viewport.current!, rect = element.getBoundingClientRect(), imageRect = image.current!.getBoundingClientRect()
    element.scrollLeft += imageRect.left - rect.left + point.imageX * geometry.scale - point.x
    element.scrollTop += imageRect.top - rect.top + point.imageY * geometry.scale - point.y
    onScroll()
  }, [active, ready, geometry.scale, geometry.width, geometry.height, onScroll, viewport])
  useEffect(() => {
    if (!active || !ready) return
    const element = viewport.current!
    const wheel = (event: WheelEvent) => {
      if (drag.current !== null) return
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1)
      zoomTo.current(latest.current.geometry.scale * Math.exp(-Math.min(300, Math.max(-300, delta)) * 0.002), { x: event.clientX, y: event.clientY })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [active, ready, viewport])

  const run = async (kind: 'copy' | 'save') => {
    if (!active || !ready || operation.current !== null) return
    const job = {}; operation.current = job; setBusy(true); setFeedback(null)
    const owns = () => alive.current && operation.current === job && current.current.url === url && current.current.tabId === tabId
    try {
      if (kind === 'copy') { await copyImagePreview(image.current!); if (owns()) setFeedback({ url, error: false, text: '图片已复制' }) }
      else { const result = await onSave(); if (owns() && !result.canceled) setFeedback({ url, error: false, text: '原图已另存' }) }
    } catch (error) { if (owns()) setFeedback({ url, error: true, text: `${kind === 'copy' ? '复制图片' : '下载原图'}失败：${error instanceof Error ? error.message : String(error)}` }) }
    finally { if (owns()) { operation.current = null; setBusy(false) } }
  }
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!active || !canPan || drag.current !== null || event.button !== 0) return
    event.preventDefault()
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }
    event.currentTarget.setPointerCapture(event.pointerId); setDragging(true)
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    event.currentTarget.scrollLeft = gesture.left - event.clientX + gesture.x
    event.currentTarget.scrollTop = gesture.top - event.clientY + gesture.y
    onScroll()
  }
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null; setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onScroll()
  }
  const reset = (zoom: number | null) => {
    anchor.current = null
    useFilePreviewStore.getState().setView(tabId, scrollMode === 'render' ? { zoom, renderScrollTop: 0, renderScrollLeft: 0 } : { zoom, scrollTop: 0, scrollLeft: 0 })
    viewport.current!.scrollTop = 0; viewport.current!.scrollLeft = 0
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }))
    } else if (ready && (event.key === '+' || event.key === '=' || event.key === '-')) {
      event.preventDefault(); zoomTo.current(geometry.scale * (event.key === '-' ? 1 / 1.25 : 1.25))
    } else if (ready && event.key === '0') { event.preventDefault(); reset(null) }
  }
  const disabled = !active || !ready
  return <div className="flex h-full min-h-0 flex-col" data-image-preview aria-busy={busy}>
    <div className="flex shrink-0 flex-wrap items-center gap-1 p-2" aria-label="图片控件">
      <Button variant="ghost" size="icon-sm" aria-label="缩小图片" disabled={disabled || geometry.scale <= geometry.minScale} onClick={() => zoomTo.current(geometry.scale / 1.25)}><Minus /></Button>
      <Button variant="ghost" size="sm" aria-label="适配图片" disabled={disabled} onClick={() => reset(null)}><Maximize />适配</Button>
      <Button variant="ghost" size="sm" aria-label="图片原始尺寸" disabled={disabled} onClick={() => reset(1)}><Scan />100%</Button>
      <Button variant="ghost" size="icon-sm" aria-label="放大图片" disabled={disabled || geometry.scale >= geometry.maxScale} onClick={() => zoomTo.current(geometry.scale * 1.25)}><Plus /></Button>
      <span className="mr-auto text-xs tabular-nums text-muted-foreground" data-image-preview-zoom>{ready ? `${Math.round(geometry.scale * 100)}%` : '—'}</span>
      <Button variant="ghost" size="icon-sm" aria-label="复制图片" disabled={disabled || busy} onClick={() => void run('copy')}><Copy /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="下载原图" disabled={disabled || busy} onClick={() => void run('save')}><Download /></Button>
    </div>
    {currentFailure !== null && <p role="alert" className="shrink-0 px-3 py-2 text-sm text-destructive">{currentFailure}，请用系统打开或检查SVG源码。</p>}
    {feedback?.url === url && <p role={feedback.error ? 'alert' : 'status'} className="shrink-0 px-3 py-1 text-xs">{feedback.text}</p>}
    <ContextMenu open={active && menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger render={<div ref={viewport} tabIndex={0} aria-label={'图片画布：' + name} className="relative min-h-0 flex-1 touch-none overflow-auto" style={{ ...CHECKERBOARD, cursor: canPan ? dragging ? 'grabbing' : 'grab' : 'default' }} onScroll={onScroll} onKeyDown={keyboard} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} data-image-preview-viewport />}>
        <div className="grid min-h-full min-w-full place-items-center p-4" data-image-preview-stage style={ready ? { width: Math.max(viewportSize.width, geometry.width + 32), height: Math.max(viewportSize.height, geometry.height + 32) } : undefined}>
          {!ready && currentFailure === null && <span role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">正在解码图片…</span>}
          <img key={url} ref={image} src={url} alt={name} draggable={false} decoding="async" data-image-preview-image style={ready ? { width: geometry.width, height: geometry.height, maxWidth: 'none', maxHeight: 'none' } : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} onLoad={event => {
            if (current.current.url !== url) return
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget
            if (width <= 0 || height <= 0) { setNatural(null); setFailure({ url, text: '图片没有可显示的尺寸' }); return }
            setNatural({ url, width, height }); setFailure(null)
          }} onError={() => { if (current.current.url === url) { setNatural(null); setFailure({ url, text: '图片解码失败' }) } }} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={disabled || busy} onClick={() => void run('copy')}><Copy />复制图片</ContextMenuItem>
        <ContextMenuItem disabled={disabled || busy} onClick={() => void run('save')}><Download />下载原图</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={disabled} onClick={() => reset(null)}>适配图片</ContextMenuItem>
        <ContextMenuItem disabled={disabled} onClick={() => reset(1)}>原始尺寸</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </div>
}
