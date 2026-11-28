/** SidebarResizeHandle 拖拽落点回归：下限以上跟手、下限以下钉在下限（阻力区）、
 * 越过折叠阈值才折叠、折叠后拖出阈值恢复；阈值由使用方指定（工作区 200→100）。
 * jsdom 无 PointerEvent、也不维护活跃指针表 —— 指针事件与捕获三件套的桩法
 * 同 image-preview.render.test.tsx。 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarResizeHandle } from '@/components/SidebarResizeHandle'

const MIN = 160
const MAX = 700
const THRESHOLD = MIN / 2

class PointerEventStub extends MouseEvent {
  readonly pointerId: number
  readonly pointerType: string
  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options)
    this.pointerId = options.pointerId ?? 1
    this.pointerType = options.pointerType ?? 'mouse'
  }
}

const oldPointerMethods = new Map(
  ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'].map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
)
const captured = new WeakMap<HTMLElement, Set<number>>()

/** 组件的 rAF 直写节流：把排到本帧之后的回调跑完 */
function nextFrame() {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

function stage(startWidth: number, max: number | (() => number) = MAX) {
  const writeWidth = vi.fn()
  const onCommit = vi.fn()
  render(
    <SidebarResizeHandle
      side="right"
      min={MIN}
      max={max}
      collapseThreshold={THRESHOLD}
      readWidth={() => startWidth}
      writeWidth={writeWidth}
      onCommit={onCommit}
      onReset={() => {}}
    />
  )
  return { handle: screen.getByRole('separator'), writeWidth, onCommit }
}

/** 右侧面板 direction = -1：raw = start - (clientX - startX)，指针向右移 = 面板变窄 */
function drag(handle: HTMLElement, pointerId: number, fromX: number, toX: number) {
  fireEvent.pointerDown(handle, { button: 0, pointerId, clientX: fromX })
  fireEvent.pointerMove(window, { pointerId, clientX: toX })
}

describe('SidebarResizeHandle 阻力区与折叠阈值', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', PointerEventStub)
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: {
        configurable: true,
        value: function (this: HTMLElement, id: number) {
          let ids = captured.get(this)
          if (!ids) { ids = new Set(); captured.set(this, ids) }
          ids.add(id)
        }
      },
      hasPointerCapture: { configurable: true, value: function (this: HTMLElement, id: number) { return captured.get(this)?.has(id) ?? false } },
      releasePointerCapture: { configurable: true, value: function (this: HTMLElement, id: number) { captured.get(this)?.delete(id) } }
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    for (const [name, descriptor] of oldPointerMethods) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, name)
    }
  })

  it('下限以上 1:1 跟手', async () => {
    const { handle, writeWidth, onCommit } = stage(350)
    drag(handle, 1, 500, 580) // raw = 350 - 80 = 270
    await nextFrame()
    expect(writeWidth).toHaveBeenLastCalledWith(270)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 580 })
    expect(onCommit).toHaveBeenCalledWith(270)
  })

  it('容器变化后，拖拽与键盘均现读宽度上限', async () => {
    let max = 400
    const { handle, writeWidth, onCommit } = stage(350, () => max)
    max = 360
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(writeWidth).toHaveBeenLastCalledWith(360)
    max = 500
    drag(handle, 6, 500, 250)
    await nextFrame()
    expect(writeWidth).toHaveBeenLastCalledWith(500)
    max = 450
    fireEvent.pointerUp(window, { pointerId: 6, clientX: 250 })
    expect(onCommit).toHaveBeenLastCalledWith(450)
  })

  it('拖过下限钉在下限（阻力区），松手提交下限而非折叠', async () => {
    const { handle, writeWidth, onCommit } = stage(350)
    drag(handle, 2, 500, 700) // raw = 350 - 200 = 150，处于 [80, 160) 阻力区
    await nextFrame()
    expect(writeWidth).toHaveBeenLastCalledWith(MIN)
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 700 })
    expect(onCommit).toHaveBeenCalledWith(MIN)
  })

  it('继续内拖越过阈值才折叠', async () => {
    const { handle, writeWidth, onCommit } = stage(350)
    drag(handle, 3, 500, 780) // raw = 70 < 80
    await nextFrame()
    expect(writeWidth).toHaveBeenLastCalledWith(0)
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 780 })
    expect(onCommit).toHaveBeenLastCalledWith(0)
  })

  it('折叠后向外拖出阈值才恢复，松手落到下限', async () => {
    const { handle, writeWidth, onCommit } = stage(0)
    drag(handle, 4, 500, 430) // raw = 0 + 70 < 80：仍在折叠
    await nextFrame()
    expect(writeWidth).toHaveBeenLastCalledWith(0)
    drag(handle, 5, 500, 420) // raw = 80 ≥ 阈值：落到阻力区
    await nextFrame()
    expect(writeWidth).toHaveBeenLastCalledWith(MIN)
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 420 })
    expect(onCommit).toHaveBeenLastCalledWith(MIN)
  })
})
