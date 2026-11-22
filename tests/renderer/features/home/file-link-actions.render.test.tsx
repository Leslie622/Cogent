/** 真 shadcn Tooltip/ContextMenu：完整路径、复制、动作、失败弹窗与来源切换。 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDescriptor } from '@shared/files'
import { FileLink, FileLinkContext } from '@/features/home/files/FileLink'
import { useFilePreviewStore } from '@/stores/file-preview'

const scope = { sessionId: 's1', turnId: 't1', refs: [] }
const descriptor = (overrides: Partial<FileDescriptor> = {}): FileDescriptor => ({
  fileId: 'file-1', serviceId: 'service', path: 'C:/项目/完整路径/说明.md', name: '说明.md', kind: 'markdown',
  mime: 'text/markdown', size: 10, version: 'v1', source: 'saved', location: { line: 2, column: 3 }, ...overrides
})
const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const fileAction = vi.fn<(params: unknown) => Promise<unknown>>()
const lease = (file = descriptor()) => ({ leaseId: file.fileId, descriptor: file, canonicalKey: file.path, ownerId: 'host' })
const link = () => screen.getByRole('link', { name: '说明.md' })
const content = <FileLink target="./说明.md:2:3">说明.md</FileLink>
function mount() { return render(<FileLinkContext.Provider value={scope}>{content}</FileLinkContext.Provider>) }

beforeEach(() => {
  engineRequest.mockReset().mockImplementation((method: string) => Promise.resolve(method === 'fileViews.acquire' ? lease() : { ok: true }))
  fileAction.mockReset().mockResolvedValue(undefined)
  window.cogent = { fileViewsRequest: (method: string, params: unknown) => method === 'fileViews.action' ? fileAction(params) : engineRequest(method, params) } as unknown as typeof window.cogent
})
afterEach(() => vi.restoreAllMocks())

describe('文件链接交互', () => {
  it('不交互不查磁盘，hover 用 Tooltip 展示完整路径并释放临时登记', async () => {
    const user = userEvent.setup()
    mount()
    expect(engineRequest).not.toHaveBeenCalled()
    expect(link()).not.toHaveAttribute('title')
    await user.hover(link())
    const tooltip = await screen.findByRole('tooltip')
    await waitFor(() => expect(tooltip).toHaveTextContent('C:/项目/完整路径/说明.md'))
    expect(engineRequest).toHaveBeenCalledWith('fileViews.acquire', { source: { kind: 'session', sessionId: 's1', turnId: 't1', rawTarget: './说明.md:2:3', relativeTo: undefined }, operationId: expect.any(String) as string })
    await waitFor(() => expect(engineRequest).toHaveBeenCalledWith('fileViews.release', { leaseId: 'file-1' }))
  })
  it('Tooltip 里的复制按钮可点击，复制实际绝对路径而不打开预览', async () => {
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const open = vi.spyOn(useFilePreviewStore.getState(), 'open').mockResolvedValue(undefined)
    mount()
    await user.hover(link())
    const copy = await screen.findByRole('button', { name: '复制完整路径' })
    await waitFor(() => expect(copy).toBeEnabled())
    // jsdom 不提供浮层几何，跨浮层的指针命中由真实 Electron 验证。
    fireEvent.click(copy)
    await waitFor(() => expect(write).toHaveBeenCalledWith('C:/项目/完整路径/说明.md'))
    expect(open).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: '已复制路径' })).toBeInTheDocument()
  })
  it('右键菜单可打开预览和复制完整路径，不误触链接点击', async () => {
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const open = vi.spyOn(useFilePreviewStore.getState(), 'open').mockResolvedValue(undefined)
    mount()
    fireEvent.contextMenu(link())
    await user.click(await screen.findByRole('menuitem', { name: '复制完整路径' }))
    expect(write).toHaveBeenCalledWith('C:/项目/完整路径/说明.md')
    expect(open).not.toHaveBeenCalled()
    fireEvent.contextMenu(link())
    await user.click(await screen.findByRole('menuitem', { name: '打开预览' }))
    expect(open).toHaveBeenCalledExactlyOnceWith(scope, './说明.md:2:3')
  })
  it.each([
    ['系统打开', 'open'], ['在文件管理器中定位', 'reveal'], ['编辑当前原文件', 'editor'], ['另存为…', 'save']
  ])('右键的%s通过已有文件动作入口并传递行列', async (label, action) => {
    const user = userEvent.setup()
    mount()
    fireEvent.contextMenu(link())
    await user.click(await screen.findByRole('menuitem', { name: label }))
    expect(fileAction).toHaveBeenCalledWith({ leaseId: 'file-1', action, location: { line: 2, column: 3 } })
    expect(engineRequest).toHaveBeenCalledWith('fileViews.release', { leaseId: 'file-1' })
  })
  it('原生动作失败使用独立弹窗，关闭后仍可重试', async () => {
    const user = userEvent.setup()
    fileAction.mockRejectedValueOnce(new Error('编辑器未配置'))
    mount()
    fireEvent.contextMenu(link())
    await user.click(await screen.findByRole('menuitem', { name: '编辑当前原文件' }))
    const dialog = await screen.findByRole('alertdialog', { name: '文件操作失败' })
    expect(dialog).toHaveTextContent('编辑器未配置')
    expect(document.querySelector('[data-file-link]')).not.toHaveTextContent('编辑器未配置')
    await user.click(within(dialog).getByRole('button', { name: '知道了' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    fireEvent.contextMenu(link())
    await user.click(await screen.findByRole('menuitem', { name: '编辑当前原文件' }))
    expect(fileAction).toHaveBeenCalledTimes(2)
  })
  it('解析失败时 Tooltip 给出真实原因，不把相对路径冒充完整路径复制', async () => {
    const user = userEvent.setup()
    engineRequest.mockRejectedValue(new Error('ENOENT: 原件缺失'))
    mount()
    await user.hover(link())
    expect(await screen.findByText('ENOENT: 原件缺失')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制完整路径' })).toBeDisabled()
  })
  it('复制被系统拒绝时弹窗反馈', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('剪贴板被拒绝'))
    mount()
    fireEvent.contextMenu(link())
    await user.click(await screen.findByRole('menuitem', { name: '复制完整路径' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('剪贴板被拒绝')
  })
  it('交付Markdown内链复制原路径，编辑动作显式解析当前原件并释放两个登记', async () => {
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const target = { sessionId: 's1', turnId: 't1', revision: 3, outputId: 'output-1', version: 'delivery' as const }
    const delivery = descriptor({ path: 'C:/受管副本/说明.md', delivery: { sourcePath: 'C:/项目/完整路径/说明.md', confirmedAt: 1, target } })
    engineRequest.mockImplementation((method: string) => Promise.resolve(method === 'fileViews.acquire' ? lease(delivery) : { ok: true }))
    mount()
    fireEvent.contextMenu(link())
    await user.click(await screen.findByRole('menuitem', { name: '复制完整路径' }))
    expect(write).toHaveBeenCalledWith('C:/项目/完整路径/说明.md')
    fireEvent.contextMenu(link())
    await user.click(await screen.findByRole('menuitem', { name: '编辑当前原文件' }))
    expect(fileAction).toHaveBeenCalledWith({ leaseId: 'file-1', action: 'editor', location: { line: 2, column: 3 } })
    expect(engineRequest).toHaveBeenCalledWith('fileViews.release', { leaseId: 'file-1' })
  })
  it('切换来源后旧 hover 结果不覆盖新路径，迟到句柄仍释放', async () => {
    const user = userEvent.setup()
    let resolveOld!: (value: FileDescriptor) => void
    engineRequest.mockImplementation((method: string, params: unknown) => {
      if (method !== 'fileViews.acquire') return Promise.resolve({ ok: true })
      return (params as { source: { sessionId: string } }).source.sessionId === 's1'
        ? new Promise((resolve) => { resolveOld = file => resolve(lease(file)) })
        : Promise.resolve(lease(descriptor({ fileId: 'file-2', path: 'C:/另一个项目/说明.md' })))
    })
    const view = mount()
    await user.hover(link())
    await screen.findByText('正在解析完整路径…')
    view.rerender(<FileLinkContext.Provider value={{ ...scope, sessionId: 's2' }}>{content}</FileLinkContext.Provider>)
    await user.hover(link())
    await screen.findByText('C:/另一个项目/说明.md')
    await act(async () => { resolveOld(descriptor()); await Promise.resolve() })
    expect(screen.getByRole('tooltip')).toHaveTextContent('C:/另一个项目/说明.md')
    expect(engineRequest).toHaveBeenCalledWith('fileViews.release', { leaseId: 'file-1' })
  })
})
