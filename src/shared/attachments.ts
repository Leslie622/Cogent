/** 附件的可序列化壳契约；文件原件由Host管理，目录暴露用户明确引用的实时路径。 */
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
export function isDirectoryRef(value: unknown): value is DirectoryRef {
  if (typeof value !== 'object' || value === null) return false
  const ref = value as Partial<DirectoryRef>
  return ref.kind === 'directory' && typeof ref.name === 'string' && ref.name.length > 0 &&
    typeof ref.path === 'string' && ref.path.length > 0 && !ref.path.includes('\0')
}
export type AttachmentPathInfo = AttachmentMetadata | DirectoryRef
export interface AttachmentRejection { name: string; reason: string }

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
  '.txt': 'text/plain', '.csv': 'text/csv', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg', '.3gp': 'video/3gpp', '.ogv': 'video/ogg', '.flv': 'video/x-flv', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.json': 'application/json', '.md': 'text/markdown'
}
export function attachmentMime(name: string, hint = ''): string {
  const extension = /\.[a-z0-9]{1,12}$/i.exec(name)?.[0].toLowerCase() ?? ''
  return MIME[extension] ?? (hint || 'application/octet-stream')
}
export function formatAttachmentBytes(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : bytes < 1000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1000_000).toFixed(1)} MB`
}

/** 草稿和Host共同消费同一数量/容量策略；普通文件没有按项数封顶。 */
export function attachmentAdmissionIssue(item: AttachmentMetadata, existing: readonly AttachmentMetadata[]): string | undefined {
  if (item.size > ATTACHMENT_LIMITS.fileBytes) return `单文件上限为 ${formatAttachmentBytes(ATTACHMENT_LIMITS.fileBytes)}`
  if (NATIVE_IMAGE_MIMES.includes(item.mime) && item.size > ATTACHMENT_LIMITS.imageBytes) return `图片上限为 ${formatAttachmentBytes(ATTACHMENT_LIMITS.imageBytes)}`
  if (item.mime.startsWith('image/') && existing.filter((entry) => entry.mime.startsWith('image/')).length >= ATTACHMENT_LIMITS.imagesPerMessage) {
    return `每条消息最多添加 ${ATTACHMENT_LIMITS.imagesPerMessage} 张图片`
  }
  if (existing.reduce((total, entry) => total + entry.size, 0) + item.size > ATTACHMENT_LIMITS.messageBytes) {
    return `附件合计上限为 ${formatAttachmentBytes(ATTACHMENT_LIMITS.messageBytes)}`
  }
  return undefined
}

/** IPC/旧数据边界复用；不把磁盘上的类型断言当校验。 */
export function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== 'object' || value === null) return false
  const ref = value as Partial<AttachmentRef>
  return typeof ref.id === 'string' && /^[a-f0-9-]{36}$/.test(ref.id) && typeof ref.name === 'string' &&
    typeof ref.mime === 'string' && typeof ref.size === 'number' && Number.isSafeInteger(ref.size) && ref.size >= 0 &&
    typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)
}

export const ATTACHMENT_LIMITS = {
  imagesPerMessage: 20,
  importConcurrency: 2,
  fileBytes: 100 * 1024 * 1024,
  messageBytes: 200 * 1024 * 1024,
  imageBytes: 20 * 1024 * 1024,
  imagePixels: 40_000_000,
  chunkBytes: 256 * 1024
} as const

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

export const NATIVE_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export function hasLocalAttachmentReader(ref: AttachmentRef): boolean {
  return ref.mime.startsWith('text/') || /\.(?:pdf|docx|xlsx|pptx|txt|md|csv|tsv|json|jsonl|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|css|html|xml|yaml|yml|toml|log|sql|sh|ps1|ini|conf)$/i.test(ref.name)
}
export function mediaBindingIssue(ref: AttachmentRef, binding: MediaBinding): string | undefined {
  if (binding.maxBytes !== undefined && ref.size > binding.maxBytes) return '超过分析工具的容量限制'
  const extension = '.' + ref.name.split('.').at(-1)!.toLowerCase()
  if (binding.formats.length > 0 && !binding.formats.includes(extension)) return '分析工具未声明支持此格式'
  return undefined
}

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

export const SHELL_ATTACHMENT_METHODS = [
  'attachments.describe', 'attachments.importPath', 'attachments.begin', 'attachments.chunk', 'attachments.finish',
  'attachments.cancel', 'attachments.release', 'attachments.resolve', 'attachments.draft', 'attachments.saveDraft',
  'attachments.media', 'attachments.saveMedia'
] as const satisfies readonly (keyof AttachmentMethods)[]
