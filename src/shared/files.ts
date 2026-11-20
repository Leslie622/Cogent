/** 文件域的纯合同；路径来源属于用户回合，fileId 只在本次 Host 服务内有效。 */
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
export interface FileDescriptor {
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
  'files.cancel': { params: { sessionId: string; operationId: string }; result: { ok: true } }
}
/** main 专用能力不在 renderer 白名单；实际系统动作前再次复核目标。 */
export interface FileInternalMethods {
  'files.actionTarget': {
    params: FileHandle
    result: { path: string; name: string; kind: FileKind }
  }
}
export const SHELL_FILE_METHODS = [
  'files.resolve',
  'files.readText',
  'files.readChunk',
  'files.parseDocument',
  'files.cancel'
] as const
export type FileAction = 'open' | 'reveal' | 'save' | 'editor'
export interface FileActionRequest extends FileHandle {
  action: FileAction
  location?: FileLocation
}
export const FILE_LIMITS = {
  chunk: 256 * 1024,
  text: 20 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  pixels: 40_000_000,
  binary: 100 * 1024 * 1024
} as const
