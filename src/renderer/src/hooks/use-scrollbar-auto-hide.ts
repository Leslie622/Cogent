import { useEffect } from 'react'

/** 静默多久后摘除 data-scrolling（滑块隐回全透明） */
const HIDE_DELAY_MS = 600

/**
 * 全局滚动条「不滚动即隐藏」的行为侧（样式侧在 globals.css：滑块默认
 * 透明，[data-scrolling] / 滑块 hover 显形）。App 挂载一次，全应用滚动
 * 容器（含将来新增的）无需各自接线。
 *
 * 机制：document 捕获 scroll —— 元素 scroll 事件不冒泡但捕获相位可达
 * document；滚轮 / 键盘 / 拖拽滑块 / 程序化 scrollTo（含 smooth 逐帧）
 * 全都派发，事件流即「正在滚动」的唯一事实源。给滚动容器挂
 * data-scrolling、静默 HIDE_DELAY_MS 后摘除；计时器句柄存 WeakMap，
 * 每元素独立、不拦回收。视口滚动（target 是 Document）标记落到
 * documentElement 上。
 */
export function useScrollbarAutoHide() {
  useEffect(() => {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
    const onScroll = (event: Event) => {
      const el = event.target instanceof Element ? event.target : document.documentElement
      const timer = timers.get(el)
      if (timer !== undefined) clearTimeout(timer)
      // 连滚时事件 60Hz+，属性已在就跳过写 DOM
      if (!el.hasAttribute('data-scrolling')) el.setAttribute('data-scrolling', '')
      timers.set(el, setTimeout(() => el.removeAttribute('data-scrolling'), HIDE_DELAY_MS))
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [])
}
