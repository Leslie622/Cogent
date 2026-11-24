/** 侧边栏悬停指示器：进入落位、行间滑行与自适应高度、inert 忽略、离场归零。 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSidebarHoverPill } from '@/hooks/use-sidebar-hover-pill'

function Harness() {
  const { containerRef, pillRef } = useSidebarHoverPill()
  return (
    <div ref={containerRef} data-testid="list" className="relative">
      <div ref={pillRef} data-testid="pill" data-visible="false" />
      <button type="button" data-sidebar-row>第一行</button>
      <button type="button" data-sidebar-row>第二行</button>
      <div inert>
        <button type="button" data-sidebar-row>禁用行</button>
      </div>
    </div>
  )
}

function mockRect(el: Element, rect: { top: number; height: number; width?: number }) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: rect.top,
    top: rect.top,
    left: 0,
    right: rect.width ?? 220,
    bottom: rect.top + rect.height,
    width: rect.width ?? 220,
    height: rect.height,
    toJSON: () => ({}),
  })
}

describe('useSidebarHoverPill', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('跟随指针在列表行间滑动并更新位置、高度与 data-pill-over', () => {
    render(<Harness />)
    const list = screen.getByTestId('list')
    const pill = screen.getByTestId('pill')
    const first = screen.getByRole('button', { name: '第一行' })
    const second = screen.getByRole('button', { name: '第二行' })
    const hidden = screen.getByRole('button', { name: '禁用行' })

    mockRect(list, { top: 100, height: 200 })
    mockRect(first, { top: 108, height: 28 })
    mockRect(second, { top: 140, height: 32 })
    mockRect(hidden, { top: 176, height: 32 })

    fireEvent.pointerOver(first, { clientX: 20, clientY: 115 })
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(pill.style.getPropertyValue('--pill-y')).toBe('8px')
    expect(pill.style.getPropertyValue('--pill-h')).toBe('28px')
    expect(first).toHaveAttribute('data-pill-over', '')

    fireEvent.pointerOver(second, { clientX: 20, clientY: 150 })
    expect(pill).toHaveAttribute('data-visible', 'true')
    expect(pill.style.getPropertyValue('--pill-y')).toBe('40px')
    expect(pill.style.getPropertyValue('--pill-h')).toBe('32px')
    expect(first).not.toHaveAttribute('data-pill-over')
    expect(second).toHaveAttribute('data-pill-over', '')

    // inert 分区内元素触发延迟收起，不落到禁用行
    fireEvent.pointerOver(hidden, { clientX: 20, clientY: 185 })
    expect(second).toHaveAttribute('data-pill-over', '')
    vi.advanceTimersByTime(70)
    expect(pill).toHaveAttribute('data-visible', 'false')
    expect(second).not.toHaveAttribute('data-pill-over')
    expect(hidden).not.toHaveAttribute('data-pill-over')
  })

  it('指针离开容器后立即隐藏指示器并清理状态', () => {
    render(<Harness />)
    const list = screen.getByTestId('list')
    const pill = screen.getByTestId('pill')
    const first = screen.getByRole('button', { name: '第一行' })

    mockRect(list, { top: 0, height: 100 })
    mockRect(first, { top: 0, height: 32 })

    fireEvent.pointerOver(first, { clientX: 10, clientY: 10 })
    expect(pill).toHaveAttribute('data-visible', 'true')

    fireEvent.pointerLeave(list)
    expect(pill).toHaveAttribute('data-visible', 'false')
    expect(first).not.toHaveAttribute('data-pill-over')
  })
})
