/** 跟随 owner 与视觉副本的行为回归；注入节点几何，像素正确性另由生产浏览器验证。 */
import { StrictMode, useEffect, useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerDecoration, useMessageScroller, useMessageScrollerFollowing } from './message-scroller'
import { WorkingLine } from './run-trace'

const observers: Array<{ callback: ResizeObserverCallback; disconnected: boolean; targets: Element[] }> = []
const mutations: Array<{ disconnected: boolean }> = []
const sourceSelector = '[data-slot="message-scroller-decoration-source"]'
const decorationSelector = '[data-slot="message-scroller-decoration"]'
function Controls() {
  const api = useMessageScroller()
  const following = useMessageScrollerFollowing()
  return <><button onClick={() => api.scrollToStart()}>定位</button><button onClick={() => api.scrollToMessage('a', { align: 'end', behavior: 'smooth' })}>平滑定位</button><button onClick={() => api.scrollToEnd()}>回底</button><output data-testid="following">{following ? 'following' : 'reading'}</output></>
}
function Source() {
  return <MessageScrollerDecoration><span role="note">工作中</span></MessageScrollerDecoration>
}
function Fixture({ live = true, clock = false }: { live?: boolean; clock?: boolean }) {
  return <StrictMode><MessageScrollerProvider><Controls /><MessageScroller><MessageScrollerViewport><MessageScrollerContent><MessageScrollerItem messageId="a">正文</MessageScrollerItem>{live && (clock ? <WorkingLine startTs={1_000} /> : <Source />)}</MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider></StrictMode>
}
// 父树同批更新以及每种节点单独替换，覆盖库合并 ref 的 detach/attach。
function LifecycleFixture({ session = 'a', generation = 0, viewportGeneration = 0, contentGeneration = 0, sourceGeneration = 0 }: { session?: string; generation?: number; viewportGeneration?: number; contentGeneration?: number; sourceGeneration?: number }) {
  const [tick, setTick] = useState(0)
  useEffect(() => { setTick(1) }, [])
  return <MessageScrollerProvider><MessageScroller key={generation}><MessageScrollerViewport key={viewportGeneration} data-tick={tick}><MessageScrollerContent key={contentGeneration}><MessageScrollerItem key={session} messageId={session}>正文</MessageScrollerItem><Source key={sourceGeneration} /></MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider>
}
beforeEach(() => {
  observers.length = 0
  mutations.length = 0
  const NativeMutationObserver = globalThis.MutationObserver
  vi.stubGlobal('MutationObserver', class extends NativeMutationObserver {
    entry = { disconnected: false }
    constructor(callback: MutationCallback) { super(callback); mutations.push(this.entry) }
    override disconnect() { this.entry.disconnected = true; super.disconnect() }
  })
  vi.stubGlobal('ResizeObserver', class {
    entry: (typeof observers)[number]
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, disconnected: false, targets: [] }; observers.push(this.entry) }
    observe(target: Element) { this.entry.targets.push(target) }
    unobserve() {}
    disconnect() { this.entry.disconnected = true }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions | number) {
    this.scrollTop = typeof options === 'number' ? options : options.top ?? 0
  } })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function resize(...targets: Element[]) {
  act(() => {
    for (const observer of observers.filter((entry) => !entry.disconnected && entry.targets.some((target) => targets.includes(target)))) {
      observer.callback(targets.map((target) => ({ target } as ResizeObserverEntry)), {} as ResizeObserver)
    }
  })
}
function box(top: number, bottom: number, left = 0, right = 800): DOMRect {
  return { x: left, y: top, top, bottom, left, right, height: bottom - top, width: right - left, toJSON: () => ({}) }
}
function geometry(initialHeight = 1_000) {
  const viewport = screen.getByRole('region')
  const content = screen.getByRole('log')
  const root = viewport.closest<HTMLElement>('[data-slot="message-scroller"]')!
  const source = content.querySelector<HTMLElement>(sourceSelector)!
  let height = initialHeight
  let top = Math.max(0, height - 600)
  let residual = 0.75
  let sourceOffset = 0
  let sourceHeight = 20
  let writes = 0
  const translate = () => Number.parseFloat(content.style.translate.split(' ')[1] || '0')
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 600 },
    clientWidth: { configurable: true, get: () => 800 },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { writes++; top = Math.max(0, Math.min(value, height - 600)) } },
  })
  const rootRect = vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => box(0, 600))
  const viewportRect = vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => box(0, 600))
  const contentRect = vi.spyOn(content, 'getBoundingClientRect').mockImplementation(() => {
    const bottom = Math.max(height, 600) - top + residual + translate()
    return box(bottom - Math.max(height, 600), bottom)
  })
  const sourceRect = vi.spyOn(source, 'getBoundingClientRect').mockImplementation(() => {
    const bottom = height - top - 12 + residual + translate() + sourceOffset
    return box(bottom - sourceHeight, bottom, 64, 264)
  })
  return {
    viewport, content, root, source, rootRect, viewportRect, contentRect, sourceRect,
    resize: () => resize(content), grow: () => { height += 61.5 },
    height: (value: number) => { height = value }, residual: (value: number) => { residual = value },
    sourceOffset: (value: number) => { sourceOffset = value }, sourceHeight: (value: number) => { sourceHeight = value },
    writes: () => writes, decoration: () => root.querySelector<HTMLElement>(decorationSelector),
  }
}
describe('MessageScroller 跟随状态', () => {
  it.each([0, 0.5, 1, 2])('上滚首帧仅离底%s像素，旧scroll和RO都不能重新吸回', (distance) => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    fireEvent.wheel(g.viewport, { deltaY: -0.5 })
    g.viewport.scrollTop = 400 - distance
    const writes = g.writes()
    fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('reading')
    expect(g.viewport.scrollTop).toBe(400 - distance)
    expect(g.writes()).toBe(writes)
    g.grow(); g.resize()
    expect(g.viewport.scrollTop).toBe(400 - distance)
    expect(g.writes()).toBe(writes)
    view.unmount()
  })

  it('capture先释放上滚意图，正文自己的bubble处理前就已reading且不吞默认输入', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    let observed = 'not-called'
    g.content.addEventListener('wheel', () => { observed = g.source.style.opacity })
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -1 })
    fireEvent(g.content, event)
    // React文字可在事件批次末提交；源的透明度由following订阅同栈恢复。
    expect(observed).toBe('')
    expect(screen.getByTestId('following')).toHaveTextContent('reading')
    expect(event.defaultPrevented).toBe(false)
    view.unmount()
  })

  it('跟随底部的向下滚轮不退出following', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    fireEvent.wheel(g.viewport, { deltaY: 12 })
    expect(screen.getByTestId('following')).toHaveTextContent('following')
    expect(g.decoration()).not.toBeNull()
    g.grow(); g.resize()
    expect(g.viewport.scrollTop).toBe(461.5)
    view.unmount()
  })

  it('靠近底部的程序scroll不恢复，真正向下移动到底才恢复', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    fireEvent.wheel(g.viewport, { deltaY: -10 })
    g.viewport.scrollTop = 100; fireEvent.scroll(g.viewport)
    g.viewport.scrollTop = 399.5; fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('reading')
    fireEvent.wheel(g.viewport, { deltaY: 12 })
    g.viewport.scrollTop = 400; fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('following')
    g.grow(); g.resize()
    expect(g.viewport.scrollTop).toBe(461.5)
    view.unmount()
  })

  it('向下手势之后的终态高度缩回不能冒充用户回底', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    fireEvent.wheel(g.viewport, { deltaY: -10 })
    g.viewport.scrollTop = 100; fireEvent.scroll(g.viewport)
    fireEvent.wheel(g.viewport, { deltaY: 12 })
    g.height(650); g.viewport.scrollTop = 50; g.resize(); fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('reading')
    expect(g.decoration()).toBeNull()
    g.grow(); g.resize()
    expect(g.viewport.scrollTop).toBe(50)
    view.unmount()
  })

  it('索引平滑定位落点接近底部也不恢复跟随', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    const item = g.content.querySelector<HTMLElement>('[data-message-id="a"]')!
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(box(499.5, 599.5))
    fireEvent.click(screen.getByText('平滑定位'))
    fireEvent.scroll(g.viewport)
    expect(g.viewport.scrollTop).toBe(399.5)
    expect(screen.getByTestId('following')).toHaveTextContent('reading')
    view.unmount()
  })

  it.each(['wheel', 'keyboard', 'touch'] as const)('已在底部但reading时，%s明确向下即恢复，不依赖不存在的scroll', (input) => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    if (input === 'touch') {
      fireEvent.touchStart(g.viewport, { touches: [{ clientY: 200 }] })
      fireEvent.touchMove(g.viewport, { touches: [{ clientY: 100 }] })
    } else {
      fireEvent.wheel(g.viewport, { deltaY: -0.1 })
      if (input === 'wheel') fireEvent.wheel(g.viewport, { deltaY: 0.1 })
      else fireEvent.keyDown(g.viewport, { key: 'End' })
    }
    expect(screen.getByTestId('following')).toHaveTextContent('following')
    g.grow(); g.resize()
    expect(g.viewport.scrollTop).toBe(461.5)
    view.unmount()
  })

  it('下行手势结束后资格清除，之后的程序scroll不能恢复', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    fireEvent.wheel(g.viewport, { deltaY: -10 })
    g.viewport.scrollTop = 100; fireEvent.scroll(g.viewport)
    fireEvent.wheel(g.viewport, { deltaY: 10 })
    g.viewport.scrollTop = 150; fireEvent.scroll(g.viewport)
    fireEvent(g.viewport, new Event('scrollend'))
    g.viewport.scrollTop = 400; fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('reading')
    view.unmount()
  })

  it('旧平滑目标在用户输入前被instant截停，不吞原生wheel或误清新手势', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    const item = g.content.querySelector<HTMLElement>('[data-message-id="a"]')!
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(box(300, 400))
    const scroll = vi.spyOn(g.viewport, 'scrollTo')
    fireEvent.click(screen.getByText('平滑定位'))
    expect(scroll).toHaveBeenLastCalledWith({ top: 200, behavior: 'smooth' })
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -1 })
    fireEvent(g.viewport, event)
    expect(scroll).toHaveBeenLastCalledWith({ top: 200, behavior: 'instant' })
    expect(event.defaultPrevented).toBe(false)
    fireEvent.wheel(g.viewport, { deltaY: 10 })
    g.viewport.scrollTop = 210; fireEvent.scroll(g.viewport)
    // 被截停程序目标的迟到end，不应撤掉后来真实用户向下滚动的资格。
    fireEvent(g.viewport, new Event('scrollend'))
    g.viewport.scrollTop = 400; fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('following')
    view.unmount()
  })

  it('自然结束的程序smooth不遗留标记，之后用户scrollend能正常清资格', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    const item = g.content.querySelector<HTMLElement>('[data-message-id="a"]')!
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(box(300, 400))
    fireEvent.click(screen.getByText('平滑定位'))
    fireEvent.scroll(g.viewport)
    fireEvent(g.viewport, new Event('scrollend'))
    fireEvent.wheel(g.viewport, { deltaY: 10 })
    g.viewport.scrollTop = 210; fireEvent.scroll(g.viewport)
    fireEvent(g.viewport, new Event('scrollend'))
    g.viewport.scrollTop = 400; fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('reading')
    view.unmount()
  })

  it('触摸离手后的真实惯性仍可回底，结束后不会保留过期资格', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    fireEvent.touchStart(g.viewport, { touches: [{ clientY: 200 }] })
    fireEvent.touchMove(g.viewport, { touches: [{ clientY: 250 }] })
    g.viewport.scrollTop = 100; fireEvent.scroll(g.viewport)
    fireEvent.touchMove(g.viewport, { touches: [{ clientY: 100 }] })
    g.viewport.scrollTop = 200; fireEvent.scroll(g.viewport)
    fireEvent.touchEnd(g.viewport)
    g.viewport.scrollTop = 400; fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('following')
    view.unmount()
  })

  it('滚动条未知方向的按下不恢复，拖到真实底部才恢复', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    fireEvent.pointerDown(g.viewport, { clientX: 1_000 })
    expect(screen.getByTestId('following')).toHaveTextContent('reading')
    g.viewport.scrollTop = 200; fireEvent.scroll(g.viewport)
    fireEvent.pointerMove(window, { clientX: 1_000, clientY: 500 })
    g.viewport.scrollTop = 400; fireEvent.scroll(g.viewport)
    expect(screen.getByTestId('following')).toHaveTextContent('following')
    fireEvent.pointerUp(window)
    view.unmount()
  })

  it('父树同批更新、会话切换和 root 重挂只绑定当前节点代次', () => {
    const view = render(<StrictMode><LifecycleFixture /></StrictMode>)
    const firstViewport = screen.getByRole('region')
    const firstSource = view.container.querySelector(sourceSelector)
    expect(firstSource).not.toBeNull()
    view.rerender(<StrictMode><LifecycleFixture session="b" /></StrictMode>)
    expect(screen.getByRole('region')).toBe(firstViewport)
    expect(view.container.querySelector(sourceSelector)).toBe(firstSource)
    const g = geometry(); g.resize()
    const oldDecoration = g.decoration()!
    const previous = [...observers]
    view.rerender(<StrictMode><LifecycleFixture session="c" generation={1} /></StrictMode>)
    expect(screen.getByRole('region')).not.toBe(firstViewport)
    expect(oldDecoration.isConnected).toBe(false)
    expect(previous.every((entry) => entry.disconnected)).toBe(true)
    const currentViewport = screen.getByRole('region')
    expect(observers.filter((entry) => !entry.disconnected).every((entry) => entry.targets.every((node) => node.isConnected))).toBe(true)
    expect(observers.filter((entry) => !entry.disconnected).some((entry) => entry.targets.includes(currentViewport))).toBe(true)
    const next = geometry(); next.resize()
    expect(next.decoration()).not.toBeNull()
    view.unmount()
    expect(observers.every((entry) => entry.disconnected)).toBe(true)
    expect(mutations.every((entry) => entry.disconnected)).toBe(true)
    expect(view.container.querySelector(sourceSelector)).toBeNull()
  })
  it('保留 controller 仅替换 viewport 时撤销旧节点订阅', () => {
    const view = render(<StrictMode><LifecycleFixture /></StrictMode>)
    const g = geometry(); g.resize()
    const old = g.viewport
    const oldDecoration = g.decoration()!
    view.rerender(<StrictMode><LifecycleFixture viewportGeneration={1} /></StrictMode>)
    expect(old.isConnected).toBe(false)
    expect(oldDecoration.isConnected).toBe(false)
    expect(observers.filter((entry) => entry.targets.includes(old)).every((entry) => entry.disconnected)).toBe(true)
    expect(observers.filter((entry) => !entry.disconnected).every((entry) => entry.targets.every((node) => node.isConnected))).toBe(true)
    const next = geometry(); next.resize()
    expect(next.decoration()).not.toBeNull()
    view.unmount()
    expect(observers.every((entry) => entry.disconnected)).toBe(true)
    expect(mutations.every((entry) => entry.disconnected)).toBe(true)
  })
  it('短内容和恰好等高均保留流内可访问源，不固定到底部', () => {
    for (const height of [400, 600]) {
      const view = render(<Fixture />)
      const g = geometry(height); g.resize()
      expect(within(g.content).getByRole('note')).toHaveTextContent('工作中')
      expect(g.source.style.opacity).toBe('')
      expect(g.source).not.toHaveAttribute('aria-hidden')
      expect(g.decoration()).toBeNull()
      expect(view.container.querySelector('[data-slot="live-working-slot"]')).toBeNull()
      view.unmount()
    }
  })
  it('StrictMode 后尺寸变化仍贴底，定位只撤视觉副本，显式回底后继续跟随', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    expect(g.content.style.translate).toBe('0 -0.75px')
    expect(g.decoration()).not.toBeNull()
    fireEvent.click(screen.getByText('定位'))
    expect(g.content.style.translate).toBe('')
    expect(g.decoration()).toBeNull()
    expect(g.source.style.opacity).toBe('')
    expect(within(g.content).getByRole('note')).toHaveTextContent('工作中')
    const readingTop = g.viewport.scrollTop
    const writes = g.writes()
    g.grow(); g.resize()
    expect(g.viewport.scrollTop).toBe(readingTop)
    expect(g.writes()).toBe(writes)
    fireEvent.click(screen.getByText('回底'))
    expect(g.decoration()).not.toBeNull()
    expect(g.viewport.scrollTop).toBe(461.5)
    g.grow(); g.resize()
    expect(g.viewport.scrollTop).toBe(523)
    view.unmount()
    expect(observers.every((entry) => entry.disconnected)).toBe(true)
  })
  it('上翻、触摸、键盘和滚动条立即撤副本并保留源；真实到底恢复', () => {
    const releaseCases = [
      [() => fireEvent.wheel(screen.getByRole('region'), { deltaY: -10 }),
        () => fireEvent.wheel(screen.getByRole('region'), { deltaY: 10 })],
      [() => fireEvent.touchStart(screen.getByRole('region'), { touches: [{ clientY: 200 }] }),
        () => fireEvent.touchMove(screen.getByRole('region'), { touches: [{ clientY: 100 }] })],
      [() => fireEvent.keyDown(screen.getByRole('region'), { key: 'PageUp' }),
        () => fireEvent.keyDown(screen.getByRole('region'), { key: 'End' })],
      [() => fireEvent.pointerDown(screen.getByRole('region'), { clientX: 1_000 }),
        () => fireEvent.pointerMove(window, { clientX: 1_000, clientY: 500 })],
    ]
    for (const [release, toward] of releaseCases) {
      const view = render(<Fixture />)
      const g = geometry(); g.resize()
      const writes = g.writes()
      release()
      expect(g.writes()).toBe(writes)
      expect(g.source.isConnected).toBe(true)
      expect(g.source.style.opacity).toBe('')
      expect(g.decoration()).toBeNull()
      g.viewport.scrollTop = 100
      const readingWrites = g.writes()
      g.grow(); g.resize()
      expect(g.viewport.scrollTop).toBe(100)
      expect(g.writes()).toBe(readingWrites)
      expect(g.content.style.translate).toBe('')
      toward()
      g.viewport.scrollTop = 461.5
      fireEvent.scroll(g.viewport)
      expect(g.decoration()).not.toBeNull()
      g.grow(); g.resize()
      expect(g.viewport.scrollTop).toBe(523)
      view.unmount()
    }
  })
  it('有限残差之外不补偿，不靠循环追赶布局', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.residual(12); g.resize()
    expect(g.content.style.translate).toBe('')
    g.residual(-0.4); g.resize()
    expect(Number.parseFloat(g.content.style.translate.split(' ')[1])).toBeCloseTo(0.4)
    view.unmount()
  })
})
describe('MessageScroller 流内源与视觉副本', () => {
  it('严格溢出时 portal 属于同一 root 且在 log 外，源透明但保留唯一可访问文本', () => {
    const view = render(<Fixture />)
    const g = geometry(600.01); g.resize()
    const decoration = g.decoration()!
    expect(decoration.parentElement).toBe(g.root)
    expect(decoration.closest('[role="log"]')).toBeNull()
    expect(decoration).toHaveAttribute('aria-hidden', 'true')
    expect(decoration).toHaveClass('pointer-events-none', 'absolute')
    expect(decoration.style.top).toBe('568px')
    expect(decoration.style.left).toBe('64px')
    expect(g.source.style.opacity).toBe('0')
    expect(g.source.style.display).toBe('')
    expect(g.source.style.visibility).toBe('')
    expect(g.source).not.toHaveAttribute('aria-hidden')
    expect(screen.getAllByRole('note')).toHaveLength(1)
    expect(screen.getAllByRole('note', { hidden: true })).toHaveLength(2)
    view.unmount()
  })
  it('溢出缩回等高、源裁切和零高度时撤副本，尺寸恢复后重新显示', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    expect(g.decoration()).not.toBeNull()
    g.height(600); g.resize()
    expect(g.decoration()).toBeNull()
    expect(g.source.style.opacity).toBe('')
    g.height(1_000); g.resize()
    expect(g.decoration()).not.toBeNull()
    g.sourceOffset(40); resize(g.source)
    expect(g.decoration()).toBeNull()
    expect(g.source.style.opacity).toBe('')
    g.sourceOffset(0); resize(g.source)
    expect(g.decoration()).not.toBeNull()
    g.sourceHeight(0); resize(g.source)
    expect(g.decoration()).toBeNull()
    expect(g.source.style.opacity).toBe('')
    g.sourceHeight(20); resize(g.source)
    expect(g.decoration()).not.toBeNull()
    view.unmount()
  })
  it('content 和 source 单独换代均清理旧副本及观察器，终止时恢复源透明度', () => {
    const view = render(<StrictMode><LifecycleFixture /></StrictMode>)
    let g = geometry(); g.resize()
    for (const props of [{ contentGeneration: 1 }, { contentGeneration: 1, sourceGeneration: 1 }]) {
      const oldSource = g.source
      const oldDecoration = g.decoration()!
      const oldSourceObservers = observers.filter((entry) => !entry.disconnected && entry.targets.includes(oldSource))
      view.rerender(<StrictMode><LifecycleFixture {...props} /></StrictMode>)
      expect(oldSource.isConnected).toBe(false)
      expect(oldSource.style.opacity).toBe('')
      expect(oldDecoration.isConnected).toBe(false)
      expect(oldSourceObservers.every((entry) => entry.disconnected)).toBe(true)
      expect(observers.filter((entry) => !entry.disconnected).every((entry) => entry.targets.every((node) => node.isConnected))).toBe(true)
      g = geometry(); g.resize()
      expect(g.decoration()).not.toBeNull()
    }
    const source = g.source
    view.unmount()
    expect(source.style.opacity).toBe('')
    expect(observers.every((entry) => entry.disconnected)).toBe(true)
    expect(mutations.every((entry) => entry.disconnected)).toBe(true)
  })
  it('内容增长先由 owner pin，再启用副本；持续 delta 不复制源 y 或搬动副本', () => {
    const view = render(<Fixture />)
    const g = geometry(600); g.resize()
    expect(g.decoration()).toBeNull()
    // 增长后、pin 前源落到视口下方；装饰必须等 pin 后再检查裁切。
    g.grow()
    expect(g.source.getBoundingClientRect().bottom).toBeGreaterThan(600)
    g.resize()
    expect(g.viewport.scrollTop).toBe(61.5)
    const decoration = g.decoration()!
    expect(decoration).not.toBeNull()
    const initialTop = decoration.style.top
    const initialLeft = decoration.style.left
    const computed = vi.spyOn(globalThis, 'getComputedStyle')
    g.rootRect.mockClear(); computed.mockClear()
    for (const residual of [0.15, 0.65, -0.35, 0.45]) {
      g.residual(residual); g.grow(); g.resize()
      expect(g.decoration()).toBe(decoration)
      expect(decoration.style.top).toBe(initialTop)
      expect(decoration.style.left).toBe(initialLeft)
    }
    expect(g.rootRect).not.toHaveBeenCalled()
    expect(computed).not.toHaveBeenCalled()
    view.unmount()
  })
  it('后置提示改变尾距时重定位，pin 后发现源已裁切则撤副本', () => {
    const view = render(<Fixture />)
    const g = geometry(); g.resize()
    const initialTop = Number.parseFloat(g.decoration()!.style.top)
    g.sourceOffset(-40); g.grow(); g.resize()
    expect(Number.parseFloat(g.decoration()!.style.top)).toBeCloseTo(initialTop - 40)
    g.sourceOffset(-700); g.grow(); g.resize()
    expect(g.decoration()).toBeNull()
    expect(g.source.style.opacity).toBe('')
    g.sourceOffset(0); g.grow(); g.resize()
    expect(Number.parseFloat(g.decoration()!.style.top)).toBeCloseTo(initialTop)
    view.unmount()
  })
  it('工作行只运行一份计时器，副本与源数字同步且码表更新不读取几何', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const interval = vi.spyOn(globalThis, 'setInterval')
    const clearInterval = vi.spyOn(globalThis, 'clearInterval')
    const view = render(<Fixture clock />)
    const g = geometry(); g.resize()
    const decoration = g.decoration()!
    const sourceDescription = g.source.querySelector('[data-slot="trace-description"]')!
    const visualDescription = decoration.querySelector('[data-slot="trace-description"]')!
    expect(sourceDescription).toHaveTextContent('1.00s')
    expect(visualDescription.textContent).toBe(sourceDescription.textContent)
    expect(interval.mock.calls.length - clearInterval.mock.calls.length).toBe(1)
    // 先交付库在挂载/RO 时排出的状态同步 rAF，隔离真正的码表文本更新。
    act(() => { vi.advanceTimersByTime(64) })
    g.rootRect.mockClear(); g.viewportRect.mockClear(); g.contentRect.mockClear(); g.sourceRect.mockClear()
    act(() => { vi.advanceTimersByTime(100) })
    expect(sourceDescription).toHaveTextContent('1.10s')
    expect(visualDescription.textContent).toBe(sourceDescription.textContent)
    expect(g.rootRect).not.toHaveBeenCalled()
    expect(g.viewportRect).not.toHaveBeenCalled()
    expect(g.contentRect).not.toHaveBeenCalled()
    expect(g.sourceRect).not.toHaveBeenCalled()
    expect(sourceDescription.closest('[aria-live]')).toBeNull()
    view.unmount()
    expect(interval.mock.calls.length).toBe(clearInterval.mock.calls.length)
  })
})
