/** 文件域的纯合同；路径来源属于用户回合，fileId 只在本次 Host 服务内有效。 */
export type {
  FileAction,
  FileActionRequest,
  FileContext,
  FileDescriptor,
  FileHandle,
  FileInternalMethods,
  FileKind,
  FileLocation,
  FileMethods,
  FileRead,
  FileReference,
  ParsedFile
} from '../protocol/domains'

export const SHELL_FILE_METHODS = [
  'files.resolve',
  'files.readText',
  'files.readChunk',
  'files.parseDocument',
  'files.cancel'
] as const

export const FILE_LIMITS = {
  chunk: 256 * 1024,
  text: 20 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  pixels: 40_000_000,
  binary: 100 * 1024 * 1024
} as const
