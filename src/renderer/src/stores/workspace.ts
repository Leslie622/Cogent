/* eslint-disable @typescript-eslint/no-unnecessary-condition -- 动态索引可能不存在；未开启 noUncheckedIndexedAccess，仍需运行期边界检查。 */
/** 工作区只保存标签描述和布局；文件读取与网页实例由各自 owner 管理。 */
import { create } from 'zustand'
import type { FileDescriptor } from '@shared/files'
import type { OutputTarget } from '@shared/outputs'
import type { FileLinkScope } from '@/features/home/files/FileLink'
import type { BrowserMethods } from '@shared/browser'
import { bindFileNavigatorScope } from '@/features/workspace/file-navigator-owner'
import { WORKSPACE_DEFAULT_WIDTH } from '@/features/workspace/layout'
type BrowserHistory = BrowserMethods['history']['result']

export interface FileTabSource {
  scope: FileLinkScope
  target: string
  outputTarget?: OutputTarget
}
interface TabBase { id: string; scopeId: string; title: string; createdAt: number }
export type WorkspaceTab =
  | (TabBase & { kind: 'start' })
  | (TabBase & { kind: 'files' })
  | (TabBase & { kind: 'file'; source: FileTabSource; resourceKey: string; aliasKeys?: string[]; navigation: number; navigationMode?: 'current' })
  | (TabBase & { kind: 'browser'; url: string; privateGroupId?: string; history?: BrowserHistory; previewSource?: FileTabSource; favicon?: string | null; loading?: boolean })
export interface WorkspaceScope {
  projectId?: string
  tabs: WorkspaceTab[]
  activeId: string | null
  collapsed: boolean
  expanded: boolean
  width: number
  grantIds: string[]
}
export interface WorkspaceState {
  scopes: Record<string, WorkspaceScope>
  activeScopeId: string
  autoCollapsed: boolean
  recent: WorkspaceTab[]
  setScope: (scopeId: string, projectId?: string) => void
  bindDraft: (draftScope: string, sessionId: string) => void
  newTab: (scopeId?: string) => string
  openFiles: (scopeId?: string) => string
  openBrowser: (url?: string, privateGroupId?: string, scopeId?: string, background?: boolean) => string
  openPreview: (source: FileTabSource) => string
  openFile: (source: FileTabSource, scopeId: string) => string
  navigateFile: (id: string, source: FileTabSource) => boolean
  identifyFile: (id: string, canonicalKey: string, descriptor: FileDescriptor) => string
  updateBrowser: (id: string, patch: { title?: string; url?: string; history?: BrowserHistory; previewSource?: FileTabSource; favicon?: string | null; loading?: boolean }) => void
  activate: (id: string) => void
  remove: (id: string, remember?: boolean) => void
  removeMany: (ids: string[], remember?: boolean) => void
  reorder: (scopeId: string, ids: string[]) => void
  reopen: () => WorkspaceTab | null
  toggle: () => void
  setAutoCollapsed: (collapsed: boolean) => void
  setLayout: (patch: Partial<Pick<WorkspaceScope, 'collapsed' | 'expanded' | 'width'>>, scopeId?: string) => void
  setGrants: (scopeId: string, grantIds: string[]) => void
  dropScope: (scopeId: string) => void
  reset: () => void
}

export const EMPTY_WORKSPACE: WorkspaceScope = { tabs: [], activeId: null, collapsed: true, expanded: false, width: WORKSPACE_DEFAULT_WIDTH, grantIds: [] }
const initialScope = (): WorkspaceScope => ({ ...EMPTY_WORKSPACE, tabs: [], grantIds: [] })
const titleFor = (target: string) => target.replace(/[?#].*$/, '').split(/[/\\]/).at(-1) || target
const findTab = (scopes: WorkspaceState['scopes'], id: string) => Object.values(scopes).flatMap(s => s.tabs).find(tab => tab.id === id)
function reopenedSource(source: FileTabSource, scopeId: string): FileTabSource {
  const { relativeTo, parentSource, ...origin } = source.scope
  const base: FileLinkScope = origin.contextId === undefined ? origin : { ...origin, contextId: 'restore' }
  const scope: FileLinkScope = { ...base, workspaceScopeId: scopeId, ...(parentSource === undefined ? relativeTo === undefined ? {} : { relativeTo } : { parentSource: reopenedSource(parentSource, scopeId) }) }
  return { ...source, scope }
}
function sourceKey(source: FileTabSource): string {
  if (source.outputTarget !== undefined) return JSON.stringify(source.outputTarget)
  const { refs: _refs, ...scope } = source.scope
  return JSON.stringify([scope, source.target])
}
function insert(scope: WorkspaceScope, tab: WorkspaceTab): WorkspaceScope {
  const current = scope.tabs.find(t => t.id === scope.activeId)
  const tabs = current?.kind === 'start' && tab.kind !== 'start'
    ? scope.tabs.map(t => t.id === current.id ? tab : t)
    : [...scope.tabs, tab]
  return { ...scope, tabs, activeId: tab.id, collapsed: false }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const removeMany = (ids: string[], remember = true) => set((state) => {
    const removed = new Set(ids), scopes = { ...state.scopes }
    const closed: WorkspaceTab[] = []
    for (const [scopeId, scope] of Object.entries(scopes)) {
      if (!scope.tabs.some(tab => removed.has(tab.id))) continue
      closed.push(...scope.tabs.filter(tab => removed.has(tab.id)))
      const tabs = scope.tabs.filter(tab => !removed.has(tab.id))
      const oldIndex = scope.tabs.findIndex(tab => tab.id === scope.activeId)
      const activeId = scope.activeId !== null && removed.has(scope.activeId)
        ? scope.tabs.slice(oldIndex + 1).find(tab => !removed.has(tab.id))?.id ?? scope.tabs.slice(0, oldIndex).reverse().find(tab => !removed.has(tab.id))?.id ?? null
        : scope.activeId
      scopes[scopeId] = { ...scope, tabs, activeId, collapsed: tabs.length === 0 }
    }
    const recent = remember ? closed.filter(tab => tab.kind !== 'start' && !(tab.kind === 'browser' && tab.privateGroupId !== undefined)).reverse() : []
    return { scopes, recent: [...recent, ...state.recent].slice(0, 20) }
  })
  const add = (kind: 'start' | 'files' | 'browser', scopeId: string, url = '', privateGroupId?: string, background = false) => {
    const scope = get().scopes[scopeId] ?? initialScope()
    if (kind === 'files') {
      const existing = scope.tabs.find(t => t.kind === 'files')
      if (existing !== undefined) { get().activate(existing.id); return existing.id }
    }
    const base = { id: crypto.randomUUID(), scopeId, createdAt: Date.now() }
    const tab: WorkspaceTab = kind === 'browser'
      ? { ...base, kind, title: url === '' ? '浏览器' : url, url, ...(privateGroupId === undefined ? {} : { privateGroupId }) }
      : { ...base, kind, title: kind === 'start' ? '新标签页' : '文件' }
    set(state => ({ activeScopeId: background ? state.activeScopeId : scopeId, autoCollapsed: background ? state.autoCollapsed : false, scopes: { ...state.scopes, [scopeId]: background ? { ...scope, tabs: [...scope.tabs, tab] } : insert(scope, tab) } }))
    return tab.id
  }
  return {
    scopes: {}, activeScopeId: '', autoCollapsed: false, recent: [],
    setScope: (scopeId, projectId) => set(state => ({ activeScopeId: scopeId, scopes: { ...state.scopes, [scopeId]: { ...(state.scopes[scopeId] ?? initialScope()), projectId } } })),
    bindDraft: (draftScope, sessionId) => set(state => {
      const draft = state.scopes[draftScope]
      if (draft === undefined) return state
      bindFileNavigatorScope(draftScope, sessionId)
      const scopes = { ...state.scopes, [sessionId]: { ...draft, tabs: draft.tabs.map(t => t.kind === 'file' ? ({ ...t, scopeId: sessionId, source: { ...t.source, scope: { ...t.source.scope, workspaceScopeId: sessionId } } }) : ({ ...t, scopeId: sessionId })) } }
      delete scopes[draftScope]
      return { scopes, recent: state.recent.map(tab => tab.scopeId === draftScope ? { ...tab, scopeId: sessionId } : tab), activeScopeId: state.activeScopeId === draftScope ? sessionId : state.activeScopeId }
    }),
    newTab: (scopeId = get().activeScopeId) => add('start', scopeId),
    openFiles: (scopeId = get().activeScopeId) => add('files', scopeId),
    openBrowser: (url = '', privateGroupId, scopeId = get().activeScopeId, background = false) => add('browser', scopeId, url, privateGroupId, background),
    openPreview: source => {
      const id = add('browser', get().activeScopeId)
      set(state => {
        const scopeId = state.activeScopeId, scope = state.scopes[scopeId]
        return { scopes: { ...state.scopes, [scopeId]: { ...scope, tabs: scope.tabs.map(t => t.id === id && t.kind === 'browser' ? { ...t, title: titleFor(source.target), previewSource: source } : t) } } }
      })
      return id
    },
    openFile: (source, scopeId) => {
      const scope = get().scopes[scopeId] ?? initialScope()
      const resourceKey = sourceKey(source)
      const existing = scope.tabs.find(t => t.kind === 'file' && (t.resourceKey === resourceKey || t.aliasKeys?.includes(resourceKey) === true))
      if (existing !== undefined) { get().activate(existing.id); return existing.id }
      const tab: WorkspaceTab = { id: crypto.randomUUID(), scopeId, createdAt: Date.now(), kind: 'file', source, resourceKey, navigation: 0, title: titleFor(source.target) }
      set(state => ({ activeScopeId: scopeId, autoCollapsed: false, scopes: { ...state.scopes, [scopeId]: insert(scope, tab) } }))
      return tab.id
    },
    navigateFile: (id, source) => {
      const tab = findTab(get().scopes, id)
      // 原生选择器返回时，原标签可能已经关闭；迟到结果不能改写别的标签或重新建页。
      if (tab === undefined || (tab.kind !== 'file' && tab.kind !== 'files')) return false
      if (tab.kind === 'file' && sourceKey(tab.source) === sourceKey(source)) return false
      const replacement: WorkspaceTab = {
        id: tab.id, scopeId: tab.scopeId, createdAt: tab.createdAt, kind: 'file', source,
        resourceKey: sourceKey(source), title: titleFor(source.target),
        navigation: tab.kind === 'file' ? tab.navigation + 1 : 0, navigationMode: 'current'
      }
      set(state => ({ scopes: { ...state.scopes, [tab.scopeId]: { ...state.scopes[tab.scopeId], tabs: state.scopes[tab.scopeId].tabs.map(item => item.id === id ? replacement : item) } } }))
      return true
    },
    identifyFile: (id, canonicalKey, descriptor) => {
      const tab = findTab(get().scopes, id)
      if (tab?.kind !== 'file') return id
      const scope = get().scopes[tab.scopeId]
      const resourceKey = 'canonical:' + canonicalKey
      // 树内导航拥有自己的实例，不能因目标已在别页打开而移除当前标签。
      const existing = tab.navigationMode === 'current' ? undefined : scope.tabs.find(t => t.id !== id && t.kind === 'file' && t.resourceKey === resourceKey)
      const effectiveId = existing?.id ?? id
      const { relativeTo: _relativeTo, parentSource: _parent, refs: _refs, ...origin } = tab.source.scope
      const source: FileTabSource = { scope: { ...origin, refs: [] }, target: descriptor.path, ...(descriptor.delivery === undefined ? {} : { outputTarget: descriptor.delivery.target }) }
      const tabs = scope.tabs.filter(t => t.id !== id || existing === undefined).map(t => {
        if (t.id !== effectiveId || t.kind !== 'file') return t
        const aliasKeys = Array.from(new Set([...(t.aliasKeys ?? []), t.resourceKey, tab.resourceKey].filter(key => key !== resourceKey)))
        return { ...t, title: descriptor.name, resourceKey, aliasKeys, source, navigation: t.navigation + 1 }
      })
      set(state => ({ scopes: { ...state.scopes, [tab.scopeId]: { ...scope, tabs, activeId: scope.activeId === id ? effectiveId : scope.activeId } } }))
      return effectiveId
    },
    updateBrowser: (id, patch) => set(state => {
      const tab = findTab(state.scopes, id)
      if (tab?.kind !== 'browser') return state
      if (Object.entries(patch).every(([key, value]) => JSON.stringify(tab[key as keyof typeof patch]) === JSON.stringify(value))) return state
      const scope = state.scopes[tab.scopeId]
      return { scopes: { ...state.scopes, [tab.scopeId]: { ...scope, tabs: scope.tabs.map(t => t.id === id ? { ...t, ...patch } : t) } } }
    }),
    activate: id => set(state => {
      const tab = findTab(state.scopes, id)
      if (tab === undefined) return state
      return { activeScopeId: tab.scopeId, autoCollapsed: false, scopes: { ...state.scopes, [tab.scopeId]: { ...state.scopes[tab.scopeId], activeId: id, collapsed: false } } }
    }),
    remove: (id, remember = true) => set(state => {
      const tab = findTab(state.scopes, id)
      if (tab === undefined) return state
      const scope = state.scopes[tab.scopeId]
      const index = scope.tabs.findIndex(t => t.id === id)
      const tabs = scope.tabs.filter(t => t.id !== id)
      const activeId = scope.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : scope.activeId
      const retain = remember && tab.kind !== 'start' && !(tab.kind === 'browser' && tab.privateGroupId !== undefined)
      return { scopes: { ...state.scopes, [tab.scopeId]: { ...scope, tabs, activeId, collapsed: tabs.length === 0 } }, recent: retain ? [tab, ...state.recent].slice(0, 20) : state.recent }
    }),
    removeMany,
    reorder: (scopeId, ids) => set(state => {
      const scope = state.scopes[scopeId]
      const byId = new Map(scope.tabs.map(t => [t.id, t]))
      if (ids.length !== scope.tabs.length || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) throw new Error('标签排序目标已变化')
      return { scopes: { ...state.scopes, [scopeId]: { ...scope, tabs: ids.map(id => byId.get(id)!) } } }
    }),
    reopen: () => {
      const tab = get().recent.find(t => t.scopeId === get().activeScopeId)
      if (tab === undefined) return null
      const base = { ...tab, id: crypto.randomUUID(), createdAt: Date.now() }
      const restored: WorkspaceTab = base.kind === 'file' ? { ...base, source: reopenedSource(base.source, base.scopeId) }
        : base.kind === 'browser' && base.previewSource !== undefined ? { ...base, previewSource: reopenedSource(base.previewSource, base.scopeId) } : base
      set(state => ({ recent: state.recent.filter(t => t.id !== tab.id), scopes: { ...state.scopes, [tab.scopeId]: insert(state.scopes[tab.scopeId] ?? initialScope(), restored) }, activeScopeId: tab.scopeId, autoCollapsed: false }))
      return restored
    },
    toggle: () => {
      const state = get(), scope = state.scopes[state.activeScopeId] ?? initialScope()
      const collapsed = scope.collapsed || state.autoCollapsed
      if (collapsed && scope.tabs.length === 0) { state.newTab(); return }
      state.setLayout({ collapsed: !collapsed })
    },
    // 自动收起只属于窗口本轮呈现；显式开合接管它，scope只保留本次运行的手动意图。
    setAutoCollapsed: autoCollapsed => set({ autoCollapsed }),
    setLayout: (patch, scopeId = get().activeScopeId) => set(state => ({ ...(patch.collapsed === undefined || scopeId !== state.activeScopeId ? {} : { autoCollapsed: false }), scopes: { ...state.scopes, [scopeId]: { ...(state.scopes[scopeId] ?? initialScope()), ...patch } } })),
    setGrants: (scopeId, grantIds) => set(state => {
      const scope = state.scopes[scopeId] ?? initialScope()
      if (scope.grantIds.length === grantIds.length && scope.grantIds.every((id, i) => id === grantIds[i])) return state
      return { scopes: { ...state.scopes, [scopeId]: { ...scope, grantIds } } }
    }),
    dropScope: scopeId => set(state => { const scopes = { ...state.scopes }; delete scopes[scopeId]; return { scopes, recent: state.recent.filter(t => t.scopeId !== scopeId) } }),
    reset: () => set({ scopes: {}, recent: [], activeScopeId: '', autoCollapsed: false }),
  }
})
