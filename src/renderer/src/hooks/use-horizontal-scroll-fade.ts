/** 水平滚动的边缘提示只投影到DOM；面包屑和标签栏共用，不因滚动重渲染内容。 */
import { useEffect, useLayoutEffect, type ReactNode, type RefObject } from 'react'

const DRAG_THRESHOLD_PX = 4

export function useHorizontalScrollFade(viewport: RefObject<HTMLElement | null>, enabled: boolean, children: ReactNode) {
  useLayoutEffect(() => {
    if (!enabled) return
    const node = viewport.current!
    const measure = () => {
      // LTR视口在端点可能有不到1px的取整差，不能让已完整露出的文字继续被遮淡。
      node.toggleAttribute('data-scroll-left', node.scrollLeft > 1)
      node.toggleAttribute('data-scroll-right', node.scrollWidth - node.clientWidth - node.scrollLeft > 1)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    for (const child of node.children) observer.observe(child)
    node.addEventListener('scroll', measure, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      node.removeEventListener('scroll', measure)
      node.removeAttribute('data-scroll-left')
      node.removeAttribute('data-scroll-right')
    }
  }, [viewport, enabled, children])
}

/** 为隐藏滚动条的水平视口提供纵向滚轮映射与左键拖曳平移（触摸沿用原生滚动）。 */
export function useHorizontalScrollPan(viewport: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const node = viewport.current!
    type DragState = { pointerId: number; startX: number; startScrollLeft: number; active: boolean }
    let gesture: DragState | null = null
    let suppressClick = false
    let suppressTimer: number | undefined

    const clearDrag = (pointerId?: number) => {
      if (gesture === null) return
      const wasActive = gesture.active
      const id = pointerId ?? gesture.pointerId
      gesture = null
      if (!wasActive) return
      delete node.dataset.dragging
      try {
        if (node.hasPointerCapture(id)) node.releasePointerCapture(id)
      } catch {
        /* 测试环境或指针未捕获时忽略释放失败 */
      }
      suppressClick = true
      window.clearTimeout(suppressTimer)
      suppressTimer = window.setTimeout(() => { suppressClick = false }, 0)
    }

    const onWheel = (event: WheelEvent) => {
      if (node.scrollWidth <= node.clientWidth) return
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.deltaY === 0) return
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? node.clientWidth : 1
      node.scrollLeft += event.deltaY * scale
      event.preventDefault()
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === 'touch') return
      if (node.scrollWidth <= node.clientWidth) return
      suppressClick = false
      gesture = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: node.scrollLeft, active: false }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (gesture === null || gesture.pointerId !== event.pointerId) return
      const dx = event.clientX - gesture.startX
      if (!gesture.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return
        gesture.active = true
        node.dataset.dragging = ''
        try { node.setPointerCapture(event.pointerId) } catch { /* 合成测试事件可能没有活跃指针 */ }
      }
      node.scrollLeft = gesture.startScrollLeft - dx
    }

    const onPointerEnd = (event: PointerEvent) => {
      if (gesture?.pointerId !== event.pointerId) return
      clearDrag(event.pointerId)
    }

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return
      suppressClick = false
      window.clearTimeout(suppressTimer)
      event.preventDefault()
      event.stopPropagation()
    }

    const onDragStart = (event: DragEvent) => {
      if (node.scrollWidth > node.clientWidth) event.preventDefault()
    }

    node.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('pointerdown', onPointerDown)
    node.addEventListener('pointermove', onPointerMove)
    node.addEventListener('pointerup', onPointerEnd)
    node.addEventListener('pointercancel', onPointerEnd)
    node.addEventListener('lostpointercapture', onPointerEnd)
    node.addEventListener('click', onClickCapture, true)
    node.addEventListener('dragstart', onDragStart)
    return () => {
      clearDrag()
      window.clearTimeout(suppressTimer)
      node.removeEventListener('wheel', onWheel)
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerup', onPointerEnd)
      node.removeEventListener('pointercancel', onPointerEnd)
      node.removeEventListener('lostpointercapture', onPointerEnd)
      node.removeEventListener('click', onClickCapture, true)
      node.removeEventListener('dragstart', onDragStart)
    }
  }, [viewport, enabled])
}
