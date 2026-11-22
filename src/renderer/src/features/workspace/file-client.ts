/** 所有正文、目录与工作区文件入口共享显式租约。relativeTo 只接受父租约。 */
import type { FileViewSource, FileViewLease } from '@shared/file-views'
import type { OutputTarget } from '@shared/outputs'
import type { FileLinkScope } from '@/features/home/files/FileLink'
import { getFileNavigatorOwner } from './file-navigator-owner'
import { useWorkspaceStore, type FileTabSource } from '@/stores/workspace'

export async function restoreFileSource(source: FileTabSource, scopeId: string): Promise<FileTabSource> {
  if (source.scope.contextId !== 'restore' || source.outputTarget !== undefined) return source
  const workspace = useWorkspaceStore.getState().scopes[scopeId]
  const owner = getFileNavigatorOwner({ scopeId, projectId: workspace.projectId, sessionId: scopeId.startsWith('draft:') ? undefined : scopeId, grantIds: workspace.grantIds })
  await owner.initialize()
  const context = owner.getSnapshot().context
  if (context === null) throw new Error(owner.getSnapshot().error ?? '文件目录授权不可用，请重新选择目录')
  return { ...source, scope: { ...source.scope, contextId: context.contextId } }
}

export function fileSource(scope: FileLinkScope, target: string, outputTarget?: OutputTarget): FileViewSource {
  if (outputTarget !== undefined) return { kind: 'output', target: outputTarget }
  if (scope.contextId !== undefined) return { kind: 'context', contextId: scope.contextId, path: target, relativeTo: scope.relativeTo }
  return { kind: 'session', sessionId: scope.sessionId, turnId: scope.turnId, rawTarget: target, relativeTo: scope.relativeTo }
}
export async function acquireFile(scope: FileLinkScope, target: string, operationId: string, outputTarget?: OutputTarget): Promise<FileViewLease> {
  const source = scope.contextId === 'restore' ? await restoreFileSource({ scope, target, outputTarget }, scope.workspaceScopeId ?? useWorkspaceStore.getState().activeScopeId) : { scope, target, outputTarget }
  if (source.scope.relativeTo === undefined && source.scope.parentSource !== undefined && outputTarget === undefined) {
    const parent = source.scope.parentSource
    const lease = await acquireFile(parent.scope, parent.target, operationId, parent.outputTarget)
    try { return await window.cogent.fileViewsRequest('fileViews.acquire', { source: fileSource({ ...source.scope, relativeTo: lease.leaseId }, target), operationId }) }
    finally { await releaseFile(lease.leaseId) }
  }
  return window.cogent.fileViewsRequest('fileViews.acquire', { source: fileSource(source.scope, target, outputTarget), operationId })
}
export async function releaseFile(leaseId: string): Promise<void> {
  await window.cogent.fileViewsRequest('fileViews.release', { leaseId })
}
export async function cancelFileOperation(operationId: string): Promise<void> {
  await window.cogent.fileViewsRequest('fileViews.cancel', { operationId })
}
