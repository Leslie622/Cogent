import { useEffect, useRef } from 'react'

/** 把手半高(px，withHandle 的 h-6)；核心半长(px)须与 globals.css 光带 140px 尺寸同步 */
const KNOB_HALF = 12
const CORE_HALF = 70

/**
 * 分割线拖拽光带（效果移植自 Themd，驱动方式重写）。返回的 ref 挂到把手元素上
 * （元素须同时带 .divider-glow 类，样式见 globals.css）。
 *
 * 不自行猜测"按下的是不是分屏线"（Themd 用几何半径猜、再排除滚动条误触）——
 * 直接观察库维护的 data-separator 属性：react-resizable-panels 在真实拖拽期间
 * 把它置 "active"。以库状态为唯一权威，滚动条等相邻元素永远不可能误亮；
 * 指针在窗外松手/拖拽被取消也只是属性变化，天然覆盖。
 *
 * active 期间 pointermove 直写 CSS 变量、不触发 React 渲染：--glow-y 光带纵向
 * 位置、--glow-strength 亮度（拖拽中恒满）、--glow-knob 把手染色系数；结束归零，
 * CSS 侧 0.18s 过渡淡出。
 */
export function useDividerGlow() {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let dragging = false
    // 拖拽开始的瞬间没有指针事件可拿坐标，平时零成本记一下最后位置供点亮用
    let lastY = Number.NaN

    const zero = () => {
      el.style.setProperty('--glow-strength', '0')
      el.style.setProperty('--glow-knob', '0')
    }
    const apply = (y: number) => {
      const rect = el.getBoundingClientRect()
      el.style.setProperty('--glow-y', `${y - rect.top}px`)
      el.style.setProperty('--glow-strength', '1')
      // 把手只在光带纵向扫过线中央时染色：半高内满染，再往外按核心半长线性褪回灰
      const knobDy = Math.abs(y - rect.top - rect.height / 2)
      const knobT = Math.max(0, 1 - Math.max(0, knobDy - KNOB_HALF) / CORE_HALF)
      el.style.setProperty('--glow-knob', knobT.toFixed(3))
    }
    const onMove = (event: PointerEvent) => {
      lastY = event.clientY
      if (dragging) apply(lastY)
    }
    const observer = new MutationObserver(() => {
      const active = el.dataset.separator === 'active'
      if (active === dragging) return
      dragging = active
      if (active) {
        if (!Number.isNaN(lastY)) apply(lastY)
      } else {
        zero()
      }
    })
    observer.observe(el, { attributes: true, attributeFilter: ['data-separator'] })
    window.addEventListener('pointermove', onMove)
    return () => {
      observer.disconnect()
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  return ref
}
