/**
 * 本地附件内容座：导入时保存原字节，发送时认领，读取时验证完整性。
 * 名称只作元数据，磁盘路径由随机 id / 内容摘要决定。服务器出口只接受注入。
 * owner: 壳草稿 -> import -> 原子发布 -> prepareForSend -> 会话引用。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { imageSize } from 'image-size'
import { ATTACHMENT_LIMITS, attachmentMime, formatAttachmentBytes, type AttachmentPathInfo, type AttachmentRef } from '../../shared/attachments'
import { directoryReference } from './directory-references'

export interface AttachmentUploader {
  upload(metadata: AttachmentRef, openStream: () => Readable, signal: AbortSignal,
    onProgress: (bytes: number) => void): Promise<{ locator: string }>
}
interface RecordFile { version: 1; ref: AttachmentRef; extension: string; sessions: string[] }
interface PendingImport { name: string; mime: string; size: number; bytes: number; path: string; writing: boolean }
export function validateAttachmentId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('附件 id 不合法')
}
function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > ATTACHMENT_LIMITS.fileBytes) {
    throw new Error('单个文件不能超过 100 MiB')
  }
}

export class AttachmentService {
  private root: string
  private pending = new Map<string, PendingImport>()
  private pathImports = new Map<string, AbortController>()
  constructor(hostRoot: string, private uploader?: AttachmentUploader) {
    this.root = join(hostRoot, 'attachments', 'v1')
    mkdirSync(join(this.root, 'objects'), { recursive: true })
    mkdirSync(join(this.root, 'records'), { recursive: true })
    mkdirSync(join(this.root, 'staging'), { recursive: true })
  }

  private recordPath(id: string): string { validateAttachmentId(id); return join(this.root, 'records', `${id}.json`) }
  private record(id: string): RecordFile {
    const value: unknown = JSON.parse(readFileSync(this.recordPath(id), 'utf8'))
    const r = value as Partial<RecordFile>
    if (r.version !== 1 || !r.ref || r.ref.id !== id || typeof r.ref.name !== 'string' ||
      typeof r.ref.mime !== 'string' || !Number.isSafeInteger(r.ref.size) || r.ref.size < 0 ||
      !/^[a-f0-9]{64}$/.test(r.ref.sha256) || typeof r.extension !== 'string' ||
      !/^\.[a-z0-9]{1,12}$|^$/.test(r.extension) || !Array.isArray(r.sessions) ||
      !r.sessions.every((s) => typeof s === 'string')) throw new Error(`附件元数据损坏：${id}`)
    return r as RecordFile
  }
  private save(record: RecordFile): void {
    const path = this.recordPath(record.ref.id)
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(record))
    renameSync(temp, path)
  }
  get(id: string): AttachmentRef { return this.record(id).ref }
  async resolve(id: string): Promise<{ ref: AttachmentRef; path: string }> {
    const ref = this.get(id); const path = this.path(id)
    const info = await stat(path)
    if (!info.isFile() || info.size !== ref.size) throw new Error(`附件原件缺失或大小不符：${ref.name}`)
    return { ref, path }
  }
  path(id: string): string {
    const r = this.record(id)
    return join(this.root, 'objects', r.ref.sha256 + r.extension)
  }
  /** 压缩后的资产索引用：记录与原件都在才返回路径，已释放或丢失返回 undefined。 */
  existingPath(id: string): string | undefined {
    try { const path = this.path(id); return existsSync(path) ? path : undefined }
    catch { return undefined }
  }
  forSession(id: string, sessionId: string): AttachmentRef {
    const r = this.record(id)
    if (!r.sessions.includes(sessionId)) throw new Error('附件不属于当前会话')
    return r.ref
  }
  claim(ids: string[], sessionId: string): AttachmentRef[] {
    const records = ids.map((id) => this.record(id))
    if (new Set(ids).size !== ids.length) throw new Error('附件包含重复引用')
    if (records.filter((r) => r.ref.mime.startsWith('image/')).length > ATTACHMENT_LIMITS.imagesPerMessage) throw new Error('每条消息最多添加20张图片')
    if (records.reduce((n, r) => n + r.ref.size, 0) > ATTACHMENT_LIMITS.messageBytes) throw new Error(`附件合计超过 ${formatAttachmentBytes(ATTACHMENT_LIMITS.messageBytes)}`)
    for (const r of records) {
      if (!r.sessions.includes(sessionId)) { r.sessions.push(sessionId); this.save(r) }
    }
    return records.map((r) => r.ref)
  }
  release(id: string, isDraftReferenced: (id: string) => boolean): void {
    const path = this.recordPath(id)
    if (!existsSync(path)) return
    const record = this.record(id)
    if (record.sessions.length > 0 || isDraftReferenced(id)) return
    const records = readdirSync(join(this.root, 'records')).filter((name) => name.endsWith('.json') && name !== `${id}.json`)
      .map((name) => this.record(name.slice(0, -5)))
    // 去重对象可被多个独立引用共享；最后一个元数据引用释放后才删原件。
    if (!records.some((other) => other.ref.sha256 === record.ref.sha256 && other.extension === record.extension)) rmSync(this.path(id), { force: true })
    rmSync(path)
  }
  releaseSession(sessionId: string, isDraftReferenced: (id: string) => boolean): void {
    const ids = readdirSync(join(this.root, 'records')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
    for (const id of ids) {
      const record = this.record(id)
      if (record.sessions.includes(sessionId)) {
        record.sessions = record.sessions.filter((session) => session !== sessionId); this.save(record)
        this.release(id, isDraftReferenced)
      }
    }
  }
  async verify(id: string, signal?: AbortSignal): Promise<void> {
    const r = this.record(id)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(this.path(id), { signal }) as AsyncIterable<Buffer>) { hash.update(chunk); size += chunk.length }
    if (size !== r.ref.size || hash.digest('hex') !== r.ref.sha256) throw new Error(`附件原件损坏：${r.ref.name}`)
  }
  async importPath(path: string, signal?: AbortSignal): Promise<AttachmentRef> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('不能添加文件夹，请选择文件')
    validateSize(info.size)
    return this.publish(createReadStream(path, { signal }), basename(path), '', signal)
  }
  async describePath(path: string): Promise<AttachmentPathInfo> {
    const info = await stat(path)
    if (info.isDirectory()) return directoryReference(path)
    if (!info.isFile()) throw new Error('不能添加文件夹，请选择文件')
    const name = basename(path)
    return { name, size: info.size, mime: attachmentMime(name) }
  }
  async importPathOperation(id: string, path: string): Promise<AttachmentRef> {
    validateAttachmentId(id)
    if (this.pathImports.has(id)) throw new Error('路径导入身份重复')
    if (this.pathImports.size + this.pending.size >= ATTACHMENT_LIMITS.importConcurrency) throw new Error('已有2项导入任务，请等待或重试')
    const controller = new AbortController(); this.pathImports.set(id, controller)
    try { return await this.importPath(path, controller.signal) }
    finally { this.pathImports.delete(id) }
  }
  begin(name: string, size: number, mime: string): string {
    validateSize(size)
    if (this.pathImports.size + this.pending.size >= ATTACHMENT_LIMITS.importConcurrency) throw new Error('已有2项导入任务，请等待或重试')
    const id = randomUUID()
    const path = join(this.root, 'staging', id)
    writeFileSync(path, '')
    this.pending.set(id, { name, size, mime, bytes: 0, path, writing: false })
    return id
  }
  async chunk(id: string, bytes: Buffer): Promise<void> {
    const p = this.requirePending(id)
    if (p.writing) throw new Error('上一附件分片尚未写完')
    if (bytes.length > ATTACHMENT_LIMITS.chunkBytes || p.bytes + bytes.length > p.size) throw new Error('附件分片超过声明大小')
    // 每次请求必须等待写完再送下一片；字节不经过事件广播。
    p.writing = true
    try {
      const file = await open(p.path, 'a')
      try { await file.writeFile(bytes); p.bytes += bytes.length } finally { await file.close() }
    } finally { p.writing = false }
  }
  cancel(id: string): void {
    validateAttachmentId(id)
    const importing = this.pathImports.get(id)
    if (importing !== undefined) { importing.abort(); return }
    const p = this.pending.get(id)
    // 完成/失败后的取消与移除可能交错；清理是幂等操作，不把原错误改成“找不到导入”。
    if (p === undefined) return
    if (p.writing) throw new Error('附件分片仍在写入')
    this.pending.delete(id)
    rmSync(p.path, { force: true })
  }
  async finish(id: string): Promise<AttachmentRef> {
    const p = this.requirePending(id)
    if (p.writing) throw new Error('附件分片仍在写入')
    if (p.bytes !== p.size) throw new Error('附件分片尚未收齐')
    // 发布期间仍占导入名额，避免分片收齐到内容发布之间提前释放并发槽。
    p.writing = true
    try { return await this.publish(createReadStream(p.path), p.name, p.mime) }
    finally { this.pending.delete(id); await unlink(p.path) }
  }
  private requirePending(id: string): PendingImport {
    validateAttachmentId(id)
    const p = this.pending.get(id)
    if (!p) throw new Error('附件导入已结束或取消')
    return p
  }
  private async publish(source: Readable, name: string, mime: string, signal?: AbortSignal): Promise<AttachmentRef> {
    const temp = join(this.root, 'staging', randomUUID())
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      if (size > ATTACHMENT_LIMITS.fileBytes) return done(new Error('文件在导入时超过 100 MiB'))
      hash.update(chunk); done(null, chunk)
    } })
    try {
      await pipeline(source, meter, createWriteStream(temp, { flags: 'wx' }), { signal })
      const extension = /^\.[a-z0-9]{1,12}$/.test(extname(name).toLowerCase()) ? extname(name).toLowerCase() : ''
      const ref: AttachmentRef = { id: randomUUID(), name, size, mime: attachmentMime(name, mime), sha256: hash.digest('hex') }
      if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(ref.mime)) {
        if (size > ATTACHMENT_LIMITS.imageBytes) throw new Error('图片不能超过 20 MiB')
        const dimensions = imageSize(readFileSync(temp))
        const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
        if (dimensions.type === undefined || types[dimensions.type] !== ref.mime) throw new Error('图片格式与文件声明不一致')
        if (dimensions.width * dimensions.height > ATTACHMENT_LIMITS.imagePixels) throw new Error('图片不能超过 4000 万像素')
      }
      const destination = join(this.root, 'objects', ref.sha256 + extension)
      if (existsSync(destination)) rmSync(temp)
      else renameSync(temp, destination)
      this.save({ version: 1, ref, extension, sessions: [] })
      return ref
    } finally { rmSync(temp, { force: true }) }
  }
  async prepareForSend(target: 'local' | 'server', refs: AttachmentRef[], signal: AbortSignal,
    onProgress: (id: string, bytes: number) => void = () => {}): Promise<Array<{ id: string; locator: string }>> {
    if (target === 'server' && !this.uploader) throw new Error('服务器附件上传器尚未配置')
    const prepared: Array<{ id: string; locator: string }> = []
    for (const supplied of refs) {
      const ref = this.get(supplied.id)
      await this.verify(ref.id, signal)
      const locator = target === 'local' ? this.path(ref.id) :
        (await this.uploader!.upload(ref, () => createReadStream(this.path(ref.id)), signal, (bytes) => onProgress(ref.id, bytes))).locator
      signal.throwIfAborted()
      prepared.push({ id: ref.id, locator })
    }
    return prepared
  }
}
