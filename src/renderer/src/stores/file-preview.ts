/* eslint-disable @typescript-eslint/no-unnecessary-condition -- 动态索引可能不存在；未开启 noUncheckedIndexedAccess，仍需运行期边界检查。 */
/** 每个标签独立持有文件租约；切换不释放，关闭/失效才释放。大字节缓存可回收。 */
import { create } from 'zustand'
import type { FileDescriptor, ParsedFile } from '@shared/files'
import { FILE_LIMITS } from '@shared/files'
import type { OutputTarget } from '@shared/outputs'
import type { FileLinkScope } from '@/features/home/files/FileLink'
import { acquireFile, releaseFile, cancelFileOperation } from '@/features/workspace/file-client'
import { useWorkspaceStore } from './workspace'
import { getFileNavigatorOwner } from '@/features/workspace/file-navigator-owner'
import type { FileViewMethods } from '@shared/file-views'
import { formatFileSystemError } from '@shared/file-errors'

export interface Preview {
  tabId: string; leaseId: string | null
  outputTarget?: OutputTarget
  scope: FileLinkScope; rawTarget: string; operationId: string; generation: number
  descriptor: FileDescriptor | null
  loading: boolean; error: string | null; text: string | null; encoding: string | null
  url: string | null; document: ParsedFile | null
  bytes: number; touchedAt: number; evicted: boolean
}
export interface FileViewState {
  searchQuery?: { search: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }
  scrollTop?: number; scrollLeft?: number; selection?: { anchor: number; head: number }
  renderScrollTop?: number; renderScrollLeft?: number
  markdownMode?: string; zoom?: number | null; page?: number
  sheet?: string; range?: string; cursors?: number[]; mediaTime?: number
}
interface PreviewState {
  current: Preview | null
  byTab: Record<string, Preview>
  views: Record<string, FileViewState>
  open: (scope: FileLinkScope, rawTarget: string, outputTarget?: OutputTarget) => Promise<void>
  navigate: (tabId: string, scope: FileLinkScope, rawTarget: string, outputTarget?: OutputTarget) => Promise<void>
  loadTab: (tabId: string, refresh?: boolean) => Promise<void>
  close: (tabId?: string) => void
  resetAll: () => void
  invalidate: () => void
  documentPage: (cursor: number, sheet?: string, range?: string, tabId?: string) => Promise<void>
  setView: (tabId: string, patch: FileViewState, expectedGeneration?: number) => void
  trim: (budget?: number) => void
}
let generation = 0
const reason = (error: unknown) => formatFileSystemError(error, 'file')
const blank = (tabId: string, scope: FileLinkScope, rawTarget: string, outputTarget?: OutputTarget): Preview => ({
  tabId, scope, rawTarget, outputTarget, leaseId: null, operationId: crypto.randomUUID(), generation: ++generation,
  descriptor: null, loading: true, error: null, text: null, encoding: null, url: null, document: null,
  bytes: 0, touchedAt: Date.now(), evicted: false
})
function dispose(preview: Preview): void {
  if (preview.url !== null) URL.revokeObjectURL(preview.url)
  void cancelFileOperation(preview.operationId).catch(() => {})
  if (preview.leaseId !== null) void releaseFile(preview.leaseId).catch(() => {})
}
function selected(byTab: Record<string, Preview>): Preview | null {
  const workspace = useWorkspaceStore.getState()
  return byTab[workspace.scopes[workspace.activeScopeId]?.activeId ?? ''] ?? null
}
export const useFilePreviewStore = create<PreviewState>((set, get) => ({
  current: null, byTab: {}, views: {},
  setView: (id, patch, expectedGeneration) => {
    if (expectedGeneration !== undefined && get().byTab[id]?.generation !== expectedGeneration) return
    if (!Object.values(useWorkspaceStore.getState().scopes).some(scope => scope.tabs.some(tab => tab.id === id))) return
    set(s => {
      const previous = s.views[id]
      if (Object.entries(patch).every(([key, value]) => JSON.stringify(previous?.[key as keyof FileViewState]) === JSON.stringify(value))) return s
      return { views: { ...s.views, [id]: { ...previous, ...patch } } }
    })
  },
  close: (tabId = get().current?.tabId) => { if (tabId !== undefined) useWorkspaceStore.getState().remove(tabId) },
  resetAll: () => { Object.values(get().byTab).forEach(dispose); set({ current: null, byTab: {}, views: {} }) },
  invalidate: () => {
    Object.values(get().byTab).forEach(dispose)
    const byTab = Object.fromEntries(Object.entries(get().byTab).map(([id, p]) => [id, { ...p, leaseId: null, descriptor: null, generation: ++generation, loading: false, error: '文件服务已重启，请重新加载', text: null, url: null, document: null, bytes: 0, evicted: false }]))
    set({ byTab, current: selected(byTab) })
  },
  open: async (scope, rawTarget, outputTarget) => {
    const workspace = useWorkspaceStore.getState()
    const scopeId = scope.workspaceScopeId ?? scope.sessionId ?? workspace.activeScopeId
    const id = workspace.openFile({ scope, target: rawTarget, outputTarget }, scopeId)
    await get().loadTab(id)
  },
  navigate: async (tabId, scope, rawTarget, outputTarget) => {
    if (!useWorkspaceStore.getState().navigateFile(tabId, { scope, target: rawTarget, outputTarget })) return
    const pending = get().loadTab(tabId, true)
    set(state => { const views = { ...state.views }; delete views[tabId]; return { views } })
    await pending
  },
  loadTab: async (tabId, refresh = false) => {
    const tab = Object.values(useWorkspaceStore.getState().scopes).flatMap(s => s.tabs).find(t => t.id === tabId)
    if (tab?.kind !== 'file') return
    const previous = get().byTab[tabId]
    if (!refresh && previous !== undefined && !previous.evicted) return
    if (previous !== undefined) { window.dispatchEvent(new Event('workspace:save-view-state')); dispose(previous) }
    const current = blank(tabId, tab.source.scope, tab.source.target, tab.source.outputTarget)
    const update = (patch: Partial<Preview>) => {
      if (get().byTab[tabId]?.generation !== current.generation) return
      set(s => { const byTab = { ...s.byTab, [tabId]: { ...s.byTab[tabId], ...patch } }; return { byTab, current: selected(byTab) } })
    }
    set(s => { const byTab = { ...s.byTab, [tabId]: current }; return { byTab, current: selected(byTab) } })
    const owns = () => get().byTab[tabId]?.generation === current.generation
    try {
      if (current.scope.contextId === 'restore') {
        const workspaceScope = useWorkspaceStore.getState().scopes[tab.scopeId]
        const owner = getFileNavigatorOwner({ scopeId: tab.scopeId, projectId: workspaceScope.projectId, sessionId: tab.scopeId.startsWith('draft:') ? undefined : tab.scopeId, grantIds: workspaceScope.grantIds })
        await owner.initialize()
        const context = owner.getSnapshot().context
        if (context === null) throw new Error(owner.getSnapshot().error ?? '文件目录授权不可用，请重新选择目录')
        current.scope = { ...current.scope, contextId: context.contextId }
        update({ scope: current.scope })
      }
      const lease = await acquireFile(current.scope, current.rawTarget, current.operationId, current.outputTarget)
      if (!owns()) { await releaseFile(lease.leaseId); return }
      if (!refresh && previous?.evicted && previous.descriptor !== null && previous.descriptor.version !== lease.descriptor.version) {
        await releaseFile(lease.leaseId)
        throw new Error('预览回收后文件内容已变化，请点击重新加载查看当前版本')
      }
      const effectiveId = useWorkspaceStore.getState().identifyFile(tabId, lease.canonicalKey, lease.descriptor)
      if (effectiveId !== tabId) {
        const existing = get().byTab[effectiveId]
        if (existing?.descriptor != null && lease.descriptor.location !== undefined) {
          const descriptor = { ...existing.descriptor, location: lease.descriptor.location, locationWarning: lease.descriptor.locationWarning }
          set(s => { const byTab = { ...s.byTab, [effectiveId]: { ...existing, descriptor } }; return { byTab, current: selected(byTab) } })
          get().setView(effectiveId, { selection: undefined, scrollTop: undefined, scrollLeft: undefined })
        }
        await releaseFile(lease.leaseId); return
      }
      if (!owns()) { await releaseFile(lease.leaseId); return }
      const descriptor = lease.descriptor
      update({ leaseId: lease.leaseId, descriptor, outputTarget: descriptor.delivery?.target })
      const read = { leaseId: lease.leaseId, version: descriptor.version, operationId: current.operationId }
      if (descriptor.kind === 'text' || descriptor.kind === 'markdown') {
        let offset: number | undefined = 0
        const chunks: string[] = []
        let encoding = ''
        while (offset !== undefined) {
          const result: FileViewMethods['fileViews.readText']['result'] = await window.cogent.fileViewsRequest('fileViews.readText', { ...read, offset })
          if (!owns()) return
          chunks.push(result.text); encoding = result.encoding; offset = result.nextOffset
        }
        const text = chunks.join('')
        update({ text, encoding, bytes: text.length * 2, loading: false })
      } else if (['image', 'pdf', 'audio', 'video', 'office'].includes(descriptor.kind)) {
        // Office库消费原始文件，不能再把附件解析器返回的文字当作页面渲染。
        // 单格式视觉范围跟随Zcode：普通Office25MiB，PPTX64MiB；Host全局100MiB合同不变。
        const limit = descriptor.kind === 'office'
          ? (/\.pptx$/i.test(descriptor.name) ? 64 : 25) * 1024 * 1024
          : descriptor.kind === 'image' ? FILE_LIMITS.image : FILE_LIMITS.binary
        if (descriptor.size > limit) throw new Error('文件超过 ' + limit / 1024 / 1024 + ' MiB 预览容量，请用系统打开')
        const chunks: Uint8Array<ArrayBuffer>[] = []
        let offset = 0
        for (;;) {
          const part = await window.cogent.fileViewsRequest('fileViews.readChunk', { ...read, offset, length: FILE_LIMITS.chunk })
          if (!owns()) return
          chunks.push(Uint8Array.from(atob(part.base64), c => c.charCodeAt(0)))
          offset = part.nextOffset
          if (part.done) break
        }
        if (!owns()) return
        const url = URL.createObjectURL(new Blob(chunks, { type: descriptor.mime }))
        update({ url, bytes: descriptor.size, loading: false })
      } else update({ loading: false })
      get().trim()
    } catch (error) { update({ error: reason(error), loading: false }) }
  },
  documentPage: async (cursor, sheet, range, tabId = get().current?.tabId) => {
    if (tabId === undefined) return
    const current = get().byTab[tabId]
    if (current?.descriptor == null || current.leaseId === null) return
    void cancelFileOperation(current.operationId).catch(() => {})
    const operationId = crypto.randomUUID(), ownGeneration = ++generation
    const update = (patch: Partial<Preview>) => set(s => {
      if (s.byTab[tabId]?.generation !== ownGeneration) return s
      const byTab = { ...s.byTab, [tabId]: { ...s.byTab[tabId], ...patch } }
      return { byTab, current: selected(byTab) }
    })
    set(s => { const byTab = { ...s.byTab, [tabId]: { ...current, operationId, generation: ownGeneration, loading: true, error: null } }; return { byTab, current: selected(byTab) } })
    get().setView(tabId, { sheet, range })
    try {
      const document = await window.cogent.fileViewsRequest('fileViews.parseDocument', { leaseId: current.leaseId, version: current.descriptor.version, operationId, cursor, sheet, range })
      update({ document, loading: false, bytes: document.text.length * 2 })
    } catch (error) { update({ error: reason(error), loading: false }) }
  },
  trim: (budget = 256 * 1024 * 1024) => {
    const active = selected(get().byTab)?.tabId
    let total = Object.values(get().byTab).reduce((sum, p) => sum + p.bytes, 0)
    let resident = Object.values(get().byTab).filter(p => p.bytes > 0).length
    const byTab = { ...get().byTab }
    for (const p of Object.values(byTab).sort((a, b) => a.touchedAt - b.touchedAt)) {
      // 同时限制重查看器数量，避免小编码图片或PDF的解码/worker绕过原始字节预算。
      if (total <= budget && resident <= 8) break
      if (p.tabId === active || p.loading || p.bytes === 0) continue
      if (p.url !== null) URL.revokeObjectURL(p.url)
      total -= p.bytes
      resident--
      byTab[p.tabId] = { ...p, text: null, url: null, document: null, bytes: 0, evicted: true }
    }
    set({ byTab, current: selected(byTab) })
  }
}))

useWorkspaceStore.subscribe((state) => {
  const ids = new Set(Object.values(state.scopes).flatMap(s => s.tabs.map(t => t.id)))
  const preview = useFilePreviewStore.getState()
  const removed = Object.values(preview.byTab).filter(p => !ids.has(p.tabId))
  if (removed.length > 0) {
    const byTab = { ...preview.byTab }, views = { ...preview.views }
    for (const p of removed) { dispose(p); delete byTab[p.tabId]; delete views[p.tabId] }
    useFilePreviewStore.setState({ byTab, views, current: selected(byTab) })
  } else {
    const current = selected(preview.byTab)
    if (current !== preview.current) {
      if (current !== null) {
        const touched = { ...current, touchedAt: Date.now() }, byTab = { ...preview.byTab, [current.tabId]: touched }
        useFilePreviewStore.setState({ current: touched, byTab })
      } else useFilePreviewStore.setState({ current })
    }
  }
})
