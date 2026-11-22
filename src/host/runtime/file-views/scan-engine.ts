/** 目录/搜索的有界状态机；生产在单 worker 内排序，不占用 Host 主线程。 */
import { randomUUID } from 'node:crypto'
import { opendir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dir } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ignore from 'ignore'
import type { FileViewDirectory, FileViewEntry, FileViewRoot, FileViewSearch } from '../../../shared/file-views'

export interface ScanRoot extends FileViewRoot { realPath: string }
export type ScanRequest =
  | { kind: 'list'; contextId: string; roots: ScanRoot[]; directoryId: string; cursor?: string; limit: number; refresh?: boolean; operationId: string }
  | { kind: 'search'; contextId: string; roots: ScanRoot[]; query: string; includeIgnored: boolean; cursor?: string; limit: number; operationId: string }
  | { kind: 'close'; contextId: string }
  | { kind: 'cancel'; contextId: string; operationId: string }
export function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
}
export function entryId(rootId: string, path: string): string { return rootId + ':' + Buffer.from(path).toString('base64url') }
export function pathFor(roots: ScanRoot[], id: string): { root: ScanRoot; path: string } {
  const root = roots.find((candidate) => candidate.id === id || id.startsWith(candidate.id + ':'))
  if (root === undefined) throw new Error('目录不属于此上下文')
  const suffix = id === root.id ? '' : Buffer.from(id.slice(root.id.length + 1), 'base64url').toString('utf8')
  const path = resolve(root.path, suffix)
  if (!within(root.path, path)) throw new Error('目录路径越界')
  return { root, path }
}
export async function checkedPath(root: ScanRoot, path: string): Promise<string> {
  if (!within(root.path, path) || await realpath(root.path) !== root.realPath) throw new Error('授权根已变化，请重新选择')
  const actual = await realpath(path)
  if (!within(root.realPath, actual)) throw new Error('符号链接超出授权根')
  return actual
}
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const sortEntries = (a: FileViewEntry, b: FileViewEntry) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const identity = async (path: string) => { const info = await stat(path); return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}` }
interface Snapshot { id: string; contextId: string; directoryId: string; path: string; root: ScanRoot; identity: string; entries: FileViewEntry[]; bytes: number; truncated: boolean; generation: number; touched: number }
type Rules = Array<{ base: string; matcher: ReturnType<typeof ignore> }>
interface PendingDirectory { root: ScanRoot; path: string; rules: Rules }
interface SearchState { id: string; contextId: string; query: string; includeIgnored: boolean; operationId: string; limit: number; stack: PendingDirectory[]; current?: { node: PendingDirectory; dir: Dir; rules: Rules }; visited: Set<string>; scanned: number; nextPage: number; generation: number; warnings: string[]; touched: number; pages: Map<number, FileViewSearch>; bytes: number }
export class FileScanEngine {
  private snapshots = new Map<string, Snapshot>()
  private searches = new Map<string, SearchState>()
  private generation = 0
  private async entry(root: ScanRoot, path: string, directory: boolean, symlink: boolean): Promise<FileViewEntry> {
    let blockedReason: string | undefined
    if (symlink) {
      try { directory = (await stat(await checkedPath(root, path))).isDirectory() }
      catch (error) { blockedReason = error instanceof Error ? error.message : String(error) }
    }
    const part = relative(root.path, path)
    return { id: entryId(root.id, part), rootId: root.id, path, relativePath: part.split(sep).join('/'), name: basename(path), kind: directory ? 'directory' : 'file', symlink, ...(blockedReason === undefined ? {} : { blockedReason }) }
  }
  private async prune(): Promise<void> {
    const deadline = Date.now() - 120_000
    for (const [id, value] of this.snapshots) if (value.touched < deadline) this.snapshots.delete(id)
    for (const [id, value] of this.searches) if (value.touched < deadline) { this.searches.delete(id); await value.current?.dir.close() }
    let bytes = [...this.snapshots.values()].reduce((total, value) => total + value.bytes, 0)
    for (const [id, value] of this.snapshots) {
      if (this.snapshots.size <= 32 && bytes <= 32 * 1024 ** 2) break
      this.snapshots.delete(id); bytes -= value.bytes
    }
    let searchBytes = [...this.searches.values()].reduce((total, value) => total + value.bytes, 0)
    for (const [id, value] of this.searches) {
      if (this.searches.size <= 8 && searchBytes <= 32 * 1024 ** 2) break
      this.searches.delete(id); searchBytes -= value.bytes; await value.current?.dir.close()
    }
  }
  async close(contextId: string): Promise<void> {
    for (const [id, value] of this.snapshots) if (value.contextId === contextId) this.snapshots.delete(id)
    for (const [id, value] of this.searches) if (value.contextId === contextId) { this.searches.delete(id); await value.current?.dir.close() }
  }
  async run(request: ScanRequest, signal = new AbortController().signal): Promise<FileViewDirectory | FileViewSearch | { ok: true }> {
    signal.throwIfAborted(); await this.prune()
    if (request.kind === 'close') { await this.close(request.contextId); return { ok: true } }
    if (request.kind === 'cancel') { for (const [id, state] of this.searches) if (state.contextId === request.contextId && state.operationId === request.operationId) { this.searches.delete(id); await state.current?.dir.close() } return { ok: true } }
    return request.kind === 'list' ? this.list(request, signal) : this.search(request, signal)
  }
  private async list(request: Extract<ScanRequest, { kind: 'list' }>, signal: AbortSignal): Promise<FileViewDirectory> {
    let snapshot: Snapshot
    let offset = 0
    if (request.cursor !== undefined) {
      const [id, value] = request.cursor.split(':')
      const found = this.snapshots.get(id)
      if (found === undefined || found.contextId !== request.contextId || found.directoryId !== request.directoryId || !/^\d+$/.test(value)) throw new Error('目录游标已失效，请刷新')
      snapshot = found; offset = Number(value)
      if (offset > snapshot.entries.length || await identity(await checkedPath(snapshot.root, snapshot.path)) !== snapshot.identity) throw new Error('目录已变化，请刷新')
    } else {
      const { root, path } = pathFor(request.roots, request.directoryId)
      await checkedPath(root, path)
      const before = await identity(path)
      const dir = await opendir(path)
      const entries: FileViewEntry[] = []
      let bytes = 0; let truncated = false
      try {
        for (;;) {
          signal.throwIfAborted()
          const item = await dir.read()
          if (item === null) break
          bytes += Buffer.byteLength(item.name) * 2 + 256
          if (entries.length >= 100_000 || bytes > 16 * 1024 ** 2) { truncated = true; break }
          entries.push(await this.entry(root, join(path, item.name), item.isDirectory(), item.isSymbolicLink()))
        }
      } finally { await dir.close() }
      signal.throwIfAborted()
      if (await identity(await checkedPath(root, path)) !== before) throw new Error('目录在枚举期间发生变化，请刷新')
      entries.sort(sortEntries)
      for (const [id, old] of this.snapshots) if (old.contextId === request.contextId && old.directoryId === request.directoryId) this.snapshots.delete(id)
      snapshot = { id: randomUUID(), contextId: request.contextId, directoryId: request.directoryId, root, path, identity: before, entries, bytes, truncated, generation: ++this.generation, touched: Date.now() }
      this.snapshots.set(snapshot.id, snapshot); await this.prune()
    }
    snapshot.touched = Date.now()
    const entries = snapshot.entries.slice(offset, offset + request.limit)
    const next = offset + entries.length
    return { entries, generation: snapshot.generation, complete: next >= snapshot.entries.length && !snapshot.truncated, truncated: snapshot.truncated, ...(next < snapshot.entries.length ? { nextCursor: `${snapshot.id}:${next}` } : {}), ...(snapshot.truncated ? { warning: '目录超过 100,000 项或 16 MiB 名称预算；当前列表不完整，可使用文件名搜索' } : {}) }
  }
  private async rules(node: PendingDirectory): Promise<Rules> {
    const rules = [...node.rules]
    for (const name of ['.gitignore', '.ignore']) {
      try {
        const path = join(node.path, name)
        await checkedPath(node.root, path)
        if ((await stat(path)).size > 64 * 1024) throw new Error('忽略文件超过 64 KiB')
        rules.push({ base: node.path, matcher: ignore().add(await readFile(path, 'utf8')) })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return rules
  }
  private ignored(rules: Rules, path: string, directory: boolean): boolean {
    let ignored = false
    for (const rule of rules) {
      const part = relative(rule.base, path).split(sep).join('/') + (directory ? '/' : '')
      if (part === '' || part.startsWith('../')) continue
      const result = rule.matcher.test(part)
      if (result.ignored) ignored = true
      else if (result.unignored) ignored = false
    }
    return ignored
  }
  private async search(request: Extract<ScanRequest, { kind: 'search' }>, signal: AbortSignal): Promise<FileViewSearch> {
    let state: SearchState; let page = 0
    if (request.cursor !== undefined) {
      const [id, value] = request.cursor.split(':'); page = Number(value)
      const found = this.searches.get(id)
      if (found === undefined || found.contextId !== request.contextId || found.query !== request.query || found.includeIgnored !== request.includeIgnored || found.limit !== request.limit || !Number.isSafeInteger(page) || page < 0 || page > found.nextPage) throw new Error('搜索游标已失效，请重新搜索')
      state = found
      state.touched = Date.now()
      const saved = state.pages.get(page)
      if (saved !== undefined) return saved
    } else {
      state = { id: randomUUID(), contextId: request.contextId, query: request.query, includeIgnored: request.includeIgnored, operationId: request.operationId, limit: request.limit, stack: request.roots.filter((root) => root.kind === 'directory').map((root) => ({ root, path: root.path, rules: [] })), visited: new Set(), scanned: 0, nextPage: 0, generation: ++this.generation, warnings: [], touched: Date.now(), pages: new Map(), bytes: 0 }
      this.searches.set(state.id, state); await this.prune()
    }
    const entries: FileViewEntry[] = []
    const query = request.query.toLocaleLowerCase()
    const started = Date.now(); const initialScanned = state.scanned
    let paused = false
    try {
      while (entries.length < request.limit) {
        signal.throwIfAborted()
        if (state.scanned - initialScanned >= 100_000 || Date.now() - started >= 5_000) { paused = true; break }
        if (state.current === undefined) {
          const node = state.stack.pop()
          if (node === undefined) break
          try {
            const real = await checkedPath(node.root, node.path)
            const key = node.root.id + ':' + real
            if (state.visited.has(key)) continue
            if (state.visited.size >= 200_000) throw new Error('搜索目录数超过运行期预算，请缩小范围')
            state.visited.add(key)
            const rules = request.includeIgnored ? [] : await this.rules(node)
            state.current = { node, dir: await opendir(node.path), rules }
          } catch (error) { if (state.warnings.length < 100) state.warnings.push(`${node.path}：${error instanceof Error ? error.message : String(error)}`); continue }
        }
        const current = state.current
        const item = await current.dir.read()
        if (item === null) { await current.dir.close(); state.current = undefined; continue }
        state.scanned++
        const path = join(current.node.path, item.name)
        if (item.name === '.git' || (!request.includeIgnored && this.ignored(current.rules, path, item.isDirectory()))) continue
        const entry = await this.entry(current.node.root, path, item.isDirectory(), item.isSymbolicLink())
        if (entry.kind === 'directory' && entry.blockedReason === undefined && !entry.symlink) state.stack.push({ root: current.node.root, path, rules: current.rules })
        if (entry.relativePath.toLocaleLowerCase().includes(query)) entries.push(entry)
      }
      signal.throwIfAborted()
    } catch (error) { this.searches.delete(state.id); await state.current?.dir.close(); throw error }
    const complete = state.stack.length === 0 && state.current === undefined
    const rank = (entry: FileViewEntry) => entry.name.toLocaleLowerCase() === query ? 0 : entry.name.toLocaleLowerCase().startsWith(query) ? 1 : 2
    entries.sort((a, b) => rank(a) - rank(b) || sortEntries(a, b))
    const result: FileViewSearch = { entries, generation: state.generation, complete, scanned: state.scanned, paused, truncated: false, warnings: [...state.warnings], ...(complete ? {} : { nextCursor: `${state.id}:${page + 1}` }) }
    state.nextPage = page + 1; state.pages.set(page, result); state.bytes += Buffer.byteLength(JSON.stringify(result))
    await this.prune()
    return result
  }
}
