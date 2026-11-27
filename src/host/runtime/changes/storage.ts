/** 本轮改动列表受管存储：按会话分域保存 CAS 原始字节与回合 manifest，受限并发与原子提交。 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  CHANGE_LIMITS,
  canonicalPath,
  type SnapshotSide,
  type StatCacheEntry,
  type TurnChangesDocument
} from './types'

const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/)

const sideSchema: z.ZodType<SnapshotSide> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }),
  z.object({
    kind: z.literal('file'),
    sha256: shaSchema.optional(),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    saved: z.boolean(),
    oversized: z.boolean().optional(),
    unreadable: z.string().optional()
  }),
  z.object({ kind: z.literal('symlink'), target: z.string(), mode: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('unknown'), reason: z.string().min(1) })
])

const itemSchema = z.object({
  changeId: z.string().min(1),
  path: z.string().min(1),
  absolutePath: z.string().min(1),
  oldPath: z.string().optional(),
  oldAbsolutePath: z.string().optional(),
  kind: z.enum(['added', 'modified', 'deleted', 'renamed', 'type-changed', 'mode-changed', 'eol-or-encoding']),
  added: z.number().int().nonnegative().nullable(),
  deleted: z.number().int().nonnegative().nullable(),
  binary: z.boolean().optional(),
  oversized: z.boolean().optional(),
  outsideWorkspace: z.boolean().optional(),
  source: z.enum(['workspace', 'tool', 'merged']),
  reason: z.string().optional()
})

const documentSchema = z.object({
  summary: z.object({
    version: z.literal(1),
    sessionId: safeId,
    turnId: safeId,
    revision: z.number().int().positive(),
    state: z.enum(['running', 'finalizing', 'ready', 'interrupted']),
    coverage: z.enum(['complete', 'tools-only', 'partial']),
    totalAdded: z.number().int().nonnegative(),
    totalDeleted: z.number().int().nonnegative(),
    incompleteCount: z.number().int().nonnegative(),
    items: z.array(itemSchema),
    warnings: z.array(z.string()),
    outcome: z.enum(['completed', 'aborted', 'error']).optional()
  }),
  entries: z.array(z.object({ item: itemSchema, before: sideSchema, after: sideSchema })),
  baseline: z.object({
    entries: z.array(z.object({
      canonical: z.string(),
      absolutePath: z.string(),
      side: sideSchema,
      source: z.enum(['workspace', 'tool'])
    })),
    coverage: z.enum(['complete', 'tools-only', 'partial']),
    warnings: z.array(z.string())
  }).optional()
})

const sameStat = (
  a: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  b: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
): boolean =>
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  (a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0 || b.dev === 0)))

const INLINE_HASH_BYTES = 1024 * 1024

export class ChangeStorage {
  readonly root: string
  private activeIo = 0
  private waiters: Array<() => void> = []
  private ensuredDirs = new Map<string, Set<string>>()

  constructor(hostRoot: string) {
    this.root = join(hostRoot, 'changes', 'v1')
  }

  sessionPath(sessionId: string): string {
    return join(this.root, 'sessions', safeId.parse(sessionId))
  }

  turnPath(sessionId: string, turnId: string): string {
    return join(this.sessionPath(sessionId), 'turns', safeId.parse(turnId))
  }

  blobsDir(sessionId: string): string {
    return join(this.sessionPath(sessionId), 'blobs')
  }

  blobPath(sessionId: string, sha256: string): string {
    const hash = shaSchema.parse(sha256)
    return this.managed(join(this.blobsDir(sessionId), hash.slice(0, 2), hash))
  }

  managed(targetPath: string): string {
    const target = resolve(this.root, targetPath)
    const rel = relative(resolve(this.root), target)
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw new Error('改动存储路径越界')
    }
    return target
  }

  private async withSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (this.activeIo >= CHANGE_LIMITS.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        const abort = () => {
          const idx = this.waiters.indexOf(ready)
          if (idx >= 0) this.waiters.splice(idx, 1)
          signal.removeEventListener('abort', abort)
          reject(new Error('改动捕获已取消', { cause: signal.reason }))
        }
        this.waiters.push(ready)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    } else {
      this.activeIo++
    }
    try {
      signal.throwIfAborted()
      return await work()
    } finally {
      const next = this.waiters.shift()
      if (next === undefined) this.activeIo--
      else next()
    }
  }

  /** 捕获单路径快照：不跟随符号链接；普通文件按预算存进会话 CAS 并核对读写稳定性。 */
  async captureSide(
    sessionId: string,
    targetPath: string,
    remainingBudget: number,
    signal: AbortSignal,
    statCache?: Map<string, StatCacheEntry>
  ): Promise<{ side: SnapshotSide; bytesWritten: number }> {
    signal.throwIfAborted()
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(targetPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { side: { kind: 'absent' }, bytesWritten: 0 }
      return {
        side: { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) },
        bytesWritten: 0
      }
    }
    if (info.isSymbolicLink()) {
      try {
        const target = await readlink(targetPath)
        return { side: { kind: 'symlink', target, mode: info.mode }, bytesWritten: 0 }
      } catch (error) {
        return {
          side: { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) },
          bytesWritten: 0
        }
      }
    }
    if (!info.isFile()) {
      return { side: { kind: 'unknown', reason: '非普通文件' }, bytesWritten: 0 }
    }
    if (info.size > CHANGE_LIMITS.maxHashBytes) {
      return {
        side: { kind: 'file', size: info.size, mode: info.mode, saved: false, oversized: true },
        bytesWritten: 0
      }
    }

    const saveAllowed = info.size <= CHANGE_LIMITS.maxFileBytes && info.size <= remainingBudget
    const cacheKey = canonicalPath(targetPath)
    const cached = statCache?.get(cacheKey)
    if (cached !== undefined && sameStat(cached, info)) {
      if (!saveAllowed) {
        return {
          side: { kind: 'file', sha256: cached.sha256, size: info.size, mode: info.mode, saved: false, oversized: true },
          bytesWritten: 0
        }
      }
      try {
        const existing = await stat(this.blobPath(sessionId, cached.sha256))
        if (existing.isFile() && existing.size === info.size) {
          return {
            side: { kind: 'file', sha256: cached.sha256, size: info.size, mode: info.mode, saved: true },
            bytesWritten: 0
          }
        }
      } catch {
        // 缓存 blob 已被清理，正常走下方读取重建。
      }
    }

    return this.withSlot(signal, () => this.captureFile(sessionId, targetPath, remainingBudget, signal, statCache))
  }

  private async ensureDir(sessionId: string, dirPath: string): Promise<void> {
    let dirs = this.ensuredDirs.get(sessionId)
    if (dirs === undefined) {
      dirs = new Set()
      this.ensuredDirs.set(sessionId, dirs)
    }
    if (dirs.has(dirPath)) return
    await mkdir(dirPath, { recursive: true })
    dirs.add(dirPath)
  }

  private async captureFile(
    sessionId: string,
    targetPath: string,
    remainingBudget: number,
    signal: AbortSignal,
    statCache?: Map<string, StatCacheEntry>
  ): Promise<{ side: SnapshotSide; bytesWritten: number }> {
    const tmpDir = join(this.sessionPath(sessionId), 'tmp')
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted()
      let handle: Awaited<ReturnType<typeof open>>
      try {
        handle = await open(targetPath, 'r')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return { side: { kind: 'absent' }, bytesWritten: 0 }
        return {
          side: {
            kind: 'file',
            size: 0,
            mode: 0,
            saved: false,
            unreadable: error instanceof Error ? error.message : String(error)
          },
          bytesWritten: 0
        }
      }

      let tmpFile: string | undefined
      try {
        const before = await handle.stat()
        if (!before.isFile()) return { side: { kind: 'unknown', reason: '非普通文件' }, bytesWritten: 0 }
        if (before.size > CHANGE_LIMITS.maxHashBytes) {
          return {
            side: { kind: 'file', size: before.size, mode: before.mode, saved: false, oversized: true },
            bytesWritten: 0
          }
        }
        const saveBlob = before.size <= CHANGE_LIMITS.maxFileBytes && before.size <= remainingBudget
        let offset = 0
        let sha256: string
        let bytesWritten = 0

        if (before.size <= INLINE_HASH_BYTES) {
          const buf = Buffer.allocUnsafe(before.size)
          while (offset < before.size) {
            signal.throwIfAborted()
            const { bytesRead } = await handle.read(buf, offset, before.size - offset, offset)
            if (bytesRead === 0) break
            offset += bytesRead
          }
          signal.throwIfAborted()
          const afterHandle = await handle.stat()
          const afterLink = await lstat(targetPath)
          if (offset !== before.size || !sameStat(before, afterHandle) || !sameStat(before, afterLink)) {
            if (attempt === 0) continue
            return { side: { kind: 'unknown', reason: '文件在快照期间持续变化' }, bytesWritten: 0 }
          }
          sha256 = createHash('sha256').update(buf).digest('hex')
          if (saveBlob) {
            const destPath = this.blobPath(sessionId, sha256)
            if (!existsSync(destPath)) {
              const prefixDir = join(this.blobsDir(sessionId), sha256.slice(0, 2))
              await Promise.all([this.ensureDir(sessionId, tmpDir), this.ensureDir(sessionId, prefixDir)])
              signal.throwIfAborted()
              tmpFile = join(tmpDir, `${randomUUID()}.tmp`)
              await writeFile(tmpFile, buf)
              signal.throwIfAborted()
              try {
                await rename(tmpFile, destPath)
                bytesWritten = offset
              } catch {
                if (existsSync(destPath)) await rm(tmpFile, { force: true }).catch(() => {})
                else throw new Error('提交快照对象失败')
              }
              tmpFile = undefined
            }
          }
        } else {
          const hash = createHash('sha256')
          let dest: Awaited<ReturnType<typeof open>> | undefined
          if (saveBlob) {
            await this.ensureDir(sessionId, tmpDir)
            tmpFile = join(tmpDir, `${randomUUID()}.tmp`)
            dest = await open(tmpFile, 'w')
          }
          try {
            const buffer = Buffer.allocUnsafe(256 * 1024)
            while (offset < before.size) {
              signal.throwIfAborted()
              const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
              if (bytesRead === 0) break
              const block = buffer.subarray(0, bytesRead)
              hash.update(block)
              if (dest !== undefined) {
                let written = 0
                while (written < block.length) {
                  signal.throwIfAborted()
                  const part = await dest.write(block, written, block.length - written)
                  if (part.bytesWritten === 0) throw new Error('写入快照对象未取得进展')
                  written += part.bytesWritten
                }
              }
              offset += bytesRead
            }
            signal.throwIfAborted()
            const afterHandle = await handle.stat()
            const afterLink = await lstat(targetPath)
            if (offset !== before.size || !sameStat(before, afterHandle) || !sameStat(before, afterLink)) {
              if (dest !== undefined) await dest.close().catch(() => {})
              dest = undefined
              if (tmpFile !== undefined) await rm(tmpFile, { force: true }).catch(() => {})
              tmpFile = undefined
              if (attempt === 0) continue
              return { side: { kind: 'unknown', reason: '文件在快照期间持续变化' }, bytesWritten: 0 }
            }
          } finally {
            if (dest !== undefined) await dest.close().catch(() => {})
          }

          sha256 = hash.digest('hex')
          if (saveBlob && tmpFile !== undefined) {
            const destPath = this.blobPath(sessionId, sha256)
            if (existsSync(destPath)) {
              await rm(tmpFile, { force: true }).catch(() => {})
            } else {
              await this.ensureDir(sessionId, join(this.blobsDir(sessionId), sha256.slice(0, 2)))
              try {
                await rename(tmpFile, destPath)
                bytesWritten = offset
              } catch {
                if (existsSync(destPath)) await rm(tmpFile, { force: true }).catch(() => {})
                else throw new Error('提交快照对象失败')
              }
            }
            tmpFile = undefined
          }
        }
        statCache?.set(canonicalPath(targetPath), {
          dev: before.dev,
          ino: before.ino,
          size: offset,
          mtimeMs: before.mtimeMs,
          ctimeMs: before.ctimeMs,
          sha256
        })
        return {
          side: {
            kind: 'file',
            sha256,
            size: offset,
            mode: before.mode,
            saved: saveBlob,
            ...(!saveBlob && { oversized: true })
          },
          bytesWritten
        }
      } catch (error) {
        if (tmpFile !== undefined) await rm(tmpFile, { force: true }).catch(() => {})
        if (signal.aborted) throw error
        return {
          side: {
            kind: 'file',
            size: 0,
            mode: 0,
            saved: false,
            unreadable: error instanceof Error ? error.message : String(error)
          },
          bytesWritten: 0
        }
      } finally {
        await handle.close().catch(() => {})
      }
    }
    return { side: { kind: 'unknown', reason: '无法确认文件快照' }, bytesWritten: 0 }
  }

  async readBlob(sessionId: string, sha256: string, expectedSize: number, signal: AbortSignal): Promise<Buffer> {
    const target = this.blobPath(sessionId, sha256)
    const rootReal = await realpath(this.root)
    if (await realpath(target) !== join(rootReal, relative(this.root, target))) {
      throw new Error('快照对象路径被替换')
    }
    const buf = await readFile(target, { signal })
    if (buf.length !== expectedSize) throw new Error('快照对象大小损坏')
    const actual = createHash('sha256').update(buf).digest('hex')
    if (actual !== sha256) throw new Error('快照对象校验失败')
    return buf
  }

  async load(sessionId: string, turnId: string): Promise<TurnChangesDocument | undefined> {
    let raw: string
    try {
      raw = await readFile(join(this.turnPath(sessionId, turnId), 'manifest.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const doc = documentSchema.parse(JSON.parse(raw))
    if (doc.summary.sessionId !== sessionId || doc.summary.turnId !== turnId) {
      throw new Error('改动 manifest 归属损坏')
    }
    return doc
  }

  async list(sessionId: string): Promise<TurnChangesDocument[]> {
    let dirs: string[]
    try {
      dirs = await readdir(join(this.sessionPath(sessionId), 'turns'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const result: TurnChangesDocument[] = []
    for (const turnId of dirs) {
      const doc = await this.load(sessionId, turnId)
      if (doc !== undefined) result.push(doc)
    }
    return result
  }

  async commit(doc: TurnChangesDocument, signal: AbortSignal): Promise<void> {
    const dir = this.turnPath(doc.summary.sessionId, doc.summary.turnId)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `manifest-${randomUUID()}.tmp`)
    try {
      signal.throwIfAborted()
      const handle = await open(tmp, 'w')
      try {
        await handle.writeFile(JSON.stringify(doc))
        await handle.sync()
      } finally {
        await handle.close()
      }
      signal.throwIfAborted()
      await rename(tmp, join(dir, 'manifest.json'))
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  async sessionBlobBytes(sessionId: string): Promise<number> {
    let prefixes: string[]
    try {
      prefixes = await readdir(this.blobsDir(sessionId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let total = 0
    for (const prefix of prefixes) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue
      const dir = join(this.blobsDir(sessionId), prefix)
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      for (const file of files) {
        try {
          const info = await stat(join(dir, file))
          if (info.isFile()) total += info.size
        } catch {
          // 并发删除跳过
        }
      }
    }
    return total
  }

  async collectBlobs(sessionId: string, retainedSha256s: Set<string>): Promise<void> {
    const blobsDir = this.blobsDir(sessionId)
    let prefixes: string[]
    try {
      prefixes = await readdir(blobsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const prefix of prefixes) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue
      const dir = join(blobsDir, prefix)
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      let remaining = 0
      for (const file of files) {
        if (retainedSha256s.has(file)) {
          remaining++
          continue
        }
        await rm(this.managed(join(dir, file)), { force: true }).catch(() => {})
      }
      if (remaining === 0) await rm(this.managed(dir), { recursive: true, force: true }).catch(() => {})
    }
    await rm(this.managed(join(this.sessionPath(sessionId), 'tmp')), { recursive: true, force: true }).catch(() => {})
    this.ensuredDirs.delete(sessionId)
  }

  async removeSession(sessionId: string): Promise<void> {
    this.ensuredDirs.delete(sessionId)
    await rm(this.managed(this.sessionPath(sessionId)), { recursive: true, force: true })
  }
}
