/** 产物受管存储：先保存字节再原子换 manifest；所有删除只接受受管根内的派生路径。 */
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, copyFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { OutputItem, TurnOutputs } from '../../../shared/outputs'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
const itemSchema = z.object({
  outputId: id, sourcePath: z.string().min(1), realPath: z.string().min(1), name: z.string().min(1),
  note: z.string().max(200).optional(), size: z.number().int().nonnegative(), confirmedAt: z.number().nonnegative(),
  copy: z.discriminatedUnion('status', [
    z.object({ status: z.literal('saved'), relativePath: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.object({ status: z.literal('source-only'), reason: z.string().min(1) })
  ]), warning: z.string().optional()
})
const manifestSchema = z.object({
  version: z.literal(1), sessionId: id, turnId: id, revision: z.number().int().positive(),
  state: z.enum(['running', 'finalizing', 'ready', 'interrupted']), declared: z.boolean(),
  active: z.array(itemSchema).max(100), published: z.array(itemSchema).max(100),
  outcome: z.enum(['completed', 'aborted', 'error']).optional(), warning: z.string().optional()
})
export const OUTPUT_LIMITS = { items: 100, note: 200, file: 100 * 1024 ** 2, revision: 256 * 1024 ** 2, session: 1024 ** 3, timeout: 30_000 }
const signature = (s: Awaited<ReturnType<typeof stat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`

export class OutputStorage {
  readonly root: string
  private copying = 0
  private queue: Array<() => void> = []
  constructor(hostRoot: string) { this.root = join(hostRoot, 'outputs', 'v1'); this.cleanExports() }
  /** 外部应用可能仍持有文件；删不掉时保留诊断并留待下次启动，不碰任何原文件。 */
  cleanExports(): void {
    const dir = join(this.root, 'exports')
    let entries: string[]
    try { entries = readdirSync(dir) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`[outputs] 临时导出目录不可读: ${error instanceof Error ? error.message : String(error)}\n`)
      return
    }
    for (const entry of entries) {
      try { id.parse(entry); rmSync(this.managed(join(dir, entry)), { recursive: true, force: true }) }
      catch (error) { process.stderr.write(`[outputs] 临时导出清理失败: ${error instanceof Error ? error.message : String(error)}\n`) }
    }
  }
  sessionPath(sessionId: string) { return join(this.root, 'sessions', id.parse(sessionId)) }
  turnPath(sessionId: string, turnId: string) { return join(this.sessionPath(sessionId), 'turns', id.parse(turnId)) }
  managed(path: string): string {
    const target = resolve(this.root, path)
    const inside = relative(resolve(this.root), target)
    if (inside === '' || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) throw new Error('产物存储路径越界')
    return target
  }
  async load(sessionId: string, turnId: string): Promise<TurnOutputs | undefined> {
    let raw: string
    try { raw = await readFile(join(this.turnPath(sessionId, turnId), 'manifest.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    const doc = manifestSchema.parse(JSON.parse(raw))
    if (doc.sessionId !== sessionId || doc.turnId !== turnId) throw new Error('产物 manifest 归属损坏')
    for (const item of [...doc.active, ...doc.published]) {
      if (basename(item.name) !== item.name || !isAbsolute(item.sourcePath) || !isAbsolute(item.realPath)) throw new Error('产物文件路径损坏')
      if (item.copy.status === 'saved') {
        const target = this.managed(item.copy.relativePath)
        const parent = relative(this.turnPath(sessionId, turnId), target)
        const parts = parent.split(sep)
        if (parts.length !== 4 || parts[0] !== 'copies' || !id.safeParse(parts[1]).success || parts[2] !== item.outputId || parts[3] !== item.name || item.size > OUTPUT_LIMITS.file) throw new Error('产物副本不属于该回合或存储结构损坏')
      }
    }
    return doc
  }
  async list(sessionId: string): Promise<TurnOutputs[]> {
    let dirs: string[]
    try { dirs = await readdir(join(this.sessionPath(sessionId), 'turns')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: TurnOutputs[] = []
    for (const turn of dirs) { const doc = await this.load(sessionId, turn); if (doc !== undefined) result.push(doc) }
    return result
  }
  async commit(doc: TurnOutputs, signal: AbortSignal): Promise<void> {
    const dir = this.turnPath(doc.sessionId, doc.turnId)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `manifest-${randomUUID()}.tmp`)
    try {
      signal.throwIfAborted()
      await writeFile(tmp, JSON.stringify(doc), { signal })
      signal.throwIfAborted()
      await rename(tmp, join(dir, 'manifest.json'))
    } finally { await rm(tmp, { force: true }) }
  }
  async inspect(sourcePath: string, expectedReal?: string) {
    const real = await realpath(sourcePath)
    if (expectedReal !== undefined && real !== expectedReal) throw new Error('符号链接目标已变化')
    const file = await open(real, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new Error('只接受可读普通文件，目录请先打包')
      // 零长度读取也能在申报时确认访问权；超预算只免复制，不免可读校验。
      await file.read(Buffer.alloc(1), 0, 1, 0)
      return { real, size: info.size }
    } finally { await file.close() }
  }
  async capture(sessionId: string, turnId: string, sourcePath: string, outputId: string,
    note: string | undefined, remaining: number, signal: AbortSignal, expectedReal?: string): Promise<OutputItem> {
    if (this.copying >= 2) await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve() }
      const abort = () => { const index = this.queue.indexOf(ready); if (index >= 0) this.queue.splice(index, 1); signal.removeEventListener('abort', abort); reject(new Error('产物复制已取消', { cause: signal.reason })) }
      this.queue.push(ready)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    else this.copying++
    try { signal.throwIfAborted(); return await this.captureFile(sessionId, turnId, sourcePath, outputId, note, remaining, signal, expectedReal) }
    finally { const next = this.queue.shift(); if (next === undefined) this.copying--; else next() }
  }
  private async captureFile(sessionId: string, turnId: string, sourcePath: string, outputId: string,
    note: string | undefined, remaining: number, signal: AbortSignal, expectedReal?: string): Promise<OutputItem> {
    const checked = await this.inspect(sourcePath, expectedReal)
    const base = { outputId, sourcePath, realPath: checked.real, name: basename(sourcePath), size: checked.size, confirmedAt: Date.now(), ...(note !== undefined && { note }) }
    if (checked.size > OUTPUT_LIMITS.file || checked.size > remaining) return { ...base, copy: { status: 'source-only', reason: '超过交付副本容量预算，仅保留当前原文件' } }
    // 每次捕获都有独立目录，不原地覆盖任何已经被 manifest 或预览引用的字节。
    const dir = join(this.turnPath(sessionId, turnId), 'copies', randomUUID(), outputId)
    const target = join(dir, base.name)
    await mkdir(dir, { recursive: true })
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const file = await open(checked.real, 'r')
        try {
          const dest = await open(target, 'w')
          try {
          const before = await file.stat()
          if (!before.isFile() || before.size > Math.min(remaining, OUTPUT_LIMITS.file)) throw new Error('复制前文件已变化或超出预算，请重新申报')
          const hash = createHash('sha256')
          const buffer = Buffer.alloc(256 * 1024)
          let offset = 0
          while (offset < before.size) {
            signal.throwIfAborted()
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
            if (bytesRead === 0) break
            const block = buffer.subarray(0, bytesRead)
            hash.update(block)
            let written = 0
            while (written < block.length) {
              signal.throwIfAborted()
              const part = await dest.write(block, written, block.length - written)
              if (part.bytesWritten === 0) throw new Error('写入交付副本未取得进展')
              written += part.bytesWritten
            }
            offset += bytesRead
          }
          signal.throwIfAborted()
          if (await realpath(sourcePath) !== checked.real) throw new Error('复制期间符号链接目标已变化')
          if (offset !== before.size || signature(before) !== signature(await file.stat()) || signature(before) !== signature(await stat(checked.real))) {
            if (attempt === 0) continue
            throw new Error('文件持续变化，无法确认交付版本')
          }
          await dest.sync()
          return { ...base, size: offset, confirmedAt: Date.now(), copy: { status: 'saved', relativePath: relative(this.root, target), sha256: hash.digest('hex') } }
          } finally { await dest.close() }
        } finally { await file.close() }
      }
      throw new Error('无法确认交付文件')
    } catch (error) { await rm(this.managed(dir), { recursive: true, force: true }); throw error }
  }
  async verify(item: OutputItem): Promise<string> {
    if (item.copy.status !== 'saved') throw new Error('该产物未保存交付副本')
    const target = this.managed(item.copy.relativePath)
    const managedRoot = await realpath(this.root)
    if (await realpath(target) !== join(managedRoot, relative(this.root, target))) throw new Error('产物副本路径被替换')
    const file = await open(target, 'r')
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size !== item.size) throw new Error('产物副本大小损坏')
      const hash = createHash('sha256')
      for await (const block of file.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) hash.update(block)
      if (hash.digest('hex') !== item.copy.sha256 || signature(before) !== signature(await file.stat())) throw new Error('产物副本校验失败，不能冒充交付版本')
      return target
    } finally { await file.close() }
  }
  async export(item: OutputItem & { copy: Extract<OutputItem['copy'], { status: 'saved' }> }): Promise<string> {
    const source = await this.verify(item)
    const dir = join(this.root, 'exports', randomUUID())
    await mkdir(dir, { recursive: true })
    const path = join(dir, item.name)
    await copyFile(source, path)
    await this.verify({ ...item, copy: { ...item.copy, relativePath: relative(this.root, path) } })
    return path
  }
  async removeSession(sessionId: string) { await rm(this.managed(this.sessionPath(sessionId)), { recursive: true, force: true }) }
  async collect(sessionId: string, retained: Set<string>, active: (turnId: string) => boolean): Promise<void> {
    let turns: string[]
    try { turns = await readdir(join(this.sessionPath(sessionId), 'turns')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const turnId of turns) {
      if (active(turnId)) continue
      const dir = join(this.turnPath(sessionId, turnId), 'copies')
      let batches: string[]
      try { batches = await readdir(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      for (const batch of batches) {
        id.parse(batch)
        const batchDir = join(dir, batch)
        const prefix = relative(this.root, batchDir) + sep
        if (!active(turnId) && ![...retained].some((path) => path.startsWith(prefix))) await rm(this.managed(batchDir), { recursive: true, force: true })
      }
    }
  }
  async removeCopies(items: OutputItem[]) {
    for (const item of items) if (item.copy.status === 'saved') await rm(this.managed(dirname(this.managed(item.copy.relativePath))), { recursive: true, force: true })
  }
}
