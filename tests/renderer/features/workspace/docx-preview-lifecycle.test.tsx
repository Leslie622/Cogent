/** 第三方排版不可取消：可控Promise验证迟到结果、隐藏激活与每标签阅读状态。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Options } from 'docx-preview'
import DocxPreview from '@/features/home/files/visual/DocxPreview'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFilePreviewStore } from '@/stores/file-preview'

const renderer = vi.hoisted(() => ({ renderAsync: vi.fn() }))
vi.mock('docx-preview', () => ({ renderAsync: renderer.renderAsync }))
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = []
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
const buffer = () => new ArrayBuffer(5)
function prepare(name = 'document.docx') {
  return useWorkspaceStore.getState().openFile({ scope: { sessionId: 'docx-lifecycle', refs: [] }, target: name }, 'docx-lifecycle')
}
function readyText(text: string) {
  return (_buffer: ArrayBuffer, body: HTMLElement, _styles: HTMLElement, options: Options) => {
    body.innerHTML = `<div class="${options.className}-wrapper"><section class="${options.className}">${text}</section></div>`
    return Promise.resolve()
  }
}
beforeEach(() => {
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  renderer.renderAsync.mockReset()
  observers.length = 0
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    constructor(callback: () => void) { observers.push({ callback, disconnect: this.disconnect }) }
    observe() {}
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(424)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1200)
})
afterEach(() => {
  cleanup(); useWorkspaceStore.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalFonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', originalFonts)
})

describe('DOCX 排版代次与阅读状态', () => {
  it('嵌入字体就绪后重新按实际纸张宽度适配，不固定使用占位字体的尺寸', async () => {
    const fonts = deferred()
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: fonts.promise } })
    renderer.renderAsync.mockImplementation(readyText('等待字体'))
    const view = render(<DocxPreview buffer={buffer()} name="fonts.docx" tabId={prepare()} active onOpenUrl={vi.fn()} />)
    await screen.findByText('等待字体')
    await waitFor(() => expect(view.container.querySelector('[data-docx-content]')).toHaveStyle({ transform: 'scale(0.5)' }))
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
    await act(async () => { fonts.resolve(); await fonts.promise })
    await waitFor(() => expect(view.container.querySelector('[data-docx-content]')).toHaveStyle({ transform: 'scale(0.4)' }))
  })

  it('未访问的后台文档不解析；激活一次后显隐不重新排版，窄栏恢复时重测适配', async () => {
    const bytes = buffer(), id = prepare()
    renderer.renderAsync.mockImplementation(readyText('首次排版'))
    const props = { buffer: bytes, name: 'document.docx', tabId: id, onOpenUrl: vi.fn() }
    const view = render(<DocxPreview {...props} active={false} />)
    expect(renderer.renderAsync).not.toHaveBeenCalled()
    view.rerender(<DocxPreview {...props} active />)
    await screen.findByText('首次排版')
    await waitFor(() => expect(view.container.querySelector('[data-docx-content]')).toHaveStyle({ transform: 'scale(0.5)' }))
    const original = screen.getByText('首次排版')
    view.rerender(<DocxPreview {...props} active={false} />)
    expect(observers[0].disconnect).toHaveBeenCalled()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(824)
    view.rerender(<DocxPreview {...props} active />)
    await waitFor(() => expect(view.container.querySelector('[data-docx-content]')).toHaveStyle({ transform: 'scale(1)' }))
    expect(screen.getByText('首次排版')).toBe(original)
    expect(renderer.renderAsync).toHaveBeenCalledTimes(1)
  })

  it('新buffer先完成后旧解析不能写进新文档，旧解析失败也不覆盖当前成功', async () => {
    const first = deferred(), second = deferred()
    const bodies: HTMLElement[] = []
    renderer.renderAsync.mockImplementation((_bytes: ArrayBuffer, body: HTMLElement) => {
      bodies.push(body)
      return bodies.length === 1 ? first.promise : second.promise
    })
    const id = prepare(), firstBytes = buffer(), secondBytes = buffer(), props = { name: 'document.docx', tabId: id, active: true, onOpenUrl: vi.fn() }
    const view = render(<DocxPreview {...props} buffer={firstBytes} />)
    await waitFor(() => expect(bodies).toHaveLength(1))
    view.rerender(<DocxPreview {...props} buffer={secondBytes} />)
    await waitFor(() => expect(bodies).toHaveLength(2))
    bodies[1].textContent = '新文档'
    await act(async () => { second.resolve(); await second.promise })
    expect(screen.getByText('新文档')).toBeInTheDocument()
    await act(async () => { first.reject(new Error('旧文档解析失败')); await first.promise.catch(() => {}) })
    expect(screen.getByText('新文档')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(bodies[0].isConnected).toBe(false)
  })

  it('卸载后迟到成功只能清理旧离屏根，不重新挂载文档', async () => {
    const pending = deferred()
    let body!: HTMLElement
    renderer.renderAsync.mockImplementation((_bytes: ArrayBuffer, target: HTMLElement) => { body = target; return pending.promise })
    const view = render(<DocxPreview buffer={buffer()} name="closed.docx" tabId={prepare()} active onOpenUrl={vi.fn()} />)
    await waitFor(() => expect(renderer.renderAsync).toHaveBeenCalledTimes(1))
    view.unmount()
    body.textContent = '迟到文档'
    await act(async () => { pending.resolve(); await pending.promise })
    expect(screen.queryByText('迟到文档')).toBeNull()
    expect(body.isConnected).toBe(false)
    expect(body.textContent).toBe('')
  })

  it('按标签保存缩放与滚动，隐藏滚动不覆盖，重挂与退出flush保持阅读位置', async () => {
    renderer.renderAsync.mockImplementation(readyText('阅读位置'))
    const id = prepare(), other = prepare('other.docx'), bytes = buffer(), props = { buffer: bytes, name: 'document.docx', tabId: id, onOpenUrl: vi.fn() }
    const view = render(<DocxPreview {...props} active />)
    await screen.findByText('阅读位置')
    const viewport = view.container.querySelector<HTMLElement>('[data-docx-scaled-frame]')!.parentElement!
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(useFilePreviewStore.getState().views[id].zoom).toBe(0.75)
    viewport.scrollTop = 315; fireEvent.scroll(viewport)
    expect(useFilePreviewStore.getState().views[id].scrollTop).toBe(315)
    view.rerender(<DocxPreview {...props} active={false} />)
    viewport.scrollTop = 0; fireEvent.scroll(viewport)
    expect(useFilePreviewStore.getState().views[id].scrollTop).toBe(315)
    view.rerender(<DocxPreview {...props} active />)
    expect(viewport.scrollTop).toBe(315)
    viewport.scrollTop = 330
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id].scrollTop).toBe(330)
    expect(useFilePreviewStore.getState().views[other]).toBeUndefined()
    view.unmount()
    const next = render(<DocxPreview {...props} active />)
    await screen.findByText('阅读位置')
    await waitFor(() => expect(next.container.querySelector('[data-docx-content]')).toHaveStyle({ transform: 'scale(0.75)' }))
    expect(next.container.querySelector('[data-docx-scaled-frame]')!.parentElement!.scrollTop).toBe(330)
  })
})
