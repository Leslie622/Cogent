/* eslint-disable @typescript-eslint/no-unnecessary-condition -- 动态索引可能不存在；未开启 noUncheckedIndexedAccess，仍需运行期边界检查。 */
import { create } from 'zustand'
import type { BrowserCloseResult } from '@shared/browser'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace'
import { releaseFileNavigatorScope } from './file-navigator-owner'

const closers = new Map<string, () => Promise<BrowserCloseResult>>()
export const useWorkspaceRuntime = create<{ held: Record<string, WorkspaceTab> }>(() => ({ held: {} }))
export function registerTabClose(id: string, close: () => Promise<BrowserCloseResult>): () => void {
  closers.set(id, close)
  return () => { if (closers.get(id) === close) closers.delete(id) }
}
export function releaseHeldTab(id: string): void {
  useWorkspaceRuntime.setState(s => { const held = { ...s.held }; delete held[id]; return { held } })
}
const closing = new Map<string, Promise<boolean>>()
export function closeWorkspaceTab(id: string, remember = true): Promise<boolean> {
  const running = closing.get(id)
  if (running !== undefined) return running
  const operation = (async () => {
    const tab = Object.values(useWorkspaceStore.getState().scopes).flatMap(s => s.tabs).find(t => t.id === id)
    if (tab === undefined) return true
    const close = closers.get(id)
    if (tab.kind === 'browser' && close !== undefined) {
      const result = await close()
      if (!result.closed) return false
      if (result.keepMounted) useWorkspaceRuntime.setState(s => ({ held: { ...s.held, [id]: tab } }))
    }
    useWorkspaceStore.getState().remove(id, remember)
    return true
  })()
  closing.set(id, operation)
  void operation.finally(() => closing.delete(id)).catch(() => {})
  return operation
}
/** 不需要网页确认的标签一次提交；需要确认的网页依次协商，目标集合在开始时固定。 */
export async function closeWorkspaceTabs(ids: readonly string[], remember = true): Promise<boolean> {
  let batch: string[] = []
  const flush = () => { if (batch.length > 0) useWorkspaceStore.getState().removeMany(batch, remember); batch = [] }
  for (const id of ids) {
    const tab = Object.values(useWorkspaceStore.getState().scopes).flatMap(scope => scope.tabs).find(tab => tab.id === id)
    if (tab?.kind !== 'browser') { if (tab !== undefined) batch.push(id); continue }
    flush()
    if (!(await closeWorkspaceTab(id, remember))) return false
  }
  flush()
  return true
}
export async function disposeWorkspaceScope(scopeId: string): Promise<boolean> {
  const tabs = useWorkspaceStore.getState().scopes[scopeId]?.tabs ?? []
  if (!(await closeWorkspaceTabs(tabs.map(tab => tab.id), false))) return false
  await releaseFileNavigatorScope(scopeId)
  useWorkspaceStore.getState().dropScope(scopeId)
  return true
}
export function cycleWorkspaceTab(direction: number): void {
  const workspace = useWorkspaceStore.getState(), scope = workspace.scopes[workspace.activeScopeId]
  if (scope === undefined || scope.tabs.length === 0) return
  const index = scope.tabs.findIndex(t => t.id === scope.activeId)
  workspace.activate(scope.tabs[(index + direction + scope.tabs.length) % scope.tabs.length].id)
}

// 最后一个逻辑标签关闭后不再缓存导航上下文/目录watcher；文件/下载持有的lease由Host独立保留。
useWorkspaceStore.subscribe((state, previous) => {
  for (const [scopeId, scope] of Object.entries(state.scopes)) {
    if (scope.tabs.length === 0 && (previous.scopes[scopeId]?.tabs.length ?? 0) > 0) {
      void releaseFileNavigatorScope(scopeId).catch((error: unknown) => console.error('文件导航资源清理失败', error))
    }
  }
})
