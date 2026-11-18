/** 布局断点订阅只接收实际匹配变化，查询更换/卸载后不残留监听。 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWindowMediaQuery } from '@/hooks/use-window-media-query'

const entries = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')
beforeEach(() => {
  entries.clear()
  window.matchMedia = vi.fn((query: string) => {
    if (!entries.has(query)) entries.set(query, { matches: false, listeners: new Set() })
    const entry = entries.get(query)!
    return { get matches() { return entry.matches }, addEventListener: (_type: string, listener: () => void) => entry.listeners.add(listener), removeEventListener: (_type: string, listener: () => void) => entry.listeners.delete(listener) } as unknown as MediaQueryList
  })
})
afterEach(() => {
  if (original) Object.defineProperty(window, 'matchMedia', original)
  else Reflect.deleteProperty(window, 'matchMedia')
})

describe('窗口布局断点', () => {
  it('跨阈值更新，换查询后撤销旧监听，卸载清理新监听', () => {
    const view = renderHook(({ query }) => useWindowMediaQuery(query), { initialProps: { query: '(max-width: 760px)' } })
    expect(view.result.current).toBe(false)
    const first = entries.get('(max-width: 760px)')!
    act(() => { first.matches = true; first.listeners.forEach((listener) => listener()) })
    expect(view.result.current).toBe(true)
    view.rerender({ query: '(max-width: 1100px)' })
    expect(first.listeners.size).toBe(0)
    expect(view.result.current).toBe(false)
    view.unmount()
    expect(entries.get('(max-width: 1100px)')!.listeners.size).toBe(0)
  })
})
