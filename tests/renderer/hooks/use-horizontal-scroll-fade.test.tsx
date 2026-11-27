/** 端点随滚动和内容尺寸更新；样式与明暗主题由真实Electron检查。 */
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHorizontalScrollFade, useHorizontalScrollPan } from '@/hooks/use-horizontal-scroll-fade'

let width = 200, total = 600
const observers: { resize: () => void; disconnect: ReturnType<typeof vi.fn> }[] = []
function Host({ enabled = true, text = '长路径', onItemClick }: { enabled?: boolean; text?: string; onItemClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useHorizontalScrollFade(ref, enabled, text)
  useHorizontalScrollPan(ref, enabled)
  return <div ref={ref} data-testid="viewport"><button type="button" onClick={onItemClick}>{text}</button></div>
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

  it('溢出时把纵向滚轮映射为横向滚动，非溢出或横向主导时不拦截', () => {
    render(<Host />)
    const node = screen.getByTestId('viewport')
    node.scrollLeft = 50
    const vertical = new WheelEvent('wheel', { deltaY: 120, deltaX: 0, cancelable: true })
    act(() => { node.dispatchEvent(vertical) })
    expect(node.scrollLeft).toBe(170)
    expect(vertical.defaultPrevented).toBe(true)

    const lineWheel = new WheelEvent('wheel', { deltaY: -2, deltaMode: WheelEvent.DOM_DELTA_LINE, cancelable: true })
    act(() => { node.dispatchEvent(lineWheel) })
    expect(node.scrollLeft).toBe(138)
    expect(lineWheel.defaultPrevented).toBe(true)

    const horizontal = new WheelEvent('wheel', { deltaX: 80, deltaY: 10, cancelable: true })
    act(() => { node.dispatchEvent(horizontal) })
    expect(node.scrollLeft).toBe(138)
    expect(horizontal.defaultPrevented).toBe(false)

    total = 100
    const noOverflow = new WheelEvent('wheel', { deltaY: 60, cancelable: true })
    act(() => { node.dispatchEvent(noOverflow) })
    expect(node.scrollLeft).toBe(138)
    expect(noOverflow.defaultPrevented).toBe(false)
  })

  it('溢出时左键越过阈值后拖动平移并抑制松手点击，小幅点击不误触发拖动', () => {
    const onItemClick = vi.fn()
    render(<Host onItemClick={onItemClick} />)
    const node = screen.getByTestId('viewport')
    const button = screen.getByRole('button', { name: '长路径' })
    node.scrollLeft = 200

    // 小于 4px 阈值的轻微抖动应保留正常点击
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 100, pointerType: 'mouse' })
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 98 })
    expect(node).not.toHaveAttribute('data-dragging')
    expect(node.scrollLeft).toBe(200)
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 98 })
    fireEvent.click(button)
    expect(onItemClick).toHaveBeenCalledTimes(1)

    // 超过阈值进入拖动并抑制随后触发的 click
    fireEvent.pointerDown(button, { button: 0, pointerId: 2, clientX: 100, pointerType: 'mouse' })
    fireEvent.pointerMove(node, { pointerId: 2, clientX: 60 })
    expect(node).toHaveAttribute('data-dragging')
    expect(node.scrollLeft).toBe(240)
    fireEvent.pointerMove(node, { pointerId: 2, clientX: 110 })
    expect(node.scrollLeft).toBe(190)
    fireEvent.pointerUp(node, { pointerId: 2, clientX: 110 })
    expect(node).not.toHaveAttribute('data-dragging')
    fireEvent.click(button)
    expect(onItemClick).toHaveBeenCalledTimes(1)

    // 触摸输入与非左键不接管
    fireEvent.pointerDown(node, { button: 2, pointerId: 3, clientX: 100, pointerType: 'mouse' })
    fireEvent.pointerMove(node, { pointerId: 3, clientX: 20 })
    expect(node).not.toHaveAttribute('data-dragging')
    expect(node.scrollLeft).toBe(190)

    fireEvent.pointerDown(node, { button: 0, pointerId: 4, clientX: 100, pointerType: 'touch' })
    fireEvent.pointerMove(node, { pointerId: 4, clientX: 20 })
    expect(node).not.toHaveAttribute('data-dragging')
    expect(node.scrollLeft).toBe(190)
  })
})
