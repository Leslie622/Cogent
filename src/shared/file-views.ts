/** 多标签文件能力合同：桌面授权与运行期上下文分离，所有句柄只在本代 Host 有效。 */
import type { FileAction, FileDescriptor, FileLocation, FileMethods, ParsedFile } from './files'
import type { OutputTarget } from './outputs'

export const FILE_VIEWS_CHANNEL = 'fileViews:request'
export interface FileViewRoot { id: string; path: string; name: string; kind: 'file' | 'directory'; grantId?: string }
/** main 的项目事实根不带grantId；原生选择授权只用于预览，不能升级成项目导航根。 */
export function projectFileRoots<T extends FileViewRoot>(roots: readonly T[]): T[] {
  return roots.filter(root => root.kind === 'directory' && root.grantId === undefined)
}
export interface FileViewContext { contextId: string; generation: number; roots: FileViewRoot[]; selectedPaths: string[]; grantIds: string[]; canceled: false }
export type FileViewOpenResult = FileViewContext | { canceled: true; selectedPaths: [] }
export interface FileViewEntry { id: string; rootId: string; path: string; relativePath: string; name: string; kind: 'file' | 'directory'; symlink: boolean; blockedReason?: string }
export interface FileViewDirectory { entries: FileViewEntry[]; generation: number; complete: boolean; nextCursor?: string; truncated: boolean; warning?: string }
export interface FileViewSearch { entries: FileViewEntry[]; generation: number; complete: boolean; nextCursor?: string; scanned: number; paused: boolean; truncated: boolean; warnings: string[] }
export type FileViewSource =
  | { kind: 'session'; sessionId: string; turnId?: string; rawTarget: string; relativeTo?: string }
  | { kind: 'output'; target: OutputTarget }
  | { kind: 'context'; contextId: string; path: string; relativeTo?: string }
export interface FileViewLease { leaseId: string; descriptor: FileDescriptor; canonicalKey: string; ownerId: string }
export interface FileViewRead { leaseId: string; version: string; operationId: string }
/** 仅main经可信选择生成；renderer不能提交路径来扩大网页资源授权。 */
export interface FileViewPreviewPolicy { root: { path: string; realPath: string }; blockedRoots: string[] }
export const FILE_VIEW_PREVIEW_BLOCKED_NAMES = /^(?:\..*|credentials\.json|mcp-access\.json|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i
export function fileViewPreviewSensitivePath(path: string): boolean { return path.split(/[\\/]/).some(part => FILE_VIEW_PREVIEW_BLOCKED_NAMES.test(part)) }
export interface FileViewMethods {
  'fileViews.openContext': { params: { scopeId: string; projectId?: string; sessionId?: string; grantIds?: string[]; pick?: 'file' | 'directory' }; result: FileViewOpenResult }
  'fileViews.closeContext': { params: { contextId: string }; result: { ok: true } }
  'fileViews.acquire': { params: { source: FileViewSource; operationId: string }; result: FileViewLease }
  'fileViews.readText': { params: FileViewRead & { offset?: number }; result: FileMethods['files.readText']['result'] }
  'fileViews.readChunk': { params: FileViewRead & { offset: number; length: number }; result: FileMethods['files.readChunk']['result'] }
  'fileViews.parseDocument': { params: FileViewRead & { cursor: number; sheet?: string; range?: string }; result: ParsedFile }
  'fileViews.release': { params: { leaseId: string }; result: { ok: true } }
  'fileViews.listDirectory': { params: { contextId: string; directoryId: string; cursor?: string; limit?: number; operationId: string; refresh?: boolean }; result: FileViewDirectory }
  'fileViews.search': { params: { contextId: string; query: string; includeIgnored?: boolean; cursor?: string; limit?: number; operationId: string }; result: FileViewSearch }
  'fileViews.cancel': { params: { operationId: string; contextId?: string }; result: { ok: true } }
  'fileViews.action': { params: { leaseId: string; action: FileAction; location?: FileLocation }; result: { canceled: boolean } }
}
export type FileViewMethod = keyof FileViewMethods
export type FileViewForwardMethod = Exclude<FileViewMethod, 'fileViews.openContext' | 'fileViews.action'>
export type FileViewHostMethods = {
  [K in FileViewForwardMethod]: { params: FileViewMethods[K]['params'] & { windowId: number; windowEpoch?: number }; result: FileViewMethods[K]['result'] }
} & {
  'fileViews.registerContext': { params: { windowId: number; windowEpoch?: number; scopeId: string; roots: FileViewRoot[] }; result: FileViewContext }
  'fileViews.resetWindow': { params: { windowId: number; windowEpoch: number }; result: { ok: true } }
  'fileViews.releaseWindow': { params: { windowId: number }; result: { ok: true } }
  'fileViews.cloneLease': { params: { windowId: number; leaseId: string }; result: FileViewLease }
  'fileViews.previewResource': { params: { windowId: number; leaseId: string; relativePath: string; policy?: FileViewPreviewPolicy }; result: FileViewLease }
  'fileViews.actionTarget': { params: { windowId: number; windowEpoch?: number; leaseId: string; current?: boolean }; result: { path: string; name: string; kind: FileDescriptor['kind'] } }
}
export const FILE_VIEW_FORWARD_METHODS: FileViewForwardMethod[] = ['fileViews.closeContext', 'fileViews.acquire', 'fileViews.readText', 'fileViews.readChunk', 'fileViews.parseDocument', 'fileViews.release', 'fileViews.listDirectory', 'fileViews.search', 'fileViews.cancel']
