/** 真 Headless Tree/基础控件接线；虚拟几何只固定视口，真实滚动与焦点由 Electron 验。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileNavigator, releaseFileNavigatorScope } from '@/features/workspace/FileNavigator'
import type { FileViewContext, FileViewDirectory, FileViewEntry } from '@shared/file-views'

const scopes: string[] = []
const root = { id: 'root', path: 'C:/项目', name: '项目', kind: 'directory' as const }
const entry: FileViewEntry = { id: 'readme', rootId: 'root', path: 'C:/项目/说明.md', relativePath: '说明.md', name: '说明.md', kind: 'file', symlink: false }
const context: FileViewContext = { contextId: 'context', generation: 1, roots: [root], selectedPaths: [], grantIds: [], canceled: false }
const page: FileViewDirectory = { entries: [entry], generation: 1, complete: true, truncated: false }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(280)
})
afterEach(async () => {
  await Promise.all(scopes.splice(0).map(releaseFileNavigatorScope))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('文件导航视图', () => {
  it('树保留ARIA语义，点击文件交回真实context与完整路径', async () => {
    const scopeId = 'render-file-tree'
    scopes.push(scopeId)
    const request = vi.fn((method: string) => Promise.resolve(method === 'fileViews.openContext' ? context : method === 'fileViews.listDirectory' ? page : { ok: true }))
    window.cogent = { fileViewsRequest: request, onEngineEvent: () => () => undefined } as unknown as typeof window.cogent
    const onOpen = vi.fn()
    const view = render(<FileNavigator scopeId={scopeId} projectId="project" onOpen={onOpen} />)
    const file = await screen.findByRole('treeitem', { name: '说明.md' })
    expect(screen.getByRole('tree', { name: '项目文件' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: '项目' })).toHaveAttribute('aria-expanded', 'true')
    const search = screen.getByRole('textbox', { name: '搜索项目文件' })
    const group = search.closest('[data-slot="input-group"]')!
    expect(group.querySelector('[data-align="inline-start"] svg')).not.toBeNull()
    expect(file).not.toHaveAttribute('title')
    expect(view.container.querySelector('[data-file-navigator] [title]')).toBeNull()
    fireEvent.click(file)
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('context', 'C:/项目/说明.md')
    expect(file).toHaveAttribute('tabindex', '0')
    fireEvent.click(screen.getByRole('treeitem', { name: '项目' }))
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: '说明.md' })).toBeNull())
    fireEvent.click(screen.getByRole('treeitem', { name: '项目' }))
    expect(await screen.findByRole('treeitem', { name: '说明.md' })).toBeInTheDocument()
  })

  it('普通会话保留PDF授权但不列为项目根，新会话为空且树头没有打开入口', async () => {
    const original = 'restore-local-pdf', fresh = 'fresh-local-files', grantId = 'selected-pdf'
    scopes.push(original, fresh)
    const pdf = { id: grantId, grantId, path: 'C:/手动选择/月报.pdf', name: '月报.pdf', kind: 'file' as const }
    const request = vi.fn((method: string, params: { scopeId?: string; grantIds?: string[]; pick?: string }) => Promise.resolve(method === 'fileViews.openContext'
      ? { ...context, contextId: 'context-' + params.scopeId, roots: params.grantIds!.includes(grantId) ? [pdf] : [], grantIds: params.grantIds, selectedPaths: params.pick === 'file' ? [pdf.path] : [] }
      : { ok: true }))
    window.cogent = { fileViewsRequest: request, onEngineEvent: () => () => undefined } as unknown as typeof window.cogent
    const onOpen = vi.fn(), contextChanged = vi.fn()
    const view = render(<FileNavigator key={original} scopeId={original} sessionId={original} grantIds={[grantId]} onOpen={onOpen} onContextChange={contextChanged} />)
    await screen.findByText('当前目录为空')
    expect(contextChanged).toHaveBeenCalledWith({ contextId: 'context-' + original, grantIds: [grantId] })
    expect(screen.queryByRole('treeitem')).toBeNull()
    expect(screen.getByRole('textbox', { name: '搜索项目文件' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '添加目录' })).toBeNull()
    view.rerender(<FileNavigator key={fresh} scopeId={fresh} sessionId={fresh} grantIds={[]} onOpen={onOpen} />)
    await screen.findByText('当前目录为空')
    expect(screen.queryByRole('treeitem', { name: '月报.pdf' })).toBeNull()
    expect(request).toHaveBeenCalledWith('fileViews.openContext', { scopeId: fresh, sessionId: fresh, grantIds: [] })
    view.rerender(<FileNavigator key={original} scopeId={original} sessionId={original} grantIds={[grantId]} onOpen={onOpen} />)
    await screen.findByText('当前目录为空')
    expect(screen.queryByRole('button', { name: '打开文件' })).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext')).toHaveLength(2)
    expect(request.mock.calls.some(([method]) => method === 'fileViews.listDirectory' || method === 'fileViews.search')).toBe(false)
  })

  it('融合搜索框的清除按钮沿用owner查询状态', async () => {
    const scopeId = 'integrated-file-search'
    scopes.push(scopeId)
    window.cogent = { fileViewsRequest: vi.fn((method: string) => Promise.resolve(method === 'fileViews.openContext' ? context : method === 'fileViews.listDirectory' ? page : { ok: true })), onEngineEvent: () => () => undefined } as unknown as typeof window.cogent
    render(<FileNavigator scopeId={scopeId} projectId="project" onOpen={vi.fn()} />)
    await screen.findByRole('tree', { name: '项目文件' })
    const input = screen.getByRole('textbox', { name: '搜索项目文件' })
    fireEvent.change(input, { target: { value: '说明' } })
    const clear = screen.getByRole('button', { name: '清除文件搜索' })
    expect(clear.closest('[data-slot="input-group"]')).toBe(input.closest('[data-slot="input-group"]'))
    fireEvent.click(clear)
    expect(input).toHaveValue('')
    expect(screen.getByRole('treeitem', { name: '说明.md' })).toBeInTheDocument()
  })

  it('空草稿只显示简短空态，不调用聊天创建或提供树头打开按钮', async () => {
    const scopeId = 'render-empty-draft'
    scopes.push(scopeId)
    const request = vi.fn((method: string, params: { pick?: string }) => Promise.resolve(method === 'fileViews.openContext'
      ? params.pick === 'file' ? { ...context, selectedPaths: [entry.path], grantIds: ['selected-file'] } : { ...context, roots: [] }
      : method === 'fileViews.listDirectory' ? page : { ok: true }))
    const engineRequest = vi.fn()
    window.cogent = { fileViewsRequest: request, engineRequest, onEngineEvent: () => () => undefined } as unknown as typeof window.cogent
    const onOpen = vi.fn()
    render(<FileNavigator scopeId={scopeId} onOpen={onOpen} />)
    await screen.findByText('当前目录为空')
    expect(screen.queryByText(/未绑定项目|打开文件可直接预览/)).toBeNull()
    expect(screen.queryByRole('button', { name: '打开文件' })).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
    expect(engineRequest).not.toHaveBeenCalled()
  })
})
