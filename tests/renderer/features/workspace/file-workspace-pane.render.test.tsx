/** 文件组合层只切显隐；目录owner和逐文件lease仍由原模块拥有。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileWorkspacePane, fileBreadcrumbs, type FileWorkspaceTab } from '@/features/workspace/FileWorkspacePane'
import { releaseFileNavigatorScope } from '@/features/workspace/file-navigator-owner'
import { useFilePreviewStore, type Preview } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'
import { useProjectStore } from '@/stores/project'
import type { FileViewContext, FileViewDirectory, FileViewSource } from '@shared/file-views'

const scopes = new Set<string>()
let rootName = '项目', rootPath = 'C:/项目', contextVersion = 1
const entry = { id: 'tree-image', rootId: 'root', path: 'C:/项目/预览.png', relativePath: '预览.png', name: '预览.png', kind: 'file' as const, symlink: false }
const request = vi.fn((method: string, params: { scopeId?: string; source?: FileViewSource; pick?: string }) => {
  if (method === 'fileViews.openContext') {
    const context: FileViewContext = { contextId: `context-${params.scopeId}-${contextVersion}`, generation: contextVersion, roots: [{ id: 'root', path: rootPath, name: rootName, kind: 'directory' }], selectedPaths: params.pick === 'file' ? [entry.path] : [], grantIds: [], canceled: false }
    return Promise.resolve(context)
  }
  if (method === 'fileViews.listDirectory') {
    const directory: FileViewDirectory = { entries: [entry], generation: contextVersion, complete: true, truncated: false }
    return Promise.resolve(directory)
  }
  if (method === 'fileViews.acquire') return Promise.resolve({ leaseId: 'tree-lease', canonicalKey: 'tree-key', ownerId: params.scopeId, descriptor: { fileId: entry.id, serviceId: 'service', path: entry.path, name: entry.name, kind: 'image', mime: 'image/png', size: 1, version: 'v1', source: 'current-workspace' } })
  if (method === 'fileViews.readChunk') return Promise.resolve({ base64: 'AA==', nextOffset: 1, done: true })
  return Promise.resolve({ ok: true })
})

function allTabs(): FileWorkspaceTab[] {
  return Object.values(useWorkspaceStore.getState().scopes).flatMap(scope => scope.tabs).filter((tab): tab is FileWorkspaceTab => tab.kind === 'files' || tab.kind === 'file')
}
function props(scopeId: string, activeTabId: string | null) {
  scopes.add(scopeId)
  return { tabs: allTabs(), scopeId, projectId: 'project-fixture', sessionId: scopeId.startsWith('draft:') ? undefined : scopeId, active: true, activeTabId }
}
function seed(scopeId: string, name: string, directory = 'C:/项目'): string {
  const scope = { contextId: 'source-' + scopeId, refs: [] }
  const path = directory + '/' + name
  const id = useWorkspaceStore.getState().openFile({ scope, target: path }, scopeId)
  const preview: Preview = { tabId: id, leaseId: 'lease-' + id, scope, rawTarget: path, operationId: 'operation-' + id, generation: 1, descriptor: { fileId: id, serviceId: 'service', path, name, kind: 'image', mime: 'image/png', size: 1, version: 'v1', source: 'current-workspace' }, loading: false, error: null, text: null, encoding: null, url: 'blob:' + id, document: null, bytes: 1, touchedAt: 0, evicted: false }
  useFilePreviewStore.setState(state => ({ byTab: { ...state.byTab, [id]: preview }, current: preview }))
  return id
}

beforeEach(() => {
  window.cogent = { fileViewsRequest: request, onEngineEvent: () => () => undefined } as unknown as typeof window.cogent
  URL.revokeObjectURL = vi.fn(); URL.createObjectURL = vi.fn(() => 'blob:tree-image')
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  useProjectStore.setState({ projects: [] })
  request.mockClear(); rootName = '项目'; rootPath = 'C:/项目'; contextVersion = 1
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(280)
})
afterEach(async () => {
  cleanup()
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  await Promise.all([...scopes].map(releaseFileNavigatorScope)); scopes.clear()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('文件工作面组合', () => {
  it('长路径首次打开、切换文件与重新激活时定位末尾文件名', () => {
    const scope = 'ordinary-long-path'
    useWorkspaceStore.getState().setScope(scope)
    const first = seed(scope, '第一个文件.png', 'C:/Users/41631/AppData/Local/Temp/很长的目录'), second = seed(scope, '第二个文件.png', 'D:/另外一个很长的目录')
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1400)
    const view = render(<FileWorkspacePane {...props(scope, first)} projectId={undefined} />)
    const firstPath = screen.getByRole('navigation', { name: '文件位置' })
    expect(firstPath.scrollLeft).toBe(1400)
    firstPath.scrollLeft = 0
    view.rerender(<FileWorkspacePane {...props(scope, first)} projectId={undefined} active={false} />)
    expect(firstPath.scrollLeft).toBe(0)
    view.rerender(<FileWorkspacePane {...props(scope, first)} projectId={undefined} />)
    expect(firstPath.scrollLeft).toBe(1400)
    view.rerender(<FileWorkspacePane {...props(scope, second)} projectId={undefined} />)
    expect(screen.getByRole('navigation', { name: '文件位置' }).scrollLeft).toBe(1400)
    expect(screen.getByRole('navigation', { name: '文件位置' })).toHaveTextContent('D:另外一个很长的目录第二个文件.png')
  })

  it('普通会话预览显示完整路径，选择和切换项目不重挂文件且外部路径不挂项目名', async () => {
    const scope = 'ordinary-preview'
    useWorkspaceStore.getState().setScope(scope)
    const id = seed(scope, '外部.png', 'D:/用户资料')
    useProjectStore.setState({ projects: [{ id: 'project-a', name: '工程甲', cwds: ['C:/项目'], createdAt: 0 }, { id: 'project-b', name: '工程乙', cwds: ['C:/项目'], createdAt: 0 }] })
    const view = render(<FileWorkspacePane {...props(scope, id)} projectId={undefined} />)
    await screen.findByText('当前目录为空')
    expect(screen.queryByRole('treeitem')).toBeNull()
    const breadcrumb = screen.getByRole('navigation', { name: '文件位置' })
    expect(breadcrumb).toHaveTextContent('D:用户资料外部.png')
    const image = view.container.querySelector(`[data-file-tab-id="${id}"] img`)
    view.rerender(<FileWorkspacePane {...props(scope, id)} projectId="project-a" />)
    await screen.findByRole('treeitem', { name: '项目' })
    expect(screen.getByRole('navigation', { name: '文件位置' })).toHaveTextContent('D:用户资料外部.png')
    expect(screen.getByRole('navigation', { name: '文件位置' })).not.toHaveTextContent('工程甲')
    view.rerender(<FileWorkspacePane {...props(scope, id)} projectId="project-b" />)
    await screen.findByText('工程乙')
    expect(view.container.querySelector(`[data-file-tab-id="${id}"] img`)).toBe(image)
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext')).toHaveLength(3)
    expect(request.mock.calls.some(([method]) => method === 'fileViews.release')).toBe(false)
  })

  it('文件位置和折叠/操作使用真实Tooltip，工具行不留原生title', async () => {
    const scope = 'draft:file-tooltip'
    useWorkspaceStore.getState().setScope(scope)
    const id = seed(scope, '甲.png'), user = userEvent.setup()
    const view = render(<FileWorkspacePane {...props(scope, id)} />)
    await screen.findByRole('tree', { name: '项目文件' })
    expect(view.container.querySelector('[data-file-toolbar] [title]')).toBeNull()
    const breadcrumb = screen.getByRole('navigation', { name: '文件位置' })
    expect(breadcrumb).not.toHaveAttribute('data-base-ui-tooltip-trigger')
    const filename = breadcrumb.querySelector<HTMLElement>('[aria-current=page]')!
    await user.hover(filename)
    expect((await screen.findByText('C:/项目/甲.png')).closest('[data-slot="tooltip-content"]')).not.toBeNull()
    await user.unhover(filename)
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"][data-open]')).toBeNull())
    await user.hover(screen.getByRole('button', { name: '收起文件树' }))
    expect((await screen.findByText('收起文件树')).closest('[data-slot="tooltip-content"]')).not.toBeNull()
    await user.unhover(screen.getByRole('button', { name: '收起文件树' }))
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"][data-open]')).toBeNull())
    await user.hover(screen.getByRole('button', { name: '文件操作' }))
    expect((await screen.findByText('文件操作')).closest('[data-slot="tooltip-content"]')).not.toBeNull()
  })

  it('无项目的打开文件从工具栏进入，选择后通过独立lease预览且保留空文件树', async () => {
    const scope = 'draft:toolbar-open'
    useWorkspaceStore.getState().setScope(scope)
    const files = useWorkspaceStore.getState().openFiles(scope)
    const view = render(<FileWorkspacePane {...props(scope, files)} projectId={undefined} />)
    await screen.findByText('当前目录为空')
    expect(view.container.querySelector('[data-file-navigator] button[aria-label="打开文件"]')).toBeNull()
    const group = screen.getByRole('group', { name: '文件打开操作' })
    expect(group.querySelectorAll('button')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('fileViews.openContext', expect.objectContaining({ scopeId: scope, pick: 'file' })))
    await waitFor(() => expect(Object.values(useFilePreviewStore.getState().byTab).some(file => file.leaseId === 'tree-lease' && !file.loading)).toBe(true))
    expect(useWorkspaceStore.getState().scopes[scope].tabs.map(tab => tab.id)).toEqual([files])
    expect(screen.queryByRole('treeitem')).toBeNull()
    expect(request.mock.calls.some(([method]) => method === 'fileViews.listDirectory')).toBe(false)
  })

  it('一棵树与单工具行复用文件内容，折叠、跨scope和草稿迁移均不释放lease', async () => {
    const scope = 'draft:stable', other = 'draft:other'
    useWorkspaceStore.getState().setScope(scope)
    const a = seed(scope, '甲.png'), b = seed(scope, '乙.png')
    const view = render(<FileWorkspacePane {...props(scope, a)} />)
    await screen.findByRole('tree', { name: '项目文件' })
    expect(view.container.querySelectorAll('[data-file-navigator]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-file-toolbar]')).toHaveLength(1)
    expect(screen.getByRole('navigation', { name: '文件位置' })).toHaveTextContent('项目甲.png')
    const image = view.container.querySelector(`[data-file-tab-id="${a}"] img`)
    const panel = view.container.querySelector(`[data-workspace-panel="${a}"]`)
    expect(image).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '收起文件树' }))
    expect(view.container.querySelector('[data-file-workspace-sidebar]')).toHaveAttribute('hidden')
    expect(view.container.querySelector(`[data-file-tab-id="${a}"] img`)).toBe(image)
    fireEvent.click(screen.getByRole('button', { name: '展开文件树' }))
    view.rerender(<FileWorkspacePane {...props(scope, b)} />)
    expect(panel).toHaveAttribute('hidden')
    expect(view.container.querySelector(`[data-file-tab-id="${a}"] img`)).toBe(image)
    expect(view.container.querySelectorAll('[data-file-navigator]')).toHaveLength(1)
    const c = seed(other, '丙.png')
    view.rerender(<FileWorkspacePane {...props(other, c)} />)
    await screen.findByRole('tree', { name: '项目文件' })
    view.rerender(<FileWorkspacePane {...props(scope, a)} />)
    expect(view.container.querySelector(`[data-file-tab-id="${a}"] img`)).toBe(image)
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext')).toHaveLength(2)
    act(() => { useWorkspaceStore.getState().bindDraft(scope, 'session-stable') })
    view.rerender(<FileWorkspacePane {...props('session-stable', a)} />)
    expect(view.container.querySelector(`[data-workspace-panel="${a}"]`)).toBe(panel)
    expect(view.container.querySelector(`[data-file-tab-id="${a}"] img`)).toBe(image)
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext')).toHaveLength(2)
    expect(request.mock.calls.some(([method]) => method === 'fileViews.release')).toBe(false)
  })

  it('树打开文件仍经原store取得独立lease，顶部打开动作使用该lease', async () => {
    const scope = 'draft:tree-open'
    useWorkspaceStore.getState().setScope(scope)
    const files = useWorkspaceStore.getState().openFiles(scope)
    const view = render(<FileWorkspacePane {...props(scope, files)} />)
    expect(screen.getByText('选择文件以预览')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('treeitem', { name: '预览.png' }))
    let id = ''
    await waitFor(() => {
      id = useWorkspaceStore.getState().scopes[scope].activeId!
      expect(useFilePreviewStore.getState().byTab[id]).toMatchObject({ leaseId: 'tree-lease', loading: false })
    })
    expect(id).toBe(files)
    view.rerender(<FileWorkspacePane {...props(scope, id)} />)
    expect(view.container.querySelectorAll('[data-file-navigator]')).toHaveLength(1)
    expect(view.container.querySelector('[data-file-delivery]')).toHaveAttribute('data-file-delivery', 'current')
    expect(screen.getByRole('navigation', { name: '文件位置' })).toHaveTextContent('项目预览.png')
    fireEvent.click(screen.getByRole('button', { name: '系统打开' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('fileViews.action', { leaseId: 'tree-lease', action: 'open', location: undefined }))
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.acquire')).toHaveLength(1)
    expect(request.mock.calls.some(([method]) => method === 'fileViews.release')).toBe(false)
  })

  it('全部关闭释放owner后，同scope重开读取新目录与面包屑', async () => {
    const scope = 'draft:reopen'
    useWorkspaceStore.getState().setScope(scope)
    const files = useWorkspaceStore.getState().openFiles(scope)
    const view = render(<FileWorkspacePane {...props(scope, files)} />)
    await screen.findByRole('tree', { name: '项目文件' })
    expect(screen.getByRole('navigation', { name: '文件位置' })).toHaveTextContent('项目')
    act(() => { useWorkspaceStore.getState().removeMany([files]) })
    await act(async () => { await releaseFileNavigatorScope(scope) })
    view.rerender(<FileWorkspacePane {...props(scope, null)} active={false} />)
    expect(view.container.querySelector('[data-file-navigator]')).toBeNull()
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext')).toHaveLength(1)
    rootName = '新目录'; rootPath = 'D:/新目录'; contextVersion = 2
    const reopened = useWorkspaceStore.getState().openFiles(scope)
    view.rerender(<FileWorkspacePane {...props(scope, reopened)} />)
    await screen.findByRole('treeitem', { name: '新目录' })
    expect(screen.getByRole('navigation', { name: '文件位置' })).toHaveTextContent('新目录')
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext')).toHaveLength(2)
    expect(request).toHaveBeenCalledWith('fileViews.closeContext', { contextId: 'context-draft:reopen-1' })
  })

  it('面包屑按最长合法根定位并正确处理Windows分隔符与前缀边界', () => {
    const roots = [{ id: 'root', path: 'C:/项目', name: '项目', kind: 'directory' as const }, { id: 'nested', path: 'C:/项目/src', name: '源码', kind: 'directory' as const }]
    expect(fileBreadcrumbs('工程', roots, 'c:\\项目\\src\\页面.tsx', '页面.tsx')).toEqual(['工程', '页面.tsx'])
    expect(fileBreadcrumbs(undefined, roots, 'C:/项目/图片/甲.png', '甲.png')).toEqual(['项目', '图片', '甲.png'])
    expect(fileBreadcrumbs('工程', roots, 'C:/项目之外/甲.png', '甲.png')).toEqual(['C:', '项目之外', '甲.png'])
    expect(fileBreadcrumbs(undefined, [], '/tmp/外部/甲.png', '甲.png')).toEqual(['/', 'tmp', '外部', '甲.png'])
    expect(fileBreadcrumbs(undefined, [], '\\\\server\\共享\\甲.png', '甲.png')).toEqual(['//server', '共享', '甲.png'])
  })

  it('文件树与预览区之间支持拖拽调节宽度、双击重置与收起', () => {
    const clientWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    try {
      const scope = 'draft:resize'
      useWorkspaceStore.getState().setScope(scope)
      const files = useWorkspaceStore.getState().openFiles(scope)
      const view = render(<FileWorkspacePane {...props(scope, files)} />)
      const sidebar = view.container.querySelector<HTMLElement>('[data-file-workspace-sidebar]')!
      expect(sidebar.style.width).toBe('224px')

      const handle = screen.getByRole('separator', { name: '调整文件树宽度' })
      fireEvent.keyDown(handle, { key: 'ArrowRight' })
      expect(sidebar.style.width).toBe('240px')
      fireEvent.doubleClick(handle)
      expect(sidebar.style.width).toBe('224px')

      fireEvent.click(screen.getByRole('button', { name: '收起文件树' }))
      expect(screen.queryByRole('separator', { name: '调整文件树宽度' })).not.toBeInTheDocument()
    } finally {
      clientWidthSpy.mockRestore()
    }
  })
})
