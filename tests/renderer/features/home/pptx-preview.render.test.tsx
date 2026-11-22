import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PptxFiles, PresentationData, SlideData, SlideHandle, SlideRendererOptions, ZipParseLimits } from '@aiden0z/pptx-renderer'
import PptxPreview from '@/features/home/files/visual/PptxPreview'
import { openPptxPresentation } from '@/features/home/files/visual/pptx-engine'
import { useFilePreviewStore } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'

const mocks = vi.hoisted(() => ({
  parse: vi.fn<(buffer: ArrayBuffer, limits?: ZipParseLimits) => Promise<PptxFiles>>(),
  build: vi.fn<(files: PptxFiles, options?: { lazySlides?: boolean }) => PresentationData>(),
  render: vi.fn<(presentation: PresentationData, slide: SlideData, options?: SlideRendererOptions) => SlideHandle>(),
  limits: { maxEntries: 4000, maxEntryUncompressedBytes: 32 * 1024 ** 2, maxTotalUncompressedBytes: 256 * 1024 ** 2, maxMediaBytes: 192 * 1024 ** 2, maxConcurrency: 8 }
}))
vi.mock('@aiden0z/pptx-renderer/browser', () => ({ parseZipLazyMedia: mocks.parse, buildPresentation: mocks.build, renderSlide: mocks.render, RECOMMENDED_ZIP_LIMITS: mocks.limits }))

function presentation(prefix = 'fixture', count = 3): PresentationData {
  return {
    width: 960, height: 540,
    slides: Array.from({ length: count }, (_, index) => ({ index, nodes: [], layoutIndex: '', rels: new Map(), slidePath: `${prefix}/slide${index + 1}.xml`, showMasterSp: true })),
    layouts: new Map(), masters: new Map(), themes: new Map(), slideToLayout: new Map(), layoutToMaster: new Map(), masterToTheme: new Map(), media: new Map(), charts: new Map(), isWps: false
  }
}
function files(): PptxFiles {
  return { contentTypes: '', presentation: '', presentationRels: '', slides: new Map(), slideRels: new Map(), slideLayouts: new Map(), slideLayoutRels: new Map(), slideMasters: new Map(), slideMasterRels: new Map(), themes: new Map(), media: new Map(), charts: new Map(), chartStyles: new Map(), chartColors: new Map(), diagramDrawings: new Map() }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
interface TestHandle extends SlideHandle { dispose: ReturnType<typeof vi.fn<() => void>> }
const handles: TestHandle[] = []
function slideHandle(slide: SlideData, ready = Promise.resolve()): TestHandle {
  const element = document.createElement('div')
  element.setAttribute('data-rendered-slide', slide.slidePath)
  const label = document.createElement('p'); label.textContent = slide.slidePath; element.append(label)
  const media = document.createElement('video'); media.src = 'blob:test-video'; element.append(media)
  const link = document.createElement('a'); link.href = 'https://example.test/deck'; link.textContent = '演示外链'; element.append(link)
  const image = document.createElement('img'); image.src = 'blob:test-image'; element.append(image)
  const dispose = vi.fn<() => void>()
  const handle: TestHandle = { element, ready, dispose, [Symbol.dispose]: dispose }
  handles.push(handle)
  return handle
}
class ResizeObserverStub {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
let tabId = ''
let pause: ReturnType<typeof vi.spyOn>
let load: ReturnType<typeof vi.spyOn>
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
beforeEach(() => {
  mocks.parse.mockReset().mockResolvedValue(files())
  mocks.build.mockReset().mockReturnValue(presentation())
  mocks.render.mockReset().mockImplementation((_presentation, slide) => slideHandle(slide))
  handles.length = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })
  useFilePreviewStore.setState({ current: null, byTab: {}, views: {} })
  useWorkspaceStore.setState({ scopes: {}, recent: [], activeScopeId: '' })
  useWorkspaceStore.getState().setScope('pptx-test')
  tabId = useWorkspaceStore.getState().openFile({ scope: { sessionId: 'pptx-test', refs: [] }, target: '/fixtures/deck.pptx' }, 'pptx-test')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalFonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', originalFonts)
})
const buffer = () => new ArrayBuffer(8)
const ready = async (container: HTMLElement) => waitFor(() => expect(container.querySelector('[data-pptx-preview]')).toHaveAttribute('data-pptx-ready', 'true'))

describe('PPTX视觉内容与页资源归属', () => {
  it('使用推荐ZIP预算与懒页模型，活动页传入本地PDF fallback地址', async () => {
    const data = buffer(), view = render(<PptxPreview buffer={data} name="deck.pptx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    await ready(view.container)
    expect(mocks.parse).toHaveBeenCalledWith(data, mocks.limits)
    expect(mocks.build).toHaveBeenCalledWith(expect.anything(), { lazySlides: true })
    expect(mocks.render).toHaveBeenCalledTimes(1)
    const options = mocks.render.mock.calls[0][2]!
    if (options.pdfjs === false || options.pdfjs === undefined) throw new Error('PPTX没有配置本地PDF fallback')
    expect(options.pdfjs.moduleUrl).toMatch(/\/pdfjs\/pdf\.min\.mjs$/)
    expect(options.pdfjs.workerUrl).toMatch(/\/pdfjs\/pdf\.worker\.min\.mjs$/)
    expect(view.container.querySelector('[data-rendered-slide]')).toHaveAttribute('data-rendered-slide', 'fixture/slide1.xml')
    expect(view.container.querySelector('[data-pptx-slide]')).toHaveAttribute('data-pptx-page', '1')
  })
  it('翻页释放旧handle与媒体；缩放和隐藏保留模型、页码、倍率，激活只重建当前页', async () => {
    const data = buffer(), onOpenUrl = vi.fn(), view = render(<PptxPreview buffer={data} name="deck.pptx" tabId={tabId} active onOpenUrl={onOpenUrl} />)
    await ready(view.container)
    const first = handles[0], media = first.element.querySelector('video')!
    fireEvent.click(screen.getByLabelText('下一张幻灯片'))
    await ready(view.container)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(first.element.isConnected).toBe(false)
    expect(media).not.toHaveAttribute('src')
    expect(pause).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('放大幻灯片'))
    expect(useFilePreviewStore.getState().views[tabId]).toMatchObject({ page: 2, zoom: 1.25 })
    expect(mocks.render).toHaveBeenCalledTimes(2)
    view.rerender(<PptxPreview buffer={data} name="deck.pptx" tabId={tabId} active={false} onOpenUrl={onOpenUrl} />)
    expect(handles[1].dispose).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-rendered-slide]')).toBeNull()
    view.rerender(<PptxPreview buffer={data} name="deck.pptx" tabId={tabId} active onOpenUrl={onOpenUrl} />)
    await ready(view.container)
    expect(mocks.parse).toHaveBeenCalledOnce()
    expect(mocks.render).toHaveBeenCalledTimes(3)
    expect(view.container.querySelector('[data-rendered-slide]')).toHaveAttribute('data-rendered-slide', 'fixture/slide2.xml')
    expect(screen.getByLabelText('适配幻灯片')).toHaveTextContent('125%')
  })
  it('源buffer迟到解析与已释放页面的ready失败不能覆盖当前演示', async () => {
    const previous = deferred<PptxFiles>(), oldFiles = files(), currentFiles = files(), current = presentation('current')
    mocks.parse.mockImplementationOnce(() => previous.promise).mockResolvedValue(currentFiles)
    mocks.build.mockImplementation(source => source === currentFiles ? current : presentation('old'))
    const old = buffer(), next = buffer(), view = render(<PptxPreview buffer={old} name="old.pptx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    await waitFor(() => expect(mocks.parse).toHaveBeenCalledTimes(1))
    view.rerender(<PptxPreview buffer={next} name="current.pptx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    await ready(view.container)
    await act(async () => { previous.resolve(oldFiles); await previous.promise })
    expect(mocks.render).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-rendered-slide]')).toHaveAttribute('data-rendered-slide', 'current/slide1.xml')
    const late = deferred<void>()
    mocks.render.mockImplementationOnce((_presentation, slide) => slideHandle(slide, late.promise))
    fireEvent.click(screen.getByLabelText('下一张幻灯片'))
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByLabelText('下一张幻灯片'))
    await ready(view.container)
    await act(async () => { late.reject(new Error('旧页失败')); await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-pptx-slide]')).toHaveAttribute('data-pptx-page', '3')
  })
  it('页内跳转和外链分别路由；关闭页后旧回调失效，最新URL回调不触发重绘', async () => {
    const data = buffer(), open = vi.fn(), nextOpen = vi.fn(), view = render(<PptxPreview buffer={data} name="deck.pptx" tabId={tabId} active onOpenUrl={open} />)
    await ready(view.container)
    const options = mocks.render.mock.calls[0][2]!
    act(() => { options.onNavigate!({ url: 'javascript:alert(1)' }); options.onNavigate!({ url: 'https://user:secret@example.test/' }) })
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('演示外链'))
    expect(open).toHaveBeenCalledWith('https://example.test/deck')
    view.rerender(<PptxPreview buffer={data} name="deck.pptx" tabId={tabId} active onOpenUrl={nextOpen} />)
    expect(mocks.render).toHaveBeenCalledTimes(1)
    act(() => options.onNavigate!({ url: 'https://example.test/next' }))
    expect(nextOpen).toHaveBeenCalledWith('https://example.test/next')
    act(() => options.onNavigate!({ slideIndex: 2 }))
    await ready(view.container)
    expect(useFilePreviewStore.getState().views[tabId].page).toBe(3)
    act(() => options.onNavigate!({ slideIndex: 0 }))
    expect(useFilePreviewStore.getState().views[tabId].page).toBe(3)
  })
  it('页码输入与键盘不越界，文档内部滚动复位，图片失败保留页面并提示', async () => {
    const view = render(<PptxPreview buffer={buffer()} name="deck.pptx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    await ready(view.container)
    fireEvent.change(screen.getByLabelText('幻灯片页码'), { target: { value: '999' } })
    fireEvent.blur(screen.getByLabelText('幻灯片页码'))
    await ready(view.container)
    expect(screen.getByLabelText('幻灯片页码')).toHaveValue('3')
    fireEvent.keyDown(screen.getByLabelText('幻灯片页码'), { key: 'ArrowLeft' })
    expect(screen.getByLabelText('幻灯片页码')).toHaveValue('3')
    fireEvent.keyDown(screen.getByLabelText('PPTX 幻灯片：deck.pptx'), { key: 'ArrowLeft' })
    await ready(view.container)
    expect(screen.getByLabelText('幻灯片页码')).toHaveValue('2')
    const inside = handles.at(-1)!.element
    inside.scrollTop = 50; inside.scrollLeft = 20; fireEvent.scroll(inside)
    expect(inside.scrollTop).toBe(0); expect(inside.scrollLeft).toBe(0)
    fireEvent.error(inside.querySelector('img')!)
    expect(await screen.findByRole('status')).toHaveTextContent('部分图片或媒体未能加载')
    expect(inside.isConnected).toBe(true)
  })
  it('缩放严格使用25–300%并在文件内保存滚动，非法解析尺寸明确失败', async () => {
    const view = render(<PptxPreview buffer={buffer()} name="deck.pptx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    await ready(view.container)
    for (let index = 0; index < 20; index++) fireEvent.click(screen.getByLabelText('放大幻灯片'))
    expect(screen.getByLabelText('放大幻灯片')).toBeDisabled()
    expect(screen.getByLabelText('适配幻灯片')).toHaveTextContent('300%')
    for (let index = 0; index < 20; index++) fireEvent.click(screen.getByLabelText('缩小幻灯片'))
    expect(screen.getByLabelText('缩小幻灯片')).toBeDisabled()
    expect(screen.getByLabelText('适配幻灯片')).toHaveTextContent('25%')
    const viewport = view.container.querySelector<HTMLElement>('[data-pptx-viewport]')!
    viewport.scrollTop = 55; viewport.scrollLeft = 9; fireEvent.scroll(viewport)
    expect(useFilePreviewStore.getState().views[tabId]).toMatchObject({ scrollTop: 55, scrollLeft: 9 })
    view.unmount()
    mocks.build.mockReturnValue({ ...presentation(), width: 0 })
    await expect(openPptxPresentation(buffer())).rejects.toThrow('尺寸无效')
  })
  it('损坏文档显示解析原因，不回退成文本成功页；新buffer可恢复视觉页', async () => {
    mocks.parse.mockRejectedValueOnce(new Error('PPTX ZIP 中央目录损坏'))
    const view = render(<PptxPreview buffer={buffer()} name="broken.pptx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('PPTX ZIP 中央目录损坏')
    expect(mocks.render).not.toHaveBeenCalled()
    view.rerender(<PptxPreview buffer={buffer()} name="valid.pptx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    await ready(view.container)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-rendered-slide]')).toBeInTheDocument()
  })
})
