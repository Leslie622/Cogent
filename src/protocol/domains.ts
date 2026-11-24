/**
 * 引擎协议的领域契约类型：配置、搜索、标题、附件、文件、产物与文件视图的纯 wire 形状。
 *
 * 边界纪律：
 * - 零运行时依赖，不 import shared / host / electron / renderer；
 * - shared/ 单向从 protocol/ 复导出这些 wire 类型，保证依赖方向严格为
 *   renderer → shared → protocol ← host。
 */

// ———— 业务配置 ————

export interface SessionDefaults {
  defaultPermissionMode: 'ask' | 'auto'
}

export interface DefaultsMethods {
  'session.defaults.get': { params: Record<string, never>; result: SessionDefaults }
  'session.defaults.set': { params: SessionDefaults; result: SessionDefaults }
}

// ———— 会话搜索 ————

export interface MessageSource { id: string; start: number; end: number }
export interface SearchRange { start: number; end: number }
export interface SearchQuery {
  query: string
  projectId?: string
  includeArchived?: boolean
  sessionId?: string
  limit?: number
  cursor?: string
}
export interface SearchSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  projectId?: string
  archivedAt?: number
}
export interface SearchHit {
  key: string
  role: 'user' | 'assistant'
  snippet: string
  ranges: SearchRange[]
  anchor: { sourceId: string; offset: number }
}
export interface SearchResult {
  session: SearchSession
  titleRanges: SearchRange[]
  hits: SearchHit[]
  moreHits: boolean
}
export interface SearchPage {
  items: SearchResult[]
  nextCursor?: string
  /** 来源损坏时仍返回其他聊天，明确说明结果不完整。 */
  issues: Array<{ sessionId: string; message: string }>
}
export interface SessionSearchMethods {
  'session.search': { params: SearchQuery; result: SearchPage }
  'session.search.rebuild': { params: Record<string, never>; result: { ok: true } }
}

// ———— 会话自动标题 ————

export interface SessionTitleSettings {
  enabled: boolean
  /** @deprecated 仅兼容旧客户端；Host 忽略此字段，标题始终使用首条输入的实际模型。 */
  model?: { provider: string; id: string }
}
export interface SessionTitleMethods {
  'session.titleSettings.get': { params: Record<string, never>; result: SessionTitleSettings }
  'session.titleSettings.set': { params: SessionTitleSettings; result: SessionTitleSettings }
}

// ———— 附件 ————

export interface AttachmentRef {
  id: string
  name: string
  size: number
  mime: string
  sha256: string
}
export type AttachmentMetadata = Pick<AttachmentRef, 'name' | 'size' | 'mime'>
/** 目录只保留实时路径；不伪造文件摘要/大小，也不进入上传和原件引用计数。 */
export interface DirectoryRef { kind: 'directory'; name: string; path: string }
export type AttachmentPathInfo = AttachmentMetadata | DirectoryRef
export interface AttachmentRejection { name: string; reason: string }
export interface AttachmentDraft {
  id: string
  text: string
  attachments: AttachmentRef[]
  directories?: DirectoryRef[]
}
export type MediaCapability = 'image' | 'video' | 'document'
export interface MediaBinding {
  server: string
  tool: string
  pathArgument: string
  questionArgument: string
  pagesArgument?: string
  formats: string[]
  maxBytes?: number
  audio?: boolean
}
export type MediaBindings = Partial<Record<MediaCapability, MediaBinding>>
export interface AttachmentMethods {
  'attachments.describe': { params: { path: string }; result: AttachmentPathInfo }
  'attachments.importPath': { params: { path: string; operationId?: string }; result: AttachmentRef }
  'attachments.begin': { params: { name: string; size: number; mime: string }; result: { id: string } }
  'attachments.chunk': { params: { id: string; base64: string }; result: { ok: true } }
  'attachments.finish': { params: { id: string }; result: AttachmentRef }
  'attachments.cancel': { params: { id: string }; result: { ok: true } }
  'attachments.release': { params: { id: string }; result: { ok: true } }
  'attachments.resolve': { params: { id: string }; result: { ref: AttachmentRef; path: string } }
  'attachments.draft': { params: { id: string }; result: AttachmentDraft }
  'attachments.saveDraft': { params: { id: string; text: string; attachmentIds: string[]; directories?: DirectoryRef[] }; result: { ok: true } }
  'attachments.media': { params: Record<string, never>; result: MediaBindings }
  'attachments.saveMedia': { params: { bindings: MediaBindings }; result: { ok: true } }
}

// ———— 文件与产物 ————

export interface FileContext {
  version: 1
  turnId: string
  userEntryId: string
  cwd: string
  roots: string[]
  platform: string
}
export interface FileLocation {
  line: number
  column?: number
  endLine?: number
}
export interface FileReference {
  path: string
  turnId?: string
}
export type FileKind =
  'text' | 'markdown' | 'image' | 'pdf' | 'office' | 'audio' | 'video' | 'directory' | 'other'
export interface OutputTarget {
  sessionId: string
  turnId: string
  revision: number
  outputId: string
  version: 'delivery' | 'current'
}
export interface FileDescriptor {
  /** Host 按真实目标计算；显示路径仍保留用户使用的别名。 */
  canonicalKey?: string
  fileId: string
  serviceId: string
  path: string
  name: string
  kind: FileKind
  mime: string
  size: number
  version: string
  location?: FileLocation
  locationWarning?: string
  source: 'saved' | 'current-workspace'
  delivery?: { sourcePath: string; confirmedAt: number; target: OutputTarget }
}
export interface FileHandle {
  sessionId: string
  fileId: string
}
export interface FileRead extends FileHandle {
  version: string
  operationId: string
}
export interface ParsedFile {
  text: string
  source: string
  warnings: string[]
  nextCursor?: number
  total?: number
  requiresVisual?: boolean
}
export interface FileMethods {
  'files.resolve': {
    params: { sessionId: string; turnId?: string; rawTarget: string; relativeTo?: string }
    result: FileDescriptor
  }
  'files.readText': {
    params: FileRead & { offset?: number }
    result: { text: string; encoding: string; nextOffset?: number }
  }
  'files.readChunk': {
    params: FileRead & { offset: number; length: number }
    result: { base64: string; nextOffset: number; done: boolean }
  }
  'files.parseDocument': {
    params: FileRead & { cursor: number; sheet?: string; range?: string }
    result: ParsedFile
  }
  'files.cancel': { params: { sessionId: string; operationId: string; fileId?: string }; result: { ok: true } }
}
/** main 专用能力不在 renderer 白名单；实际系统动作前再次复核目标。 */
export interface FileInternalMethods {
  'files.actionTarget': {
    params: FileHandle
    result: { path: string; name: string; kind: FileKind }
  }
}
export type FileAction = 'open' | 'reveal' | 'save' | 'editor'
export interface FileActionRequest extends FileHandle {
  action: FileAction
  location?: FileLocation
}

export interface OutputDeclaration { path: string; note?: string }
export interface OutputItem {
  outputId: string
  sourcePath: string
  realPath: string
  name: string
  note?: string
  size: number
  confirmedAt: number
  copy: { status: 'saved'; relativePath: string; sha256: string } | { status: 'source-only'; reason: string }
  warning?: string
}
export type OutputOutcome = 'completed' | 'aborted' | 'error'
export interface TurnOutputs {
  version: 1
  sessionId: string
  turnId: string
  revision: number
  state: 'running' | 'finalizing' | 'ready' | 'interrupted'
  declared: boolean
  active: OutputItem[]
  published: OutputItem[]
  outcome?: OutputOutcome
  warning?: string
}
export interface OutputMethods {
  'outputs.get': { params: { sessionId: string; turnId?: string }; result: TurnOutputs[] }
  'outputs.resolve': { params: OutputTarget; result: FileDescriptor }
}

// ———— 文件视图 ————

export interface FileViewRoot { id: string; path: string; name: string; kind: 'file' | 'directory'; grantId?: string }
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
