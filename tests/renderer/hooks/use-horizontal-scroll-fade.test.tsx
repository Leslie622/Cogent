/** 端点随滚动和内容尺寸更新；样式与明暗主题由真实Electron检查。 */
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHorizontalScrollFade } from '@/hooks/use-horizontal-scroll-fade'

let width = 200, total = 600
const observers: { resize: () => void; disconnect: ReturnType<typeof vi.fn> }[] = []
function Host({ enabled = true, text = '长路径' }: { enabled?: boolean; text?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useHorizontalScrollFade(ref, enabled, text)
  return <div ref={ref} data-testid="viewport"><span>{text}</span></div>
}

beforeEach(() => {
  width = 200; total = 600; observers.length = 0
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => total)
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    constructor(resize: () => void) { observers.push({ resize, disconnect: this.disconnect }) }
    observe() {}
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('水平滚动边缘渐隐', () => {
  it('起点只提示右边，中途提示两边，末尾只提示左边；容忍亚像素端点差', () => {
    render(<Host />)
    const node = screen.getByTestId('viewport')
    expect(node).not.toHaveAttribute('data-scroll-left')
    expect(node).toHaveAttribute('data-scroll-right')
    node.scrollLeft = 200; fireEvent.scroll(node)
    expect(node).toHaveAttribute('data-scroll-left')
    expect(node).toHaveAttribute('data-scroll-right')
    node.scrollLeft = 399.5; fireEvent.scroll(node)
    expect(node).toHaveAttribute('data-scroll-left')
    expect(node).not.toHaveAttribute('data-scroll-right')
    node.scrollLeft = 0.5; fireEvent.scroll(node)
    expect(node).not.toHaveAttribute('data-scroll-left')
  })

  it('短内容不渐隐，内容变长及视口放宽会重新求边缘', () => {
    total = 100
    const view = render(<Host text="短" />)
    const node = screen.getByTestId('viewport')
    expect(node).not.toHaveAttribute('data-scroll-left')
    expect(node).not.toHaveAttribute('data-scroll-right')
    total = 600; view.rerender(<Host text="变长的路径" />)
    expect(node).toHaveAttribute('data-scroll-right')
    width = 700; act(() => observers.at(-1)!.resize())
    expect(node).not.toHaveAttribute('data-scroll-right')
  })

  it('停用清理观察器和边缘标记，旧节点滚动不再写入', () => {
    const view = render(<Host />)
    const node = screen.getByTestId('viewport'), observer = observers[0]
    view.rerender(<Host enabled={false} />)
    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(node).not.toHaveAttribute('data-scroll-right')
    node.scrollLeft = 100; fireEvent.scroll(node)
    expect(node).not.toHaveAttribute('data-scroll-left')
    expect(observers).toHaveLength(1)
  })
})
