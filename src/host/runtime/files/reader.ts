/** 当前文件服务；注册表只存身份，不保存内容。读边界校验版本与软链接，所有字节受预算约束。 */
import { randomUUID } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { homedir } from 'node:os'
import { imageSize } from 'image-size'
import type {
  FileContext,
  FileDescriptor,
  FileHandle,
  FileRead,
  FileKind
} from '../../../shared/files'
import { FILE_LIMITS } from '../../../shared/files'
import { toUserFileError } from '../../../shared/file-errors'
import { resolveFileTarget } from './paths'
import { parseInWorker } from '../read-attachment'

type Source = { context: Pick<FileContext, 'cwd' | 'roots' | 'platform'>; saved: boolean }
type Entry = {
  independent: boolean
  sessionId: string
  alias: string
  real: string
  descriptor: FileDescriptor
  turnId?: string
  delivery?: DeliveryRegistration
}
export interface DeliveryRegistration {
  sourcePath: string
  confirmedAt: number
  target: import('../../../shared/outputs').OutputTarget
  release: () => void
  actionTarget: () => Promise<string>
  relative: (raw: string) => Promise<FileDescriptor>
}
type Operation = { controller: AbortController; users: number }
const TYPES: Record<string, [FileKind, string]> = {
  '.html': ['text', 'text/html'],
  '.htm': ['text', 'text/html'],
  '.css': ['text', 'text/css'],
  '.js': ['text', 'text/javascript'],
  '.mjs': ['text', 'text/javascript'],
  '.svg': ['text', 'image/svg+xml'],
  '.json': ['text', 'application/json'],
  '.woff': ['other', 'font/woff'],
  '.woff2': ['other', 'font/woff2'],
  '.ttf': ['other', 'font/ttf'],
  '.wasm': ['other', 'application/wasm'],
  '.md': ['markdown', 'text/markdown'],
  '.mdx': ['text', 'text/plain'],
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.bmp': ['image', 'image/bmp'],
  '.pdf': ['pdf', 'application/pdf'],
  '.docx': ['office', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.doc': ['office', 'application/msword'],
  '.xlsx': ['office', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xlsm': ['office', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  '.xls': ['office', 'application/vnd.ms-excel'],
  '.pptx': ['office', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.wav': ['audio', 'audio/wav'],
  '.ogg': ['audio', 'audio/ogg'],
  '.m4a': ['audio', 'audio/mp4'],
  '.flac': ['audio', 'audio/flac'],
  '.mp4': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'],
  '.mov': ['video', 'video/quicktime']
}
const TEXT_EXT =
  /^(?:|\.(?:txt|log|json|jsonl|csv|tsv|ya?ml|toml|ini|env|conf|config|lock|gitignore|gitattributes|editorconfig|[cm]?[jt]sx?|html?|css|scss|less|svg|xml|py|rs|go|java|c|cpp|h|cs|sh|bash|ps1|sql|vue|svelte))$/i
function version(value: Awaited<ReturnType<typeof stat>>): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`
}

export class FileService {
  readonly serviceId = randomUUID()
  private entries = new Map<string, Entry>()
  private operations = new Map<string, Operation>()
  private canceled = new Set<string>()
  private active = 0
  private queue: Array<() => void> = []
  private desktopSources = new Map<string, Source>()
  constructor(
    private source: (sessionId: string, turnId?: string) => Source,
    private parse = parseInWorker
  ) {}

  private origin(owner: string, turnId?: string): Source { return this.desktopSources.get(owner) ?? this.source(owner, turnId) }
  registerDesktopOwner(owner: string, roots: string[]): void {
    this.desktopSources.set(owner, { context: { cwd: roots[0], roots, platform: process.platform }, saved: false })
  }
  releaseDesktopOwner(owner: string): void { this.releaseSession(owner); this.desktopSources.delete(owner) }
  /** 显式 lease 使用独立登记，释放时不会夺走旧 files.resolve 调用方的 ID。 */
  release(handle: FileHandle): void {
    const entry = this.entries.get(handle.fileId)
    if (entry === undefined) return
    if (entry.sessionId !== handle.sessionId) throw new Error('文件登记不属于此 owner')
    this.entries.delete(handle.fileId)
    entry.delivery?.release()
  }

  async resolve(
    sessionId: string,
    rawTarget: string,
    turnId?: string,
    relativeTo?: string,
    independent = false
  ): Promise<FileDescriptor> {
    const origin = this.origin(sessionId, turnId)
    if (relativeTo !== undefined) {
      const entry = await this.checked({ sessionId, fileId: relativeTo })
      if (entry.delivery !== undefined) return entry.delivery.relative(rawTarget)
    }
    const base =
      relativeTo === undefined
        ? origin.context
        : { ...origin.context, cwd: (await this.checked({ sessionId, fileId: relativeTo })).real }
    // relativeTo 指的是预览来源文件，其目录是 Markdown 本地依赖的基准。
    if (relativeTo !== undefined) base.cwd = dirname(base.cwd)
    const target = resolveFileTarget(rawTarget, base, homedir())
    return this.registerPath(sessionId, target.path, turnId, undefined, target, origin.saved, independent)
  }

  /** Host 内部字面路径登记口；产物路径不经过 Markdown URI/行列解析。 */
  async registerPath(sessionId: string, path: string, turnId?: string, delivery?: DeliveryRegistration,
    target: { location?: FileDescriptor['location']; locationWarning?: string } = {}, saved = true, independent = false): Promise<FileDescriptor> {
    this.origin(sessionId, turnId)
    const alias = path
    let real: string
    let info: Awaited<ReturnType<typeof stat>>
    try {
      real = await realpath(alias)
      info = await stat(real)
    } catch (error) {
      throw toUserFileError(error, 'path')
    }
    if (!info.isFile() && !info.isDirectory()) throw new Error('仅支持普通文件和目录')
    const extension = extname(real).toLowerCase()
    const [kind, mime] = info.isDirectory()
      ? ['directory' as const, 'inode/directory']
      : (TYPES[extension] ??
        (TEXT_EXT.test(extension)
          ? ['text' as const, 'text/plain']
          : ['other' as const, 'application/octet-stream']))
    const existing = [...this.entries.values()].find(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.turnId === turnId &&
        entry.alias === alias &&
        entry.real === real
    )
    const fileId = delivery === undefined && !independent ? existing?.descriptor.fileId ?? randomUUID() : randomUUID()
    const descriptor: FileDescriptor = {
      fileId,
      canonicalKey: process.platform === 'win32' ? real.toLowerCase() : real,
      serviceId: this.serviceId,
      path: delivery?.sourcePath ?? alias,
      name: basename(alias),
      kind,
      mime,
      size: info.size,
      version: version(info),
      source: saved ? 'saved' : 'current-workspace',
      ...(delivery !== undefined && { delivery: { sourcePath: delivery.sourcePath, confirmedAt: delivery.confirmedAt, target: delivery.target } }),
      ...(target.location !== undefined && { location: target.location }),
      ...(target.locationWarning !== undefined && { locationWarning: target.locationWarning })
    }
    // realpath/stat期间来源可能已经被删除；不能在撤销后重新登记一份迟到句柄。
    this.origin(sessionId, turnId)
    this.entries.set(fileId, { sessionId, alias, real, descriptor, turnId, delivery, independent })
    return descriptor
  }

  private async checked(handle: FileHandle): Promise<Entry> {
    this.origin(handle.sessionId)
    const entry = this.entries.get(handle.fileId)
    if (entry === undefined || entry.sessionId !== handle.sessionId)
      throw new Error('文件标识已失效，请重新点击文件链接')
    let actual: string
    try {
      actual = await realpath(entry.alias)
    } catch (error) {
      throw toUserFileError(error, 'path')
    }
    if (actual !== entry.real)
      throw new Error('符号链接目标已变化，请重新点击文件链接')
    return entry
  }
  async actionTarget(handle: FileHandle) {
    const entry = await this.checked(handle)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(entry.real)
    } catch (error) {
      throw toUserFileError(error, 'path')
    }
    if (!info.isFile() && !info.isDirectory()) throw new Error('目标已经不是普通文件或目录')
    return {
      path: entry.delivery === undefined ? entry.real : await entry.delivery.actionTarget(),
      name: entry.descriptor.name,
      kind: info.isDirectory() ? ('directory' as const) : entry.descriptor.kind
    }
  }
  /** 受管网页预览只在 Host 内取规范路径；外部仍通过有版本的分片读取。 */
  async previewTarget(handle: FileHandle) {
    const entry = await this.checked(handle)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(entry.real)
    } catch (error) {
      throw toUserFileError(error, 'file')
    }
    if (version(info) !== entry.descriptor.version) throw new Error('文件已变化，请重新加载')
    return { path: entry.real, version: entry.descriptor.version }
  }

  private async job<T>(
    read: FileRead,
    work: (entry: Entry, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const key = `${read.sessionId}/${read.operationId}`
    if (this.canceled.has(key)) throw new Error('预览已取消')
    let operation = this.operations.get(key)
    if (operation === undefined) {
      operation = { controller: new AbortController(), users: 0 }
      this.operations.set(key, operation)
    }
    operation.users++
    if (this.active >= 2) await new Promise<void>((resolve) => this.queue.push(resolve))
    else this.active++
    try {
      operation.controller.signal.throwIfAborted()
      const entry = await this.checked(read)
      let beforeInfo: Awaited<ReturnType<typeof stat>>
      try {
        beforeInfo = await stat(entry.real)
      } catch (error) {
        throw toUserFileError(error, 'file')
      }
      if (version(beforeInfo) !== read.version)
        throw new Error('文件已变化，请重新加载')
      const result = await work(entry, operation.controller.signal)
      operation.controller.signal.throwIfAborted()
      await this.checked(read)
      let afterInfo: Awaited<ReturnType<typeof stat>>
      try {
        afterInfo = await stat(entry.real)
      } catch (error) {
        throw toUserFileError(error, 'file')
      }
      if (version(afterInfo) !== read.version)
        throw new Error('文件在读取期间发生变化，请重新加载')
      return result
    } finally {
      operation.users--
      if (operation.users === 0 && this.operations.get(key) === operation)
        this.operations.delete(key)
      const next = this.queue.shift()
      if (next === undefined) this.active--
      else next()
    }
  }
  cancel(sessionId: string, operationId: string, fileId?: string): { ok: true } {
    const key = `${sessionId}/${operationId}`
    this.operations.get(key)?.controller.abort()
    this.canceled.add(key)
    const entry = fileId === undefined ? undefined : this.entries.get(fileId)
    if (entry?.sessionId === sessionId && entry.delivery !== undefined) { entry.delivery.release(); this.entries.delete(fileId!) }
    // 只为最近迟到分片保留轻量墓碑，不长期保存已经结束的 AbortController。
    if (this.canceled.size > 256) this.canceled.delete(this.canceled.values().next().value!)
    return { ok: true }
  }
  releaseSession(sessionId: string): void {
    for (const key of this.canceled) if (key.startsWith(sessionId + '/')) this.canceled.delete(key)
    // 显式登记由FileViewsService先撤销lease，最后一个在途hold结束后release；旧入口仍立即清理。
    for (const [id, entry] of this.entries)
      if (entry.sessionId === sessionId && !entry.independent) { entry.delivery?.release(); this.entries.delete(id) }
    for (const [key, operation] of this.operations)
      if (key.startsWith(sessionId + '/')) {
        operation.controller.abort()
        this.operations.delete(key)
      }
  }
  private async bytes(
    entry: Entry,
    expected: string,
    offset: number,
    length: number
  ): Promise<Buffer> {
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(entry.real, 'r')
    } catch (error) {
      throw toUserFileError(error, 'file')
    }
    try {
      const info = await file.stat()
      if (!info.isFile() || version(info) !== expected) throw new Error('文件已变化，请重新加载')
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, info.size - offset)))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (version(await file.stat()) !== expected)
        throw new Error('文件在读取期间发生变化，请重新加载')
      return buffer.subarray(0, bytesRead)
    } catch (error) {
      throw toUserFileError(error, 'file')
    } finally {
      await file.close()
    }
  }
  readChunk(read: FileRead & { offset: number; length: number }) {
    return this.job(read, async (entry) => {
      const limit = entry.descriptor.kind === 'image' ? FILE_LIMITS.image : FILE_LIMITS.binary
      if (entry.descriptor.size > limit)
        throw new Error(`文件超过预览容量 ${limit / 1024 / 1024} MiB，请用系统打开`)
      if (entry.descriptor.kind === 'directory') throw new Error('目录不能作为文件内容读取')
      const bytes = await this.bytes(entry, read.version, read.offset, read.length)
      if (entry.descriptor.kind === 'image' && read.offset === 0) {
        const dimensions = imageSize(bytes)
        if (dimensions.width * dimensions.height > FILE_LIMITS.pixels)
          throw new Error('图片超过 4000 万像素，请用系统打开')
      }
      return {
        base64: bytes.toString('base64'),
        nextOffset: read.offset + bytes.length,
        done: read.offset + bytes.length >= entry.descriptor.size
      }
    })
  }
  readText(read: FileRead & { offset?: number }) {
    return this.job(read, async (entry) => {
      if (entry.descriptor.kind === 'directory' || entry.descriptor.size > FILE_LIMITS.text)
        throw new Error('文本超过 20 MiB 或目标是目录，请用系统打开')
      const header = await this.bytes(entry, read.version, 0, 3)
      const encoding =
        header[0] === 0xff && header[1] === 0xfe
          ? 'utf-16le'
          : header[0] === 0xfe && header[1] === 0xff
            ? 'utf-16be'
            : 'utf-8'
      const offset = read.offset ?? 0
      let bytes = await this.bytes(entry, read.version, offset, FILE_LIMITS.chunk)
      // 跨块的 UTF-8 字符必须留到下一块；UTF-16 块长为偶数，不拆 code unit。
      if (encoding === 'utf-8' && offset + bytes.length < entry.descriptor.size) {
        let start = bytes.length - 1
        while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--
        const lead = bytes[start]
        const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
        if (bytes.length - start < width) bytes = bytes.subarray(0, start)
      } else if (encoding !== 'utf-8' && offset + bytes.length < entry.descriptor.size) {
        const last =
          encoding === 'utf-16le'
            ? bytes.readUInt16LE(bytes.length - 2)
            : bytes.readUInt16BE(bytes.length - 2)
        if (last >= 0xd800 && last <= 0xdbff) bytes = bytes.subarray(0, bytes.length - 2)
      }
      const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: offset !== 0 }).decode(bytes)
      if (text.includes('\0')) throw new Error('文件含二进制内容，不能作为文本预览')
      const next = offset + bytes.length
      return { text, encoding, ...(next < entry.descriptor.size && { nextOffset: next }) }
    })
  }
  parseDocument(read: FileRead & { cursor: number; sheet?: string; range?: string }) {
    return this.job(read, async (entry, signal) => {
      if (entry.descriptor.kind !== 'office' || entry.descriptor.size > FILE_LIMITS.binary)
        throw new Error('该文件不支持文档内容预览或超过 100 MiB')
      return this.parse(
        {
          path: entry.real,
          name: entry.descriptor.name,
          cursor: read.cursor,
          sheet: read.sheet,
          range: read.range
        },
        signal
      )
    })
  }
}
