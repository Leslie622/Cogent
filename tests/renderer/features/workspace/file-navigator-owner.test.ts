/** 目录分页、读取竞态与搜索游标的行为回归，不替代真实虚拟布局验收。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileViewContext, FileViewDirectory, FileViewEntry, FileViewSearch } from '@shared/file-views'
import { FileNavigatorOwner, bindFileNavigatorScope, getFileNavigatorOwner, invalidateProjectNavigators, releaseFileNavigatorScope, type FileNavigatorRequest } from '@/features/workspace/file-navigator-owner'
import { useProjectStore } from '@/stores/project'

const root = { id: 'root', path: 'C:/项目', name: '项目', kind: 'directory' as const }
const context = (contextId = 'context-1'): FileViewContext => ({ contextId, generation: 1, roots: [root], selectedPaths: [], grantIds: [], canceled: false })
const entry = (id: string, kind: FileViewEntry['kind'] = 'file'): FileViewEntry => ({ id, rootId: root.id, path: `C:/项目/${id}`, name: id, relativePath: id, kind, symlink: false })
const directory = (entries: FileViewEntry[], nextCursor?: string): FileViewDirectory => ({ entries, generation: 1, complete: nextCursor === undefined, nextCursor, truncated: false })
const searchResult = (page: number, nextCursor?: string): FileViewSearch => ({ entries: [entry(`文件-${page}.md`)], generation: 1, complete: nextCursor === undefined, nextCursor, scanned: page * 200, paused: false, truncated: false, warnings: [] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
const owners: FileNavigatorOwner[] = []
function setup(dispatch?: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  const request = vi.fn((method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (dispatch !== undefined) return dispatch(method, params)
    if (method === 'fileViews.openContext') return Promise.resolve(context())
    if (method === 'fileViews.listDirectory') return Promise.resolve(directory([]))
    return Promise.resolve({ ok: true })
  })
  const owner = new FileNavigatorOwner({ scopeId: 'draft-1', projectId: 'project-1' }, request as unknown as FileNavigatorRequest)
  owners.push(owner)
  return { owner, request }
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()))
  vi.useRealTimers()
})

describe('文件导航数据所有者', () => {
  it('项目变更立即释放全部会话的导航，包括后台未再次打开的目录', async () => {
    let opened = 0
    const request = vi.fn((method: string) => Promise.resolve(method === 'fileViews.openContext' ? context(`background-${++opened}`) : method === 'fileViews.listDirectory' ? directory([]) : { ok: true }))
    window.cogent = { fileViewsRequest: request } as unknown as typeof window.cogent
    const first = getFileNavigatorOwner({ scopeId: 'background-1', projectId: 'background-p' })
    const second = getFileNavigatorOwner({ scopeId: 'background-2', projectId: 'background-p' })
    await Promise.all([first.initialize(), second.initialize()])
    await invalidateProjectNavigators('background-p')
    expect(request).toHaveBeenCalledWith('fileViews.closeContext', { contextId: 'background-1' })
    expect(request).toHaveBeenCalledWith('fileViews.closeContext', { contextId: 'background-2' })
    expect(getFileNavigatorOwner({ scopeId: 'background-1', projectId: 'background-p' })).not.toBe(first)
    await releaseFileNavigatorScope('background-1')
    await releaseFileNavigatorScope('background-2')
  })
  it('项目换根更换owner，旧打开回包只能归还上下文；仅改名保留新owner', async () => {
    const oldProjects = useProjectStore.getState().projects
    const pending = deferred<FileViewContext>()
    let count = 0
    const request = vi.fn((method: string) => {
      if (method === 'fileViews.openContext') return ++count === 1 ? pending.promise : Promise.resolve(context('root-B-context'))
      return Promise.resolve(method === 'fileViews.listDirectory' ? directory([]) : { ok: true })
    })
    window.cogent = { fileViewsRequest: request } as unknown as typeof window.cogent
    const project = { id: 'switch-project', name: 'A', cwds: ['C:/A'], createdAt: 1 }
    useProjectStore.setState({ projects: [project] })
    const source = { scopeId: 'switch-scope', projectId: project.id, sessionId: 'switch-scope' }
    try {
      const previous = getFileNavigatorOwner(source), loading = previous.initialize()
      useProjectStore.setState({ projects: [{ ...project, cwds: ['C:/B'] }] })
      const current = getFileNavigatorOwner(source)
      expect(current).not.toBe(previous)
      await current.initialize()
      pending.resolve(context('late-root-A-context')); await loading
      expect(previous.getSnapshot().context).toBeNull()
      expect(current.getSnapshot().context?.contextId).toBe('root-B-context')
      expect(request).toHaveBeenCalledWith('fileViews.closeContext', { contextId: 'late-root-A-context' })
      useProjectStore.setState({ projects: [{ ...project, name: '只改名', cwds: ['C:/B'] }] })
      expect(getFileNavigatorOwner(source)).toBe(current)
    } finally { await releaseFileNavigatorScope(source.scopeId); useProjectStore.setState({ projects: oldProjects }) }
  })
  it.each(['draft:no-project', 'ordinary-session'])('未绑定项目的%s保留文件/外部目录授权，但树与搜索为空', async scopeId => {
    const externalRoots = [
      { id: 'pdf', grantId: 'pdf-grant', path: 'D:/外部/月报.pdf', name: '月报.pdf', kind: 'file' as const },
      { id: 'external', grantId: 'directory-grant', path: 'D:/外部', name: '外部', kind: 'directory' as const }
    ]
    const request = vi.fn((method: string) => Promise.resolve(method === 'fileViews.openContext' ? { ...context(), roots: externalRoots, grantIds: ['pdf-grant', 'directory-grant'] } : { ok: true }))
    const owner = new FileNavigatorOwner({ scopeId, ...(scopeId.startsWith('draft:') ? {} : { sessionId: scopeId }), grantIds: ['pdf-grant', 'directory-grant'] }, request as unknown as FileNavigatorRequest)
    owners.push(owner)
    await owner.initialize()
    expect(owner.getSnapshot().context).toMatchObject({ roots: externalRoots, grantIds: ['pdf-grant', 'directory-grant'] })
    expect(owner.getSnapshot().roots).toEqual([])
    expect(owner.getSnapshot().nodes.size).toBe(0)
    owner.setQuery('月报'); await owner.search()
    expect(owner.getSnapshot().search).toMatchObject({ entries: [], complete: true })
    expect(request.mock.calls.some(([method]) => method === 'fileViews.search' || method === 'fileViews.listDirectory')).toBe(false)
  })

  it('项目树只加载项目根，选过的单文件或目录不加入树且授权继续回传', async () => {
    const external = { id: 'external', grantId: 'directory-grant', path: 'D:/外部', name: '外部', kind: 'directory' as const }
    const pdf = { id: 'pdf', grantId: 'pdf-grant', path: 'D:/外部/月报.pdf', name: '月报.pdf', kind: 'file' as const }
    const { owner, request } = setup((method) => Promise.resolve(method === 'fileViews.openContext' ? { ...context(), roots: [root, external, pdf], grantIds: ['directory-grant', 'pdf-grant'] } : method === 'fileViews.listDirectory' ? directory([]) : { ok: true }))
    await owner.initialize()
    expect(owner.getSnapshot().roots).toEqual(['root'])
    expect(owner.getSnapshot().context?.grantIds).toEqual(['directory-grant', 'pdf-grant'])
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.listDirectory')).toEqual([['fileViews.listDirectory', expect.objectContaining({ directoryId: 'root' })]])
    await owner.openContext('file')
    expect(request).toHaveBeenLastCalledWith('fileViews.listDirectory', expect.objectContaining({ directoryId: 'root' }))
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.openContext').at(-1)?.[1]).toMatchObject({ grantIds: ['directory-grant', 'pdf-grant'], pick: 'file' })
  })

  it('只读取展开目录，分页追加且合成行不会伪装成路径', async () => {
    const { owner, request } = setup((method, params) => {
      if (method === 'fileViews.openContext') return Promise.resolve(context())
      if (method === 'fileViews.listDirectory') return Promise.resolve(params.directoryId === 'root'
        ? params.cursor === undefined ? directory([entry('文档', 'directory')], 'page-2') : directory([entry('说明.md')])
        : directory([entry('文档/子文件.md')]))
      return Promise.resolve({ ok: true })
    })
    await owner.initialize()
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.listDirectory')).toHaveLength(1)
    expect(owner.getChildren('root')).toEqual(['文档', 'navigation-control:root'])
    expect(owner.getItem('navigation-control:root')).toMatchObject({ type: 'control', action: 'more' })
    owner.setFocusedItem('navigation-control:root')
    await owner.loadDirectory('root')
    expect(owner.getChildren('root')).toEqual(['文档', '说明.md'])
    expect(owner.getSnapshot().focusedItem).toBe('说明.md')
    owner.setExpandedItems(['root', '文档'])
    await vi.waitFor(() => expect(owner.getChildren('文档')).toEqual(['文档/子文件.md']))
  })

  it('刷新先取消旧请求，迟到旧列表不覆盖新列表', async () => {
    const old = deferred<FileViewDirectory>()
    let calls = 0
    const { owner, request } = setup((method) => {
      if (method === 'fileViews.openContext') return Promise.resolve(context())
      if (method === 'fileViews.listDirectory') return ++calls === 1 ? old.promise : Promise.resolve(directory([entry('新.md')]))
      return Promise.resolve({ ok: true })
    })
    const initial = owner.initialize()
    await vi.waitFor(() => expect(calls).toBe(1))
    await owner.loadDirectory('root', true)
    old.resolve(directory([entry('旧.md')]))
    await initial
    expect(owner.getChildren('root')).toEqual(['新.md'])
    expect(request).toHaveBeenCalledWith('fileViews.cancel', expect.objectContaining({ contextId: 'context-1' }))
  })

  it('权限失败保持重试节点，成功后才显示空目录', async () => {
    let fail = true
    const { owner } = setup((method) => {
      if (method === 'fileViews.openContext') return Promise.resolve(context())
      if (method === 'fileViews.listDirectory') return fail ? Promise.reject(new Error('拒绝访问')) : Promise.resolve(directory([]))
      return Promise.resolve({ ok: true })
    })
    await owner.initialize()
    expect(owner.getItem('navigation-control:root')).toMatchObject({ action: 'retry', label: '读取失败，重试：拒绝访问' })
    fail = false
    await owner.loadDirectory('root', true)
    expect(owner.getItem('navigation-control:root')).toMatchObject({ action: 'none', label: '空目录' })
  })

  it('新查询立即取消旧请求，旧查询完成不污染新结果', async () => {
    vi.useFakeTimers()
    const old = deferred<FileViewSearch>()
    const { owner, request } = setup((method, params) => {
      if (method === 'fileViews.openContext') return Promise.resolve(context())
      if (method === 'fileViews.listDirectory') return Promise.resolve(directory([]))
      if (method === 'fileViews.search') return params.query === '旧' ? old.promise : Promise.resolve(searchResult(2))
      return Promise.resolve({ ok: true })
    })
    await owner.initialize()
    owner.setQuery('旧')
    await vi.advanceTimersByTimeAsync(250)
    owner.setQuery('新')
    expect(request).toHaveBeenCalledWith('fileViews.cancel', expect.objectContaining({ contextId: 'context-1' }))
    await vi.advanceTimersByTimeAsync(250)
    old.resolve(searchResult(1))
    await Promise.resolve()
    expect(owner.getSnapshot().search.entries[0]?.name).toBe('文件-2.md')
  })

  it('第十一页仍可访问，已淘汰旧页借原游标重放', async () => {
    const { owner, request } = setup((method, params) => {
      if (method === 'fileViews.openContext') return Promise.resolve(context())
      if (method === 'fileViews.listDirectory') return Promise.resolve(directory([]))
      if (method === 'fileViews.search') {
        const page = params.cursor === undefined ? 0 : Number((params.cursor as string).slice(5))
        return Promise.resolve(searchResult(page, page < 12 ? `page-${page + 1}` : undefined))
      }
      return Promise.resolve({ ok: true })
    })
    await owner.initialize()
    owner.setQuery('.md')
    await owner.search()
    for (let page = 0; page < 12; page++) await owner.search(true)
    expect(owner.getSnapshot().search.pageIndex).toBe(12)
    expect(owner.getSnapshot().search.entries).toHaveLength(1)
    for (let page = 0; page < 11; page++) await owner.previousSearchPage()
    expect(owner.getSnapshot().search.entries[0]?.name).toBe('文件-1.md')
    expect(request.mock.calls.filter(([method, params]) => method === 'fileViews.search' && params.cursor === 'page-1')).toHaveLength(2)
  })

  it('释放后迟到的授权上下文也会关闭', async () => {
    const opened = deferred<FileViewContext>()
    const { owner, request } = setup((method) => method === 'fileViews.openContext' ? opened.promise : Promise.resolve({ ok: true }))
    const initializing = owner.initialize()
    await owner.dispose()
    opened.resolve(context('late-context'))
    await initializing
    expect(request).toHaveBeenCalledWith('fileViews.closeContext', { contextId: 'late-context' })
    expect(owner.getSnapshot().context).toBeNull()
  })

  it('新增选择保留旧上下文供已开文件，最后释放全部上下文', async () => {
    let opened = 0
    const { owner, request } = setup((method) => {
      if (method === 'fileViews.openContext') return Promise.resolve(context(`context-${++opened}`))
      if (method === 'fileViews.listDirectory') return Promise.resolve(directory([]))
      return Promise.resolve({ ok: true })
    })
    await owner.initialize()
    await owner.openContext('directory')
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.closeContext')).toHaveLength(0)
    await owner.dispose()
    expect(request).toHaveBeenCalledWith('fileViews.closeContext', { contextId: 'context-1' })
    expect(request).toHaveBeenCalledWith('fileViews.closeContext', { contextId: 'context-2' })
  })

  it('后台目录变更废弃旧游标，重新展开走刷新而非追加旧快照', async () => {
    let listings = 0
    const { owner, request } = setup((method) => {
      if (method === 'fileViews.openContext') return Promise.resolve(context())
      if (method === 'fileViews.listDirectory') return Promise.resolve(++listings === 1
        ? { ...directory([entry('旧.md')], 'old-cursor'), generation: 100 } : { ...directory([entry('新.md')]), generation: 101 })
      return Promise.resolve({ ok: true })
    })
    await owner.initialize()
    owner.directoryChanged({ contextId: 'context-1', directoryId: 'root', generation: 1 }, false)
    expect(owner.getSnapshot().directories.get('root')).toMatchObject({ dirty: true, nextCursor: undefined })
    await owner.loadDirectory('root')
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.listDirectory').at(-1)?.[1]).toMatchObject({ refresh: true })
    expect(owner.getChildren('root')).toEqual(['新.md'])
  })

  it('草稿关联后复用同一目录owner，新会话删除能释放原上下文', async () => {
    const request = vi.fn((method: string) => Promise.resolve(method === 'fileViews.openContext' ? context('draft-context') : method === 'fileViews.listDirectory' ? directory([]) : { ok: true }))
    window.cogent = { fileViewsRequest: request } as unknown as typeof window.cogent
    const owner = getFileNavigatorOwner({ scopeId: 'draft:owner-bind', projectId: 'p' })
    try {
      await owner.initialize()
      bindFileNavigatorScope('draft:owner-bind', 'bound-session')
      expect(getFileNavigatorOwner({ scopeId: 'bound-session', projectId: 'p', sessionId: 'bound-session' })).toBe(owner)
      await releaseFileNavigatorScope('bound-session')
      expect(request).toHaveBeenCalledWith('fileViews.closeContext', { contextId: 'draft-context' })
    } finally {
      await releaseFileNavigatorScope('draft:owner-bind')
      await releaseFileNavigatorScope('bound-session')
    }
  })
})
