/** 查看器状态归真实工作区标签；覆盖媒体隐藏、退出保存和 PDF 取消绘制。 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileKind } from '@shared/files'
import { FilePanel } from '@/features/home/files/FilePanel'
import { useFilePreviewStore, type Preview } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'
import { acquireFile } from '@/features/workspace/file-client'
import type { FileViewLease, FileViewSource } from '@shared/file-views'

const pause = vi.fn()

function seed(kind: FileKind, name: string) {
  const scope = { sessionId: 'view-session', refs: [] }
  const tabId = useWorkspaceStore.getState().openFile({ scope, target: `C:/项目/${name}` }, 'view-session')
  const preview: Preview = {
    tabId, leaseId: `lease-${tabId}`, scope, rawTarget: `C:/项目/${name}`, operationId: `operation-${tabId}`,
    generation: 1, descriptor: { fileId: tabId, serviceId: 'service', path: `C:/项目/${name}`, name, kind, mime: kind === 'image' ? 'image/png' : 'video/mp4', size: 20, version: 'v1', source: 'saved' },
    loading: false, error: null, text: null, encoding: null, url: `blob:${tabId}`, document: null, bytes: 20, touchedAt: 0, evicted: false
  }
  useFilePreviewStore.setState((state) => ({ byTab: { ...state.byTab, [tabId]: preview }, current: preview }))
  return tabId
}

beforeEach(() => {
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
  URL.revokeObjectURL = vi.fn()
  useFilePreviewStore.getState().resetAll()
  useWorkspaceStore.getState().reset()
  useWorkspaceStore.getState().setScope('view-session')
  pause.mockReset()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)

})
afterEach(() => {
  cleanup()
  useFilePreviewStore.getState().resetAll()
  useWorkspaceStore.getState().reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('每标签查看状态', () => {
  it('相对 HTML 已打开后关闭父 Markdown，再网页预览使用自身稳定路径', async () => {
    const parent = seed('markdown', 'readme.md'), child = seed('text', 'child.html')
    const parentLease = useFilePreviewStore.getState().byTab[parent].leaseId!
    const childPreview = useFilePreviewStore.getState().byTab[child]
    useFilePreviewStore.setState(state => ({ byTab: { ...state.byTab, [child]: {
      ...childPreview,
      scope: { ...childPreview.scope, relativeTo: parentLease, parentSource: { scope: { sessionId: 'view-session', refs: [] }, target: 'C:/项目/readme.md' } },
      rawTarget: './child.html', url: null
    } } }))
    useWorkspaceStore.getState().remove(parent)
    expect(window.cogent.fileViewsRequest).toHaveBeenCalledWith('fileViews.release', { leaseId: parentLease })
    const acquired: FileViewLease = { leaseId: 'html-web-preview', canonicalKey: 'child-html', ownerId: 'view-session', descriptor: childPreview.descriptor! }
    const request = vi.fn((method: string, params: { source?: FileViewSource }) => {
      if (method === 'fileViews.acquire') {
        if (params.source?.kind !== 'session' || params.source.relativeTo !== undefined || params.source.rawTarget !== 'C:/项目/child.html') return Promise.reject(new Error('父租约已释放'))
        return Promise.resolve(acquired)
      }
      return Promise.resolve({ ok: true })
    })
    window.cogent = { fileViewsRequest: request } as unknown as typeof window.cogent
    render(<FilePanel tabId={child} active />)
    fireEvent.click(screen.getByRole('button', { name: '网页预览' }))
    const browser = useWorkspaceStore.getState().scopes['view-session'].tabs.find(tab => tab.kind === 'browser')!
    expect(browser.kind).toBe('browser')
    const source = browser.previewSource!
    expect(source).toEqual({ scope: { sessionId: 'view-session', refs: [], workspaceScopeId: 'view-session' }, target: 'C:/项目/child.html', outputTarget: undefined })
    await expect(acquireFile(source.scope, source.target, 'html-after-parent-close', source.outputTarget)).resolves.toEqual(acquired)
  })

  it('来源归文件信息，标签隐藏关闭自己的菜单和信息portal', async () => {
    const id = seed('image', '本地.png')
    useFilePreviewStore.setState((state) => ({ byTab: { ...state.byTab, [id]: {
      ...state.byTab[id], scope: { contextId: 'local-context', refs: [] },
      descriptor: { ...state.byTab[id].descriptor!, source: 'current-workspace' }
    } } }))
    const view = render(<FilePanel tabId={id} active />)
    expect(screen.queryByText('本地文件 · 来自已授权目录')).toBeNull()
    expect(screen.queryByText(/此消息未保存历史来源/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '文件操作' }))
    await screen.findByRole('menu')
    fireEvent.click(screen.getByRole('menuitem', { name: '文件信息' }))
    await screen.findByRole('dialog', { name: '文件信息' })
    expect(screen.getByText('本地文件 · 来自已授权目录')).toBeInTheDocument()
    view.rerender(<FilePanel tabId={id} active={false} />)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('图片缩放和滚动只写本标签，重挂后恢复', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
    const a = seed('image', '甲.png'), b = seed('image', '乙.png')
    const view = render(<><FilePanel tabId={a} active /><FilePanel tabId={b} active={false} /></>)
    const panel = view.container.querySelector<HTMLElement>(`[data-file-tab-id="${a}"]`)!
    const image = within(panel).getByRole('img')
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 1024 }, naturalHeight: { configurable: true, value: 1024 } })
    fireEvent.load(image)
    fireEvent.click(within(panel).getByRole('button', { name: '图片原始尺寸' }))
    fireEvent.click(within(panel).getByRole('button', { name: '放大图片' }))
    const scroller = panel.querySelector<HTMLElement>('[data-image-preview-viewport]')!
    scroller.scrollTop = 123
    fireEvent.scroll(scroller)
    expect(useFilePreviewStore.getState().views[a]).toMatchObject({ zoom: 1.25, scrollTop: 123 })
    expect(useFilePreviewStore.getState().views[b]).toBeUndefined()
    view.unmount()
    render(<FilePanel tabId={a} active />)
    const restored = screen.getByRole('img')
    Object.defineProperties(restored, { naturalWidth: { configurable: true, value: 1024 }, naturalHeight: { configurable: true, value: 1024 } })
    fireEvent.load(restored)
    expect(restored).toHaveStyle({ width: '1280px' })
    expect(document.querySelector<HTMLElement>('[data-image-preview-viewport]')!.scrollTop).toBe(123)
  })

  it('媒体隐藏即暂停，元数据与正常退出分别恢复/保存播放时间', () => {
    const id = seed('video', '演示.mp4')
    useFilePreviewStore.getState().setView(id, { mediaTime: 12 })
    const view = render(<FilePanel tabId={id} active />)
    const media = screen.getByLabelText<HTMLVideoElement>('演示.mp4')
    Object.defineProperty(media, 'duration', { configurable: true, value: 120 })
    fireEvent.loadedMetadata(media)
    expect(media.currentTime).toBe(12)
    media.currentTime = 32
    view.rerender(<FilePanel tabId={id} active={false} />)
    expect(pause).toHaveBeenCalled()
    expect(useFilePreviewStore.getState().views[id].mediaTime).toBe(32)
    media.currentTime = 33
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id].mediaTime).toBe(33)
  })

})
