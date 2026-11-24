/** 侧边栏列表悬停指示器：单层背景胶囊随指针在列表行间平滑滑行并自适应行高，
 *  避免每行独立闪切；全程通过 DOM 属性与 CSS 变量直写，不触发 React 重渲染。 */
import { useEffect, useRef } from 'react'

const ROW_SELECTOR = '[data-sidebar-row]'
const LEAVE_DELAY_MS = 65

export function useSidebarHoverPill() {
  const containerRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const pill = pillRef.current
    if (!container || !pill) return

    let activeRow: HTMLElement | null = null
    let visible = false
    let lastY = -1
    let lastH = -1
    let hideTimer: number | undefined
    let scrollRaf: number | undefined
    const pointer = { x: 0, y: 0, inside: false }

    const clearHideTimer = () => {
      if (hideTimer !== undefined) {
        window.clearTimeout(hideTimer)
        hideTimer = undefined
      }
    }

    const setActiveRow = (next: HTMLElement | null) => {
      if (activeRow === next) return
      if (activeRow) activeRow.removeAttribute('data-pill-over')
      activeRow = next
      if (activeRow) activeRow.setAttribute('data-pill-over', '')
    }

    const hideImmediate = () => {
      clearHideTimer()
      visible = false
      lastY = -1
      lastH = -1
      pill.dataset.visible = 'false'
      setActiveRow(null)
    }

    const scheduleHide = () => {
      if (hideTimer !== undefined) return
      hideTimer = window.setTimeout(() => {
        hideTimer = undefined
        hideImmediate()
      }, LEAVE_DELAY_MS)
    }

    const moveToRow = (row: HTMLElement) => {
      clearHideTimer()
      if (row.closest('[inert]')) {
        scheduleHide()
        return
      }
      const containerRect = container.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      if (rowRect.height <= 0 || containerRect.width <= 0) return

      const y = rowRect.top - containerRect.top
      const h = rowRect.height
      const sameRow = row === activeRow

      setActiveRow(row)

      if (!visible) {
        // 首次进入：先跳过位置/尺寸过渡落位，再从微缩态淡入，避免胶囊从顶部飞入。
        visible = true
        lastY = y
        lastH = h
        pill.style.transition = 'none'
        pill.style.setProperty('--pill-y', `${y}px`)
        pill.style.setProperty('--pill-h', `${h}px`)
        pill.dataset.visible = 'false'
        void pill.offsetHeight
        pill.style.transition = ''
        pill.dataset.visible = 'true'
        return
      }

      if (sameRow && Math.abs(y - lastY) < 0.5 && Math.abs(h - lastH) < 0.5) {
        return
      }
      lastY = y
      lastH = h
      pill.style.setProperty('--pill-y', `${y}px`)
      pill.style.setProperty('--pill-h', `${h}px`)
    }

    const resolveRow = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null
      const row = target.closest<HTMLElement>(ROW_SELECTOR)
      return row && container.contains(row) ? row : null
    }

    const onPointerOver = (event: PointerEvent) => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.inside = true
      const row = resolveRow(event.target)
      if (row) moveToRow(row)
      else scheduleHide()
    }

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.inside = true
      const row = resolveRow(event.target)
      if (row) moveToRow(row)
      else if (visible) scheduleHide()
    }

    const onPointerLeave = () => {
      pointer.inside = false
      hideImmediate()
    }

    // 滚轮滚动时指针不动，按最后坐标同步胶囊到当前命中的行。
    const scroller = container.parentElement
    const onScroll = () => {
      if (!pointer.inside || scrollRaf !== undefined) return
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = undefined
        if (!pointer.inside) return
        const hit = document.elementFromPoint(pointer.x, pointer.y)
        const row = resolveRow(hit)
        if (row) moveToRow(row)
        else scheduleHide()
      })
    }

    container.addEventListener('pointerover', onPointerOver)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerleave', onPointerLeave)
    scroller?.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      clearHideTimer()
      if (scrollRaf !== undefined) window.cancelAnimationFrame(scrollRaf)
      setActiveRow(null)
      container.removeEventListener('pointerover', onPointerOver)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerleave', onPointerLeave)
      scroller?.removeEventListener('scroll', onScroll)
    }
  }, [])

  return { containerRef, pillRef }
}
