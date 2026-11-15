/**
 * use-scrollbar-auto-hide 测试 —— 钉「不滚动即隐藏」的标记生命周期契约：
 * 滚动即挂 data-scrolling、静默 600ms 摘除、静默期内再滚重置计时、
 * 视口滚动（target 是 Document）落到 documentElement。滑块显隐本身是
 * Chromium 伪元素样式（globals.css），jsdom 无从断言，不在本件范围。
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useScrollbarAutoHide } from './use-scrollbar-auto-hide'

function Host() {
  useScrollbarAutoHide()
  return <div data-testid="scroller" />
}

describe('useScrollbarAutoHide', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    // 挂到 html 上的标记不在 React 树内，RTL cleanup 管不到，跨用例手动清
    document.documentElement.removeAttribute('data-scrolling')
    vi.useRealTimers()
  })

  it('滚动即挂 data-scrolling，静默 600ms 后摘除', () => {
    const { getByTestId } = render(<Host />)
    const scroller = getByTestId('scroller')
    // scroll 不冒泡（Event 默认 bubbles:false），恰好验证捕获相位可达 document
    scroller.dispatchEvent(new Event('scroll'))
    expect(scroller).toHaveAttribute('data-scrolling')
    vi.advanceTimersByTime(599)
    expect(scroller).toHaveAttribute('data-scrolling')
    vi.advanceTimersByTime(1)
    expect(scroller).not.toHaveAttribute('data-scrolling')
  })

  it('静默期内再滚动重置计时', () => {
    const { getByTestId } = render(<Host />)
    const scroller = getByTestId('scroller')
    scroller.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(500)
    scroller.dispatchEvent(new Event('scroll'))
    // 距第二次滚动仅 500ms，仍在静默期
    vi.advanceTimersByTime(500)
    expect(scroller).toHaveAttribute('data-scrolling')
    vi.advanceTimersByTime(100)
    expect(scroller).not.toHaveAttribute('data-scrolling')
  })

  it('视口滚动（target 为 Document）标记挂到 documentElement', () => {
    render(<Host />)
    document.dispatchEvent(new Event('scroll'))
    expect(document.documentElement).toHaveAttribute('data-scrolling')
  })
})
