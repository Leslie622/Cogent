/** 文件导航的数据所有者；目录分页与取消留在这里，树库只读取同步快照。 */
import { projectFileRoots, type FileViewContext, type FileViewEntry, type FileViewMethods, type FileViewRoot } from '@shared/file-views'
import { useProjectStore } from '@/stores/project'

export type FileNavigatorRequest = <M extends keyof FileViewMethods>(
  method: M,
  params: FileViewMethods[M]['params']
) => Promise<FileViewMethods[M]['result']>

export interface NavigatorSource {
  scopeId: string
  projectId?: string
  sessionId?: string
  grantIds?: string[]
}

type Status = 'idle' | 'loading' | 'ready' | 'error'
export interface NavigatorDirectory {
  entries: string[]
  rows: string[]
  status: Status
  nextCursor?: string
  complete: boolean
  truncated: boolean
  warning?: string
  error: string | null
  operationId: string | null
  generation: number
  dirty: boolean
}

export type NavigatorItem =
  | { id: string; type: 'root'; root: FileViewRoot }
  | { id: string; type: 'entry'; entry: FileViewEntry }
  | { id: string; type: 'control'; directoryId: string; action: 'more' | 'retry' | 'none'; label: string }

export interface NavigatorSearch {
  entries: FileViewEntry[]
  status: Status
  complete: boolean
  nextCursor?: string
  paused: boolean
  truncated: boolean
  scanned: number
  warnings: string[]
  error: string | null
  operationId: string | null
  pageIndex: number
}

export interface NavigatorSnapshot {
  context: FileViewContext | null
  opening: boolean
  error: string | null
  notice: string | null
  nodes: ReadonlyMap<string, NavigatorItem>
  roots: string[]
  directories: ReadonlyMap<string, NavigatorDirectory>
  expandedItems: string[]
  focusedItem: string | null
  query: string
  includeIgnored: boolean
  search: NavigatorSearch
  revision: number
}

export const NAVIGATOR_ROOT = 'workspace-file-navigation'
const EMPTY_IDS: string[] = []
const ROOT_ITEM: NavigatorItem = { id: NAVIGATOR_ROOT, type: 'root', root: { id: NAVIGATOR_ROOT, path: '', name: '文件', kind: 'directory' } }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function normalizeNavigatorPath(value: string): string {
  const slashed = value.replaceAll('\\', '/')
  return slashed === '/' ? '/' : slashed.replace(/\/+$/, '')
}

export function navigatorPathKey(value: string): string {
  const normalized = normalizeNavigatorPath(value)
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function sameNavigatorPath(a?: string, b?: string): boolean {
  return a !== undefined && b !== undefined && navigatorPathKey(a) === navigatorPathKey(b)
}

function isSameOrInsidePath(parent: string, target: string): boolean {
  const parentKey = navigatorPathKey(parent)
  const targetKey = navigatorPathKey(target)
  if (parentKey === targetKey) return true
  return parentKey === '/' ? targetKey.startsWith('/') : targetKey.startsWith(parentKey + '/')
}
const controlId = (directoryId: string): string => `navigation-control:${directoryId}`
const emptySearch = (): NavigatorSearch => ({
  entries: [], status: 'idle', complete: false, paused: false, truncated: false,
  scanned: 0, warnings: [], error: null, operationId: null, pageIndex: 0
})
const emptyDirectory = (): NavigatorDirectory => ({
  entries: [], rows: [], status: 'idle', complete: false, truncated: false,
  error: null, operationId: null, generation: 0, dirty: false
})

/** 上下文可被已打开的文件继续使用；卸载导航视图不是关闭上下文。 */
export class FileNavigatorOwner {
  private listeners = new Set<() => void>()
  private contexts = new Set<string>()
  private epoch = 0
  private searchEpoch = 0
  private disposed = false
  private searchTimer: ReturnType<typeof setTimeout> | null = null
  private initialRequest: Promise<void> | null = null
  private searchPages = new Map<number, NavigatorSearch>()
  private searchCursors = new Map<number, string | undefined>()
  private lastSearchPage: { pageIndex: number; cursor?: string } | null = null
  private directoryEvents = new Map<string, number>()
  private directoryLoads = new Map<string, Promise<void>>()
  private snapshot: NavigatorSnapshot = {
    context: null, opening: false, error: null, notice: null, nodes: new Map(), roots: [],
    directories: new Map(), expandedItems: [], focusedItem: null, query: '',
    includeIgnored: false, search: emptySearch(), revision: 0
  }

  constructor(readonly source: NavigatorSource, private readonly request: FileNavigatorRequest) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): NavigatorSnapshot => this.snapshot

  private update(patch: Partial<NavigatorSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch, revision: this.snapshot.revision + 1 }
    this.listeners.forEach((listener) => listener())
  }

  private cancelOperation(operationId: string, contextId?: string): void {
    void this.request('fileViews.cancel', { operationId, ...(contextId !== undefined && { contextId }) })
      .catch((error: unknown) => this.update({ notice: `取消文件操作失败：${message(error)}` }))
  }

  private cancelPending(): void {
    this.cancelSearch()
    for (const directory of this.snapshot.directories.values()) {
      if (directory.operationId !== null) this.cancelOperation(directory.operationId, this.snapshot.context!.contextId)
    }
  }

  initialize = (): Promise<void> => {
    if (this.initialRequest !== null) return this.initialRequest
    this.initialRequest = this.openContext().then(() => undefined)
    return this.initialRequest
  }

  async openContext(pick?: 'file' | 'directory'): Promise<FileViewContext | null> {
    const epoch = ++this.epoch
    this.update({ opening: true, error: null })
    try {
      const result = await this.request('fileViews.openContext', {
        scopeId: this.source.scopeId,
        ...(this.source.projectId !== undefined && { projectId: this.source.projectId }),
        ...(this.source.sessionId !== undefined && { sessionId: this.source.sessionId }),
        grantIds: this.snapshot.context?.grantIds ?? this.restoredGrants ?? this.source.grantIds ?? [],
        ...(pick !== undefined && { pick })
      })
      if (result.canceled) {
        if (epoch === this.epoch) this.update({ opening: false })
        return null
      }
      this.contexts.add(result.contextId)
      if (this.disposed || epoch !== this.epoch) {
        this.contexts.delete(result.contextId)
        await this.request('fileViews.closeContext', { contextId: result.contextId })
        return null
      }
      this.cancelPending()
      this.directoryEvents.clear()
      this.searchPages.clear()
      this.searchCursors.clear()
      this.lastSearchPage = null
      const nodes = new Map<string, NavigatorItem>()
      const directories = new Map<string, NavigatorDirectory>()
      const navigationRoots = this.source.projectId === undefined ? [] : projectFileRoots(result.roots)
      for (const root of navigationRoots) {
        nodes.set(root.id, { id: root.id, type: 'root', root })
        if (root.kind === 'directory') directories.set(root.id, emptyDirectory())
      }
      const expandedItems = navigationRoots.map((root) => root.id)
      this.update({
        context: result, opening: false, nodes, directories,
        roots: navigationRoots.map((root) => root.id), expandedItems, focusedItem: null,
        search: emptySearch(), notice: null
      })
      // 授权就绪即可打开所选文件，不让另一个大型根的目录快照阻塞文件预览。
      expandedItems.forEach((id) => { void this.loadDirectory(id) })
      if (this.snapshot.query.trim() !== '') void this.search()
      return result
    } catch (error) {
      if (epoch === this.epoch) this.update({ opening: false, error: message(error) })
      return null
    }
  }

  getItem = (id: string): NavigatorItem => id === NAVIGATOR_ROOT ? ROOT_ITEM : this.snapshot.nodes.get(id)!

  getChildren = (id: string): string[] => id === NAVIGATOR_ROOT
    ? this.snapshot.roots
    : this.snapshot.directories.get(id)?.rows ?? EMPTY_IDS

  setFocusedItem = (value: string | null | ((previous: string | null) => string | null)): void => {
    this.update({ focusedItem: typeof value === 'function' ? value(this.snapshot.focusedItem) : value })
  }

  setExpandedItems = (value: string[] | ((previous: string[]) => string[])): void => {
    const next = typeof value === 'function' ? value(this.snapshot.expandedItems) : value
    this.update({ expandedItems: next })
    for (const id of next) {
      if (this.snapshot.directories.get(id)?.status === 'idle') void this.loadDirectory(id)
    }
  }

  private writeDirectory(id: string, page: NavigatorDirectory, entries: FileViewEntry[] = []): void {
    const directories = new Map(this.snapshot.directories)
    const nodes = new Map(this.snapshot.nodes)
    for (const entry of entries) {
      nodes.set(entry.id, { id: entry.id, type: 'entry', entry })
      if (entry.kind === 'directory' && entry.blockedReason === undefined && !directories.has(entry.id)) {
        directories.set(entry.id, emptyDirectory())
      }
    }
    const control = controlId(id)
    let item: Extract<NavigatorItem, { type: 'control' }> | null = null
    if (page.status === 'loading') item = { id: control, type: 'control', directoryId: id, action: 'none', label: '正在加载…' }
    else if (page.dirty) item = { id: control, type: 'control', directoryId: id, action: 'retry', label: '目录已变化，重新加载' }
    else if (page.error !== null) item = { id: control, type: 'control', directoryId: id, action: 'retry', label: `读取失败，重试：${page.error}` }
    else if (page.nextCursor !== undefined) item = { id: control, type: 'control', directoryId: id, action: 'more', label: `加载更多（已加载 ${page.entries.length} 项）` }
    else if (page.truncated) item = { id: control, type: 'control', directoryId: id, action: 'none', label: page.warning ?? '目录超出读取预算，显示的条目不完整' }
    else if (page.complete && page.entries.length === 0) item = { id: control, type: 'control', directoryId: id, action: 'none', label: '空目录' }
    if (item !== null) nodes.set(control, item)
    else nodes.delete(control)
    directories.set(id, { ...page, rows: item === null ? page.entries : [...page.entries, control] })
    const focusedItem = this.snapshot.focusedItem === control && item === null
      ? entries[0]?.id ?? id : this.snapshot.focusedItem
    this.update({ nodes, directories, focusedItem })
  }

  async loadDirectory(id: string, refresh = false): Promise<void> {
    const context = this.snapshot.context
    const previous = this.snapshot.directories.get(id)
    if (context === null || previous === undefined) return
    if (!refresh && previous.status === 'loading') {
      await this.directoryLoads.get(id)
      return
    }
    refresh ||= previous.dirty
    if (!refresh && previous.complete) return
    const operationId = crypto.randomUUID()
    if (previous.operationId !== null) this.cancelOperation(previous.operationId, context.contextId)
    const epoch = this.epoch
    const entries = refresh ? [] : previous.entries
    this.writeDirectory(id, { ...previous, entries, status: 'loading', error: null, operationId, dirty: false })
    const task = (async () => {
      try {
        const result = await this.request('fileViews.listDirectory', {
          contextId: context.contextId, directoryId: id, limit: 200, operationId,
          ...(!refresh && previous.nextCursor !== undefined && { cursor: previous.nextCursor }),
          ...(refresh && { refresh: true })
        })
        if (this.disposed || epoch !== this.epoch || this.snapshot.directories.get(id)?.operationId !== operationId) return
        const ids = [...new Set([...entries, ...result.entries.map((entry) => entry.id)])]
        this.writeDirectory(id, {
          entries: ids, rows: [], status: 'ready', complete: result.complete,
          nextCursor: result.nextCursor, truncated: result.truncated, warning: result.warning,
          error: null, operationId: null, generation: result.generation, dirty: false
        }, result.entries)
      } catch (error) {
        if (epoch !== this.epoch || this.snapshot.directories.get(id)?.operationId !== operationId) return
        this.writeDirectory(id, { ...previous, entries, status: 'error', error: message(error), operationId: null })
      }
    })()
    this.directoryLoads.set(id, task)
    try {
      await task
    } finally {
      if (this.directoryLoads.get(id) === task) this.directoryLoads.delete(id)
    }
  }

  private isStale(epoch: number, contextId: string): boolean {
    return this.disposed || this.epoch !== epoch || this.snapshot.context?.contextId !== contextId
  }

  async revealPath(targetPath: string): Promise<string | null> {
    if (this.snapshot.context === null && this.initialRequest !== null) {
      await this.initialRequest
    }
    const contextId = this.snapshot.context?.contextId
    if (this.disposed || contextId === undefined || this.snapshot.roots.length === 0) return null
    const epoch = this.epoch
    const candidates = this.snapshot.roots
      .map((id) => this.snapshot.nodes.get(id))
      .filter((item): item is Extract<NavigatorItem, { type: 'root' }> =>
        item?.type === 'root' && item.root.kind === 'directory' && isSameOrInsidePath(item.root.path, targetPath)
      )
      .sort((a, b) => normalizeNavigatorPath(b.root.path).length - normalizeNavigatorPath(a.root.path).length)
    if (candidates.length === 0) return null
    if (sameNavigatorPath(candidates[0].root.path, targetPath)) {
      if (this.snapshot.focusedItem !== candidates[0].id) this.update({ focusedItem: candidates[0].id })
      return candidates[0].id
    }

    let currentId = candidates[0].id
    for (let depth = 0; depth < 64; depth++) {
      if (!this.snapshot.expandedItems.includes(currentId)) {
        this.update({ expandedItems: [...this.snapshot.expandedItems, currentId] })
      }
      let directory = this.snapshot.directories.get(currentId)
      if (directory === undefined) return null
      if (directory.status === 'loading') {
        await this.directoryLoads.get(currentId)
      } else if (directory.status === 'idle' || directory.dirty) {
        await this.loadDirectory(currentId)
      }
      if (this.isStale(epoch, contextId)) return null
      directory = this.snapshot.directories.get(currentId)
      if (directory === undefined) return null

      let matchId: string | undefined
      let nextDirId: string | undefined
      for (const entryId of directory.entries) {
        const node = this.snapshot.nodes.get(entryId)
        if (node?.type !== 'entry') continue
        if (sameNavigatorPath(node.entry.path, targetPath)) {
          matchId = node.id
          break
        }
        if (node.entry.kind === 'directory' && node.entry.blockedReason === undefined && isSameOrInsidePath(node.entry.path, targetPath)) {
          nextDirId = node.id
        }
      }
      if (matchId !== undefined) {
        if (this.snapshot.focusedItem !== matchId) this.update({ focusedItem: matchId })
        return matchId
      }
      if (nextDirId === undefined) return null
      currentId = nextDirId
    }
    return null
  }

  refresh = async (): Promise<void> => {
    this.update({ notice: null })
    if (this.snapshot.query.trim() !== '') {
      await this.search()
      return
    }
    // 深目录的缓存不影响首屏刷新；按展开顺序分批，避免成百上千个 IPC 同时排队。
    const ids = this.snapshot.expandedItems.filter((id) => this.snapshot.directories.has(id))
    for (let offset = 0; offset < ids.length; offset += 4) {
      await Promise.all(ids.slice(offset, offset + 4).map((id) => this.loadDirectory(id, true)))
    }
  }

  setQuery = (query: string): void => {
    this.cancelSearch()
    this.searchPages.clear()
    this.searchCursors.clear()
    this.update({ query, search: emptySearch() })
    if (query.trim() !== '') this.searchTimer = setTimeout(() => { this.searchTimer = null; void this.search() }, 250)
  }

  setIncludeIgnored = (includeIgnored: boolean): void => {
    this.cancelSearch()
    this.searchPages.clear()
    this.searchCursors.clear()
    this.update({ includeIgnored, search: emptySearch() })
    if (this.snapshot.query.trim() !== '') void this.search()
  }

  cancelSearch = (): void => {
    this.searchEpoch++
    if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    this.searchTimer = null
    const search = this.snapshot.search
    if (search.operationId !== null) this.cancelOperation(search.operationId, this.snapshot.context!.contextId)
    if (search.status === 'loading') this.update({ search: { ...search, status: 'ready', operationId: null, paused: true } })
  }

  async search(more = false): Promise<void> {
    if (!more) {
      this.cancelSearch()
      this.searchPages.clear()
      this.searchCursors.clear()
    }
    const context = this.snapshot.context
    const query = this.snapshot.query.trim()
    if (context === null || query === '' || this.snapshot.search.status === 'loading') return
    if (this.snapshot.roots.length === 0) {
      this.update({ search: { ...emptySearch(), status: 'ready', complete: true } })
      return
    }
    const previous = more ? this.snapshot.search : emptySearch()
    if (more && previous.nextCursor === undefined) return
    const pageIndex = more ? previous.pageIndex + 1 : 0
    const cursor = more ? previous.nextCursor : undefined
    await this.readSearchPage(pageIndex, cursor)
  }

  previousSearchPage = async (): Promise<void> => {
    const pageIndex = this.snapshot.search.pageIndex - 1
    if (pageIndex < 0) return
    this.cancelSearch()
    const cached = this.searchPages.get(pageIndex)
    if (cached !== undefined) {
      this.searchPages.delete(pageIndex)
      this.searchPages.set(pageIndex, cached)
      this.update({ search: cached })
      return
    }
    await this.readSearchPage(pageIndex, this.searchCursors.get(pageIndex))
  }

  private async readSearchPage(pageIndex: number, cursor?: string): Promise<void> {
    const context = this.snapshot.context!
    const previous = this.snapshot.search
    const query = this.snapshot.query.trim()
    const searchEpoch = ++this.searchEpoch
    const operationId = crypto.randomUUID()
    this.lastSearchPage = { pageIndex, cursor }
    this.update({ search: { ...previous, status: 'loading', error: null, operationId } })
    try {
      const result = await this.request('fileViews.search', {
        contextId: context.contextId, query, includeIgnored: this.snapshot.includeIgnored,
        operationId, limit: 200, ...(cursor !== undefined && { cursor })
      })
      if (this.disposed || searchEpoch !== this.searchEpoch) return
      const page: NavigatorSearch = {
        entries: result.entries, status: 'ready', complete: result.complete,
        nextCursor: result.nextCursor, paused: result.paused, truncated: result.truncated,
        scanned: result.scanned, warnings: result.warnings, error: null, operationId: null, pageIndex
      }
      this.searchCursors.set(pageIndex, cursor)
      this.searchPages.delete(pageIndex)
      this.searchPages.set(pageIndex, page)
      // renderer 仅驻留十页；首屏保留，旧页仍能借查询快照游标重新读取。
      while (this.searchPages.size > 10) {
        const victim = [...this.searchPages.keys()].find((key) => key !== 0 && key !== pageIndex)!
        this.searchPages.delete(victim)
      }
      this.update({ search: page })
    } catch (error) {
      if (searchEpoch !== this.searchEpoch) return
      this.update({ search: { ...previous, status: 'error', error: message(error), operationId: null } })
    }
  }

  retrySearch = async (): Promise<void> => {
    if (this.lastSearchPage === null) await this.search()
    else await this.readSearchPage(this.lastSearchPage.pageIndex, this.lastSearchPage.cursor)
  }

  showNotice = (notice: string): void => this.update({ notice })

  directoryChanged(event: { contextId: string; directoryId: string; generation: number; error?: string }, active: boolean): void {
    if (event.contextId !== this.snapshot.context?.contextId) return
    if (event.error !== undefined) { this.showNotice(`目录实时更新不可用：${event.error}`); return }
    const page = this.snapshot.directories.get(event.directoryId)
    if (page === undefined) return
    // watcher 的事件序号与 worker 的目录快照序号属于不同域，只能各自比较。
    const lastEvent = this.directoryEvents.get(event.directoryId)
    if (lastEvent !== undefined && event.generation <= lastEvent) return
    this.directoryEvents.set(event.directoryId, event.generation)
    if (page.operationId !== null) this.cancelOperation(page.operationId, event.contextId)
    this.writeDirectory(event.directoryId, { ...page, dirty: true, nextCursor: undefined, complete: false, status: 'idle', operationId: null })
    if (active && this.snapshot.expandedItems.includes(event.directoryId)) void this.loadDirectory(event.directoryId, true)
  }

  private restoredGrants: string[] | null = null

  async reconnect(): Promise<void> {
    if (this.disposed) return
    this.restoredGrants = this.snapshot.context?.grantIds ?? this.source.grantIds ?? []
    this.cancelPending()
    this.epoch++
    this.contexts.clear()
    this.directoryEvents.clear()
    this.update({ context: null, roots: [], nodes: new Map(), directories: new Map(), search: emptySearch(), error: null })
    this.initialRequest = this.openContext().then(() => undefined)
    await this.initialRequest
  }

  async dispose(): Promise<void> {
    this.cancelPending()
    this.disposed = true
    this.epoch++
    this.listeners.clear()
    const contexts = [...this.contexts]
    this.contexts.clear()
    await Promise.all(contexts.map((contextId) => this.request('fileViews.closeContext', { contextId })))
  }
}

const owners = new Map<string, { scopeId: string; owner: FileNavigatorOwner }>()
const sourceKey = (source: NavigatorSource): string => JSON.stringify([
  source.scopeId, source.projectId, source.sessionId,
  useProjectStore.getState().projects.find(project => project.id === source.projectId)?.cwds
])

export function getFileNavigatorOwner(source: NavigatorSource): FileNavigatorOwner {
  const key = sourceKey(source)
  let entry = owners.get(key)
  if (entry === undefined) {
    // 同一项目换根后旧请求只可释放旧上下文，不能重新发布旧目录树；文件 lease 独立归属。
    for (const [oldKey, previous] of owners) {
      const old = previous.owner.source
      if (old.scopeId === source.scopeId && old.projectId === source.projectId && old.sessionId === source.sessionId) {
        owners.delete(oldKey)
        void previous.owner.dispose().catch((error: unknown) => console.error('旧项目文件导航清理失败', error))
      }
    }
    entry = { scopeId: source.scopeId, owner: new FileNavigatorOwner(source, (method, params) => window.cogent.fileViewsRequest(method, params)) }
    owners.set(key, entry)
  }
  return entry.owner
}

export async function releaseFileNavigatorScope(scopeId: string): Promise<void> {
  const selected = [...owners].filter(([, entry]) => entry.scopeId === scopeId)
  selected.forEach(([key]) => owners.delete(key))
  await Promise.all(selected.map(([, entry]) => entry.owner.dispose()))
}

/** 后台会话的导航也要立即收尾，不能等用户切回时才释放旧根 watcher。 */
export async function invalidateProjectNavigators(projectId: string): Promise<void> {
  const selected = [...owners].filter(([, entry]) => entry.owner.source.projectId === projectId)
  selected.forEach(([key]) => owners.delete(key))
  await Promise.all(selected.map(([, entry]) => entry.owner.dispose()))
}

export async function invalidateFileNavigators(): Promise<void> {
  await Promise.all([...owners.values()].map(({ owner }) => owner.reconnect()))
}

/** 草稿提交沿用同一数据所有者；若只改 UI 标签 scope，旧目录上下文会永久失去清理入口。 */
export function bindFileNavigatorScope(draftScopeId: string, sessionId: string): void {
  for (const [key, entry] of [...owners]) {
    if (entry.scopeId !== draftScopeId) continue
    owners.delete(key)
    entry.scopeId = sessionId
    entry.owner.source.scopeId = sessionId
    entry.owner.source.sessionId = sessionId
    const nextKey = sourceKey(entry.owner.source)
    const previous = owners.get(nextKey)
    if (previous !== undefined && previous.owner !== entry.owner) {
      owners.set(`${nextKey}:retained:${crypto.randomUUID()}`, previous)
    }
    owners.set(nextKey, entry)
  }
}
