import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImagePreview from '@/features/home/files/visual/ImagePreview'
import { copyImagePreview } from '@/features/home/files/visual/image-preview-clipboard'
import { useFilePreviewStore } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'

class PointerEventStub extends MouseEvent {
  readonly pointerId: number
  readonly pointerType: string
  constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; this.pointerType = options.pointerType ?? 'mouse' }
}
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  readonly targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) { ResizeObserverStub.instances.push(this) }
  observe = vi.fn((target: Element) => { this.targets.add(target) })
  unobserve = vi.fn((target: Element) => { this.targets.delete(target) })
  disconnect = vi.fn(() => { this.targets.clear() })
  trigger() { this.callback([], this) }
}
class ClipboardItemStub {
  readonly types: string[]
  constructor(readonly data: Record<string, Blob | Promise<Blob>>) { this.types = Object.keys(data) }
  getType(type: string) { return Promise.resolve(this.data[type]) }
}
const oldClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const oldPointerMethods = new Map(['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'].map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]))
let viewportWidth = 600, viewportHeight = 400, tabId = ''
let scrolls = new WeakMap<HTMLElement, { left: number; top: number }>()
let captured = new WeakMap<HTMLElement, Set<number>>()
const writeClipboard = vi.fn<(items: ClipboardItem[]) => Promise<void>>()
const drawSizes: Array<{ width: number; height: number }> = []
function rect(left: number, top: number, width: number, height: number): DOMRect { return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } }
function stageSize(element: HTMLElement, dimension: 'width' | 'height') {
  return Number.parseFloat(element.querySelector<HTMLElement>('[data-image-preview-stage]')?.style[dimension] ?? '') || (dimension === 'width' ? viewportWidth : viewportHeight)
}
function location(element: HTMLElement) {
  let value = scrolls.get(element)
  if (value === undefined) { value = { left: 0, top: 0 }; scrolls.set(element, value) }
  return value
}
beforeEach(() => {
  viewportWidth = 600; viewportHeight = 400; scrolls = new WeakMap(); captured = new WeakMap()
  ResizeObserverStub.instances = []; drawSizes.length = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('PointerEvent', PointerEventStub)
  vi.stubGlobal('ClipboardItem', ClipboardItemStub)
  writeClipboard.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: writeClipboard } })
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: function(this: HTMLElement, id: number) { let value = captured.get(this); if (value === undefined) { value = new Set(); captured.set(this, value) } value.add(id) } },
    hasPointerCapture: { configurable: true, value: function(this: HTMLElement, id: number) { return captured.get(this)?.has(id) ?? false } },
    releasePointerCapture: { configurable: true, value: function(this: HTMLElement, id: number) { captured.get(this)?.delete(id) } }
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-image-preview-viewport') ? viewportWidth : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-image-preview-viewport') ? viewportHeight : 0 })
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockImplementation(function(this: HTMLElement) { return location(this).left })
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function(this: HTMLElement) { return location(this).top })
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'set').mockImplementation(function(this: HTMLElement, value) { location(this).left = Math.max(0, Math.min(value, stageSize(this, 'width') - viewportWidth)) })
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function(this: HTMLElement, value) { location(this).top = Math.max(0, Math.min(value, stageSize(this, 'height') - viewportHeight)) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.hasAttribute('data-image-preview-viewport')) return rect(0, 0, viewportWidth, viewportHeight)
    if (this.hasAttribute('data-image-preview-image')) {
      const parent = this.closest<HTMLElement>('[data-image-preview-viewport]')!, width = Number.parseFloat(this.style.width) || 0, height = Number.parseFloat(this.style.height) || 0
      return rect((stageSize(parent, 'width') - width) / 2 - parent.scrollLeft, (stageSize(parent, 'height') - height) / 2 - parent.scrollTop, width, height)
    }
    return rect(0, 0, 20, 20)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) { return { drawImage: () => drawSizes.push({ width: this.width, height: this.height }) } as unknown as CanvasRenderingContext2D })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['png'], { type })))
  useFilePreviewStore.setState({ current: null, byTab: {}, views: {} })
  useWorkspaceStore.setState({ scopes: {}, recent: [], activeScopeId: '' })
  useWorkspaceStore.getState().setScope('image-test')
  tabId = useWorkspaceStore.getState().openFile({ scope: { sessionId: 'image-test', refs: [] }, target: '/fixtures/image.png' }, 'image-test')
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (oldClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', oldClipboard)
  for (const [name, descriptor] of oldPointerMethods) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
    else Object.defineProperty(HTMLElement.prototype, name, descriptor)
  }
})
function loaded(container: HTMLElement, width = 1000, height = 500) {
  const element = container.querySelector<HTMLImageElement>('[data-image-preview-image]')!
  Object.defineProperties(element, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height }, complete: { configurable: true, value: true } })
  fireEvent.load(element)
  return element
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('图片与SVG的显示和交互', () => {
  it.each(['load', 'error'] as const)('缓存图片的早期%s事件不会被来源effect清空', event => {
    function CachedImage() {
      const host = useRef<HTMLDivElement>(null)
      useLayoutEffect(() => {
        if (event === 'load') loaded(host.current!, 800, 400)
        else fireEvent.error(host.current!.querySelector('img')!)
      }, [])
      return <div ref={host}><ImagePreview url="blob:cached" name="cached.png" tabId={tabId} active onSave={vi.fn()} /></div>
    }
    const view = render(<CachedImage />)
    expect(screen.queryByText('正在解码图片…')).not.toBeInTheDocument()
    if (event === 'load') {
      expect(view.container.querySelector('img')).toHaveStyle({ width: '568px', height: '284px' })
      expect(screen.getByLabelText('复制图片')).not.toBeDisabled()
    } else {
      expect(screen.getByRole('alert')).toHaveTextContent('图片解码失败')
      expect(screen.getByLabelText('复制图片')).toBeDisabled()
    }
  })
  it('Retina原图按逻辑像素显示，复制仍写入完整物理像素PNG', async () => {
    const view = render(<ImagePreview url="blob:retina" name="photo@2x.png" tabId={tabId} active onSave={vi.fn()} />)
    const element = loaded(view.container, 800, 400)
    expect(element).toHaveStyle({ width: '400px', height: '200px' })
    fireEvent.click(screen.getByLabelText('复制图片'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('图片已复制'))
    expect(drawSizes).toEqual([{ width: 800, height: 400 }])
    const item = writeClipboard.mock.calls[0][0][0]
    expect(item.types).toEqual(['image/png'])
    expect((await item.getType('image/png')).type).toBe('image/png')
  })
  it('大图片适配、放大、拖动写入本tab滚动，隐藏不覆盖位置且重新激活恢复', () => {
    const onSave = vi.fn<() => Promise<{ canceled: boolean }>>(), view = render(<ImagePreview url="blob:large" name="large.png" tabId={tabId} active onSave={onSave} />)
    const element = loaded(view.container)
    expect(element).toHaveStyle({ width: '568px', height: '284px' })
    fireEvent.click(screen.getByLabelText('图片原始尺寸'))
    expect(element).toHaveStyle({ width: '1000px', height: '500px' })
    const viewport = view.container.querySelector<HTMLElement>('[data-image-preview-viewport]')!
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 7, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(viewport, { pointerId: 7, clientX: 110, clientY: 65 })
    fireEvent.pointerUp(viewport, { pointerId: 7, clientX: 110, clientY: 65 })
    expect(viewport.scrollLeft).toBe(90); expect(viewport.scrollTop).toBe(35)
    expect(useFilePreviewStore.getState().views[tabId]).toMatchObject({ zoom: 1, scrollLeft: 90, scrollTop: 35 })
    view.rerender(<ImagePreview url="blob:large" name="large.png" tabId={tabId} active={false} onSave={onSave} />)
    viewport.scrollLeft = 0; viewport.scrollTop = 0; fireEvent.scroll(viewport)
    expect(useFilePreviewStore.getState().views[tabId]).toMatchObject({ scrollLeft: 90, scrollTop: 35 })
    view.rerender(<ImagePreview url="blob:large" name="large.png" tabId={tabId} active onSave={onSave} />)
    expect(viewport.scrollLeft).toBe(90); expect(viewport.scrollTop).toBe(35)
  })
  it('滚轮以指针位置缩放并阻止页面跟滚，隐藏移除监听与捕获', () => {
    const view = render(<ImagePreview url="blob:zoom" name="large.png" tabId={tabId} active onSave={vi.fn()} />)
    const element = loaded(view.container)
    const viewport = view.container.querySelector<HTMLElement>('[data-image-preview-viewport]')!
    const original = element.getBoundingClientRect(), imageX = (100 - original.left) / 0.568
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 100, clientY: 150, deltaY: -100 })
    act(() => { viewport.dispatchEvent(wheel) })
    expect(wheel.defaultPrevented).toBe(true)
    const scale = useFilePreviewStore.getState().views[tabId].zoom!
    expect(scale).toBeGreaterThan(0.568)
    expect(element.getBoundingClientRect().left + imageX * scale).toBeCloseTo(100)
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 8, clientX: 100, clientY: 100 })
    expect(viewport.hasPointerCapture(8)).toBe(true)
    view.rerender(<ImagePreview url="blob:zoom" name="large.png" tabId={tabId} active={false} onSave={vi.fn()} />)
    expect(viewport.hasPointerCapture(8)).toBe(false)
    const inactive = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })
    act(() => { viewport.dispatchEvent(inactive) })
    expect(inactive.defaultPrevented).toBe(false)
    expect(useFilePreviewStore.getState().views[tabId].zoom).toBe(scale)
  })
  it('SVG始终是隔离img，渲染滚动与源码阅读位置分别保存', () => {
    useFilePreviewStore.getState().setView(tabId, { zoom: 2, scrollTop: 111, scrollLeft: 222 })
    const view = render(<ImagePreview url="blob:svg" name="drawing.svg" tabId={tabId} active scrollMode="render" onSave={vi.fn()} />)
    loaded(view.container)
    const viewport = view.container.querySelector<HTMLElement>('[data-image-preview-viewport]')!
    expect(viewport.querySelector('svg,script,iframe,object,embed')).toBeNull()
    expect(viewport.querySelector('img')).toHaveAttribute('src', 'blob:svg')
    viewport.scrollTop = 30; viewport.scrollLeft = 40; fireEvent.scroll(viewport)
    expect(useFilePreviewStore.getState().views[tabId]).toMatchObject({ scrollTop: 111, scrollLeft: 222, renderScrollTop: 30, renderScrollLeft: 40 })
    fireEvent.click(screen.getByLabelText('适配图片'))
    expect(useFilePreviewStore.getState().views[tabId]).toMatchObject({ zoom: null, scrollTop: 111, scrollLeft: 222, renderScrollTop: 0, renderScrollLeft: 0 })
  })
  it('重新测量视口适配尺寸，不重建图像；解码失败明确反馈', () => {
    const view = render(<ImagePreview url="blob:resize" name="large.png" tabId={tabId} active onSave={vi.fn()} />)
    const element = loaded(view.container)
    const viewport = view.container.querySelector<HTMLElement>('[data-image-preview-viewport]')!
    viewportWidth = 320
    act(() => { for (const observer of ResizeObserverStub.instances) if (observer.targets.has(viewport)) observer.trigger() })
    expect(view.container.querySelector('img')).toBe(element)
    expect(element).toHaveStyle({ width: '288px', height: '144px' })
    fireEvent.error(element)
    expect(screen.getByRole('alert')).toHaveTextContent('图片解码失败')
    expect(screen.getByLabelText('复制图片')).toBeDisabled()
  })
})

describe('图片原字节动作与异步边界', () => {
  it('下载传给原租约动作，取消不显示成功；拒绝操作保留真实错误', async () => {
    const onSave = vi.fn<() => Promise<{ canceled: boolean }>>().mockResolvedValueOnce({ canceled: true }).mockResolvedValueOnce({ canceled: false }).mockRejectedValueOnce(new Error('保存目录只读'))
    const view = render(<ImagePreview url="blob:save-svg" name="drawing.svg" tabId={tabId} active onSave={onSave} />)
    loaded(view.container)
    fireEvent.click(screen.getByLabelText('下载原图'))
    await waitFor(() => expect(screen.getByLabelText('下载原图')).not.toBeDisabled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('下载原图'))
    expect(await screen.findByRole('status')).toHaveTextContent('原图已另存')
    fireEvent.click(screen.getByLabelText('下载原图'))
    expect(await screen.findByRole('alert')).toHaveTextContent('保存目录只读')
    expect(onSave).toHaveBeenCalledTimes(3)
  })
  it('同一动作不能重复提交，旧来源下载完成不覆盖新图像的状态', async () => {
    const pending = deferred<{ canceled: boolean }>(), onSave = vi.fn<() => Promise<{ canceled: boolean }>>().mockReturnValue(pending.promise)
    const view = render(<ImagePreview url="blob:old" name="old.png" tabId={tabId} active onSave={onSave} />)
    loaded(view.container)
    fireEvent.click(screen.getByLabelText('下载原图')); fireEvent.click(screen.getByLabelText('下载原图'))
    expect(onSave).toHaveBeenCalledOnce()
    view.rerender(<ImagePreview url="blob:new" name="new.png" tabId={tabId} active onSave={vi.fn()} />)
    loaded(view.container)
    await act(async () => { pending.resolve({ canceled: false }); await pending.promise })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(view.container.querySelector('img')).toHaveAttribute('src', 'blob:new')
  })
  it('图片复制权限失败可见；超过Zcode剪贴板像素预算时不建立Canvas', async () => {
    writeClipboard.mockRejectedValueOnce(new Error('剪贴板权限被拒绝'))
    const view = render(<ImagePreview url="blob:copy" name="large.png" tabId={tabId} active onSave={vi.fn()} />)
    const element = loaded(view.container)
    fireEvent.click(screen.getByLabelText('复制图片'))
    expect(await screen.findByRole('alert')).toHaveTextContent('剪贴板权限被拒绝')
    writeClipboard.mockClear(); drawSizes.length = 0
    Object.defineProperties(element, { naturalWidth: { configurable: true, value: 8001 }, naturalHeight: { configurable: true, value: 4000 } })
    await expect(copyImagePreview(element)).rejects.toThrow('3200万像素')
    expect(writeClipboard).not.toHaveBeenCalled(); expect(drawSizes).toHaveLength(0)
  })
  it('键盘可打开右键菜单，隐藏会关闭菜单且再次激活不自动弹出', async () => {
    const view = render(<ImagePreview url="blob:menu" name="menu.png" tabId={tabId} active onSave={vi.fn()} />)
    loaded(view.container)
    fireEvent.keyDown(screen.getByLabelText('图片画布：menu.png'), { key: 'F10', shiftKey: true })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    view.rerender(<ImagePreview url="blob:menu" name="menu.png" tabId={tabId} active={false} onSave={vi.fn()} />)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    view.rerender(<ImagePreview url="blob:menu" name="menu.png" tabId={tabId} active onSave={vi.fn()} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('图片控件行的悬停滑动装配', () => {
  it('缩放四钮一组、「复制 / 下载」一组，倍率文字不是行', () => {
    const { container } = render(<ImagePreview url="blob:slide" name="slide.png" tabId={tabId} active onSave={vi.fn()} />)
    const controls = screen.getByLabelText('图片控件')
    expect(controls).toHaveClass('relative', 'isolate')
    expect(controls.firstElementChild).toHaveClass('hover-slide-pill')
    const own = [...controls.children].filter((el) => el.hasAttribute('data-hover-slide')).map((el) => el.getAttribute('aria-label'))
    expect(own).toEqual(['缩小图片', '适配图片', '图片原始尺寸', '放大图片'])
    const pair = screen.getByRole('button', { name: '复制图片' }).parentElement!
    expect(pair).toHaveClass('relative', 'isolate')
    expect(pair.firstElementChild).toHaveClass('hover-slide-pill')
    expect(pair.querySelectorAll('[data-hover-slide]')).toHaveLength(2)
    expect(container.querySelectorAll('.hover-slide-pill')).toHaveLength(2)
  })
})
