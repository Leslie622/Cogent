/** main 是文件选择授权的单写者；renderer 布局只能存 grant ID，不能用路径自签权限。 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '../storage-root'
import type { FileViewRoot } from '../../../shared/file-views'
interface Grant { id: string; path: string; realPath: string; kind: 'file' | 'directory' }
export class FileViewGrants {
  private loaded = false
  private grants = new Map<string, Grant>()
  constructor(private root: string) {}
  private load(): void {
    if (this.loaded) return
    const path = join(this.root, 'file-view-grants.json')
    const next = new Map<string, Grant>()
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (raw === null || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { grants?: unknown }).grants)) throw new Error('文件授权存储损坏，未自动重置')
      for (const value of (raw as { grants: unknown[] }).grants) {
        if (value === null || typeof value !== 'object') throw new Error('文件授权记录损坏')
        const grant = value as Grant
        if (typeof grant.id !== 'string' || grant.id.length === 0 || typeof grant.path !== 'string' || !isAbsolute(grant.path) || typeof grant.realPath !== 'string' || !isAbsolute(grant.realPath) || !['file', 'directory'].includes(grant.kind) || next.has(grant.id)) throw new Error('文件授权记录损坏')
        next.set(grant.id, grant)
      }
    }
    this.grants = next; this.loaded = true
  }
  async add(path: string, assertActive: () => void = () => {}): Promise<string> {
    this.load()
    const full = resolve(path); const realPath = await realpath(full); const info = await stat(realPath)
    assertActive()
    if (!info.isDirectory() && !info.isFile()) throw new Error('只能选择普通文件或目录')
    const existing = [...this.grants.values()].find((grant) => grant.path === full && grant.realPath === realPath)
    if (existing !== undefined) return existing.id
    const grant: Grant = { id: randomUUID(), path: full, realPath, kind: info.isDirectory() ? 'directory' : 'file' }
    const next = new Map(this.grants); next.set(grant.id, grant)
    mkdirSync(this.root, { recursive: true })
    writeFileAtomic(join(this.root, 'file-view-grants.json'), JSON.stringify({ version: 1, grants: [...next.values()] }, null, 2))
    this.grants = next
    return grant.id
  }
  async roots(ids: string[]): Promise<FileViewRoot[]> {
    this.load()
    return Promise.all([...new Set(ids)].map(async (id) => {
      const grant = this.grants.get(id)
      if (grant === undefined) throw new Error('文件授权不存在，请重新选择')
      if (await realpath(grant.path) !== grant.realPath) throw new Error('文件授权目标已变化，请重新选择')
      const info = await stat(grant.realPath)
      if (info.isDirectory() !== (grant.kind === 'directory')) throw new Error('文件授权类型已变化，请重新选择')
      return { id: grant.id, grantId: grant.id, path: grant.path, name: basename(grant.path) || grant.path, kind: grant.kind }
    }))
  }
}
