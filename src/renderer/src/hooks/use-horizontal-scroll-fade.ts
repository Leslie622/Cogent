/** 水平滚动的边缘提示只投影到DOM；面包屑和标签栏共用，不因滚动重渲染内容。 */
import { useLayoutEffect, type ReactNode, type RefObject } from 'react'

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
