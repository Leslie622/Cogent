/** 桌面文件上下文与显式 lease；没有会话的浏览使用独立 owner，不暗建 Agent 会话。 */
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { FileDescriptor } from '../../../shared/files'
import { toUserFileError } from '../../../shared/file-errors'
import { fileViewPreviewSensitivePath, projectFileRoots, type FileViewContext, type FileViewDirectory, type FileViewHostMethods, type FileViewLease, type FileViewPreviewPolicy, type FileViewRead, type FileViewRoot, type FileViewSearch, type FileViewSource } from '../../../shared/file-views'
import type { FileService } from '../files/reader'
import type { OutputsService } from '../outputs/service'
import { resolveFileTarget } from '../files/paths'
import { checkedPath, pathFor, within, type ScanRoot, type ScanRequest } from './scan-engine'
import { WorkerDirectoryScanner, type DirectoryScanner } from './scanner'

interface Context { id: string; ownerId: string; scopeId: string; windowId: number; epoch: number; roots: ScanRoot[]; closing: boolean; pending: number; leases: number; scans: number; generation: number }
interface Registration { descriptor: FileDescriptor; ownerId: string; references: number }
interface Lease { id: string; windowId: number; epoch: number; source: FileViewSource; registration: Registration; context?: Context; holds: number; released: boolean }
interface Operation { controller: AbortController; users: number; contextId?: string; scan: boolean; owners: Set<string> }
const ok = { ok: true as const }
export class FileViewsService {
  private contexts = new Map<string, Context>()
  private leases = new Map<string, Lease>()
  private operations = new Map<string, Operation>()
  private canceled = new Set<string>()
  private closedWindows = new Set<number>()
  private windowEpochs = new Map<number, number>()
  private deletedSessions = new Set<string>()
  private generation = 0
  private pendingCloses = 0
  private disposed = false
  private watchers = new Map<string, { context: Context; watcher: FSWatcher; timer?: ReturnType<typeof setTimeout> }>()
  constructor(private files: FileService, private outputs: OutputsService, private scanner: DirectoryScanner = new WorkerDirectoryScanner(), private changed?: (value: { contextId: string; directoryId: string; generation: number; error?: string }) => void) {}
  private window(windowId: number, expected?: number): number {
    if (this.disposed || this.closedWindows.has(windowId)) throw new Error('文件窗口已关闭')
    const epoch = this.windowEpochs.get(windowId) ?? 0
    if (expected !== undefined && expected !== epoch) throw new Error('文件页面已重载，旧操作已失效')
    return epoch
  }
  /** main 注入的文档代次；Host 重启后以首个可信请求恢复，renderer 无法自签。 */
  validateWindowEpoch(windowId: number, epoch: number): void {
    this.window(windowId)
    if (!this.windowEpochs.has(windowId)) this.windowEpochs.set(windowId, epoch)
    this.window(windowId, epoch)
  }
  private context(windowId: number, contextId: string, allowClosing = false): Context {
    this.window(windowId)
    const context = this.contexts.get(contextId)
    if (context === undefined || context.windowId !== windowId || context.epoch !== this.window(windowId) || (context.closing && !allowClosing)) throw new Error('文件上下文已失效或不属于当前窗口')
    return context
  }
  async registerContext(windowId: number, scopeId: string, roots: FileViewRoot[]): Promise<FileViewContext> {
    const epoch = this.window(windowId)
    if (this.deletedSessions.has(scopeId)) throw new Error('文件所属会话已删除')
    const checked: ScanRoot[] = []
    for (const root of roots) {
      if (!isAbsolute(root.path)) throw new Error('文件根必须是绝对路径')
      const path = resolve(root.path)
      let realPath: string
      let info: Awaited<ReturnType<typeof stat>>
      try {
        realPath = await realpath(path)
        info = await stat(realPath)
      } catch (error) {
        throw toUserFileError(error, root.kind === 'file' ? 'file' : 'directory')
      }
      if (!info.isDirectory() && !info.isFile()) throw new Error('文件根必须是普通文件或目录')
      checked.push({ ...root, id: randomUUID(), path, name: root.name || basename(path), kind: info.isDirectory() ? 'directory' : 'file', realPath })
    }
    this.window(windowId, epoch)
    if (this.deletedSessions.has(scopeId)) throw new Error('文件所属会话已删除')
    const id = randomUUID(); const ownerId = `desktop:${id}`
    const context: Context = { id, ownerId, scopeId, windowId, epoch, roots: checked, closing: false, pending: 0, leases: 0, scans: 0, generation: ++this.generation }
    this.contexts.set(id, context); this.files.registerDesktopOwner(ownerId, checked.map((root) => root.path))
    return { contextId: id, generation: context.generation, roots: checked.map(({ realPath: _real, ...root }) => root), grantIds: checked.flatMap((root) => root.grantId === undefined ? [] : [root.grantId]), selectedPaths: [], canceled: false }
  }
  private cleanup(context: Context): void {
    if (!context.closing || context.pending > 0 || context.leases > 0 || context.scans > 0) return
    this.contexts.delete(context.id); this.files.releaseDesktopOwner(context.ownerId)
  }
  closeContext(windowId: number, contextId: string): { ok: true } {
    const context = this.context(windowId, contextId, true)
    if (context.closing) return ok
    context.closing = true
    for (const operation of this.operations.values()) if (operation.scan && operation.contextId === contextId) operation.controller.abort()
    for (const [key, entry] of this.watchers) if (entry.context === context) { clearTimeout(entry.timer); entry.watcher.close(); this.watchers.delete(key) }
    this.pendingCloses++
    void this.scanner.run({ kind: 'close', contextId }).catch((error: unknown) => { if (!this.disposed) process.stderr.write(`[fileViews] 清理目录上下文失败：${error instanceof Error ? error.message : String(error)}\n`) }).finally(() => {
      this.pendingCloses--
      // 窗口可同时关闭多个上下文；最后一个清理 ACK 到达后才销毁共享 worker。
      if (!this.disposed && this.pendingCloses === 0 && [...this.contexts.values()].every((value) => value.closing)) this.scanner.dispose()
    })
    this.cleanup(context); return ok
  }
  private lease(windowId: number, leaseId: string): Lease {
    this.window(windowId)
    const lease = this.leases.get(leaseId)
    if (lease === undefined || lease.windowId !== windowId || lease.epoch !== this.window(windowId) || lease.released) throw new Error('文件租约已失效或不属于当前窗口')
    return lease
  }
  private publicLease(lease: Lease): FileViewLease {
    const descriptor = lease.registration.descriptor
    const delivery = descriptor.delivery
    const identity = delivery === undefined ? descriptor.canonicalKey! : JSON.stringify(delivery.target)
    // 原件的读取授权仍归来源；规范资源身份由窗口+真实路径决定，正文/树/草稿提交可汇合。
    const owner = delivery === undefined ? `window:${lease.windowId}` : lease.registration.ownerId
    return { leaseId: lease.id, descriptor, canonicalKey: `${delivery === undefined ? 'current' : 'delivery'}:${owner}:${identity}`, ownerId: lease.registration.ownerId }
  }
  private makeLease(windowId: number, source: FileViewSource, registration: Registration, context?: Context): FileViewLease {
    const lease: Lease = { id: randomUUID(), windowId, epoch: this.window(windowId), source, registration, context, holds: 0, released: false }
    registration.references++; if (context !== undefined) context.leases++
    this.leases.set(lease.id, lease); return this.publicLease(lease)
  }
  private finishLease(lease: Lease): void {
    if (!lease.released || lease.holds !== 0) return
    lease.registration.references--
    if (lease.registration.references === 0) this.files.release({ sessionId: lease.registration.ownerId, fileId: lease.registration.descriptor.fileId })
    if (lease.context !== undefined) { lease.context.leases--; this.cleanup(lease.context) }
  }
  release(windowId: number, leaseId: string): { ok: true } {
    const lease = this.leases.get(leaseId)
    if (lease === undefined) return ok
    if (lease.windowId !== windowId) throw new Error('文件租约不属于当前窗口')
    this.leases.delete(leaseId); lease.released = true; this.finishLease(lease); return ok
  }
  cloneLease(windowId: number, leaseId: string): FileViewLease {
    const lease = this.lease(windowId, leaseId)
    return this.makeLease(windowId, lease.source, lease.registration, lease.context)
  }
  private async operation<T>(windowId: number, operationId: string, context: Context | undefined, scan: boolean, work: (signal: AbortSignal, key: string, owners: Set<string>) => Promise<T>): Promise<T> {
    const epoch = this.window(windowId)
    const key = `fileViews:${windowId}:${epoch}:${operationId}`
    if (this.canceled.has(key)) throw new Error('文件操作已取消')
    let operation = this.operations.get(key)
    if (operation === undefined) { operation = { controller: new AbortController(), users: 0, contextId: context?.id, scan, owners: new Set() }; this.operations.set(key, operation) }
    operation.users++
    try { operation.controller.signal.throwIfAborted(); const result = await work(operation.controller.signal, key, operation.owners); this.window(windowId, epoch); return result }
    finally { operation.users--; if (operation.users === 0 && this.operations.get(key) === operation) this.operations.delete(key) }
  }
  async acquire(windowId: number, source: FileViewSource, operationId: string): Promise<FileViewLease> {
    this.window(windowId)
    let parent: Lease | undefined
    if (source.kind !== 'output' && source.relativeTo !== undefined) { parent = this.lease(windowId, source.relativeTo); parent.holds++ }
    let context: Context | undefined
    let ownerId: string
    try {
      if (source.kind === 'context') { context = this.context(windowId, source.contextId, parent?.context?.id === source.contextId); ownerId = context.ownerId; context.pending++ }
      else ownerId = source.kind === 'session' ? source.sessionId : source.target.sessionId
      if (this.deletedSessions.has(context?.scopeId ?? ownerId)) throw new Error('文件所属会话已删除')
      if (parent !== undefined && parent.registration.ownerId !== ownerId) throw new Error('父文件不属于此来源')
      return await this.operation(windowId, operationId, context, false, async (signal, _key, owners) => {
        owners.add(ownerId)
        let descriptor: FileDescriptor
        if (source.kind === 'output') descriptor = await this.outputs.resolve(source.target, this.files, true)
        else if (source.kind === 'session') descriptor = await this.files.resolve(ownerId, source.rawTarget, source.turnId, parent?.registration.descriptor.fileId, true)
        else {
          const target: { path: string; location?: FileDescriptor['location']; locationWarning?: string } = parent === undefined ? { path: resolve(source.path) } : resolveFileTarget(source.path, { cwd: dirname((await this.files.previewTarget({ sessionId: ownerId, fileId: parent.registration.descriptor.fileId })).path), platform: process.platform }, homedir())
          const root = context!.roots.find((root) => within(root.path, target.path))
          if (root === undefined) throw new Error('文件不在已授权范围，请重新选择')
          const expected = await checkedPath(root, target.path)
          descriptor = await this.files.registerPath(ownerId, target.path, undefined, undefined, target, false, true)
          try {
            if (await checkedPath(root, target.path) !== expected || (await this.files.previewTarget({ sessionId: ownerId, fileId: descriptor.fileId })).path !== expected) throw new Error('文件链接在登记期间发生变化')
          } catch (error) { this.files.release({ sessionId: ownerId, fileId: descriptor.fileId }); throw error }
        }
        if (signal.aborted || this.closedWindows.has(windowId)) { this.files.release({ sessionId: ownerId, fileId: descriptor.fileId }); throw new Error('文件操作已取消') }
        return this.makeLease(windowId, source, { descriptor, ownerId, references: 0 }, context)
      })
    } finally {
      if (context !== undefined) { context.pending--; this.cleanup(context) }
      if (parent !== undefined) { parent.holds--; this.finishLease(parent) }
    }
  }
  private async withRead<T>(windowId: number, read: FileViewRead, work: (value: { sessionId: string; fileId: string; version: string; operationId: string }) => Promise<T>): Promise<T> {
    const lease = this.lease(windowId, read.leaseId); lease.holds++
    try {
      return await this.operation(windowId, read.operationId, lease.context, false, async (signal, operationId, owners) => {
        owners.add(lease.registration.ownerId)
        const result = await work({ sessionId: lease.registration.ownerId, fileId: lease.registration.descriptor.fileId, version: read.version, operationId })
        signal.throwIfAborted(); return result
      })
    } finally { lease.holds--; this.finishLease(lease) }
  }
  readText(windowId: number, value: FileViewRead & { offset?: number }) { return this.withRead(windowId, value, (read) => this.files.readText({ ...read, offset: value.offset })) }
  readChunk(windowId: number, value: FileViewRead & { offset: number; length: number }) { return this.withRead(windowId, value, (read) => this.files.readChunk({ ...read, offset: value.offset, length: value.length })) }
  parseDocument(windowId: number, value: FileViewRead & { cursor: number; sheet?: string; range?: string }) { return this.withRead(windowId, value, (read) => this.files.parseDocument({ ...read, cursor: value.cursor, sheet: value.sheet, range: value.range })) }
  cancel(windowId: number, operationId: string, contextId?: string): { ok: true } {
    if (contextId !== undefined) this.context(windowId, contextId, true)
    const key = `fileViews:${windowId}:${this.window(windowId)}:${operationId}`; const operation = this.operations.get(key)
    if (operation !== undefined && contextId !== undefined && operation.contextId !== contextId) throw new Error('操作不属于此文件上下文')
    operation?.controller.abort(); this.canceled.add(key)
    if (this.canceled.size > 1024) this.canceled.delete(this.canceled.values().next().value!)
    for (const owner of operation?.owners ?? []) this.files.cancel(owner, key)
    if (contextId !== undefined) void this.scanner.run({ kind: 'cancel', contextId, operationId }).catch((error: unknown) => process.stderr.write(`[fileViews] 搜索取消清理失败：${error instanceof Error ? error.message : String(error)}\n`))
    return ok
  }
  async listDirectory(params: FileViewHostMethods['fileViews.listDirectory']['params']): Promise<FileViewDirectory> {
    const context = this.context(params.windowId, params.contextId)
    const result = await this.scan(context, params.operationId, { ...params, kind: 'list', roots: context.roots, limit: params.limit ?? 200 }) as FileViewDirectory
    if (!context.closing) this.watchDirectory(context, params.directoryId)
    return result
  }
  private watchDirectory(context: Context, directoryId: string): void {
    const key = context.id + ':' + directoryId
    if (this.watchers.has(key)) return
    const existing = [...this.watchers].filter(([, value]) => value.context.windowId === context.windowId)
    if (existing.length >= 8) { const [oldKey, old] = existing[0]; clearTimeout(old.timer); old.watcher.close(); this.watchers.delete(oldKey) }
    try {
      const watcher = watch(pathFor(context.roots, directoryId).path, { persistent: false })
      const entry = { context, watcher, timer: undefined as ReturnType<typeof setTimeout> | undefined }
      this.watchers.set(key, entry)
      watcher.on('change', () => { clearTimeout(entry.timer); entry.timer = setTimeout(() => { if (!context.closing) this.changed?.({ contextId: context.id, directoryId, generation: ++this.generation }) }, 75) })
      watcher.once('error', (error) => { clearTimeout(entry.timer); watcher.close(); this.watchers.delete(key); if (!context.closing) this.changed?.({ contextId: context.id, directoryId, generation: ++this.generation, error: error.message }) })
    } catch (error) { this.changed?.({ contextId: context.id, directoryId, generation: ++this.generation, error: error instanceof Error ? error.message : String(error) }) }
  }
  async search(params: FileViewHostMethods['fileViews.search']['params']): Promise<FileViewSearch> {
    const context = this.context(params.windowId, params.contextId)
    return this.scan(context, params.operationId, { ...params, kind: 'search', roots: projectFileRoots(context.roots), includeIgnored: params.includeIgnored ?? false, limit: params.limit ?? 200 }) as Promise<FileViewSearch>
  }
  private async scan(context: Context, operationId: string, request: ScanRequest) {
    context.scans++
    try { return await this.operation(context.windowId, operationId, context, true, async (signal) => { const result = await this.scanner.run(request, signal); signal.throwIfAborted(); return result }) }
    finally { context.scans--; this.cleanup(context) }
  }
  async actionTarget(windowId: number, leaseId: string, current = false) {
    const lease = this.lease(windowId, leaseId); lease.holds++
    try {
      const descriptor = lease.registration.descriptor
      let target: Awaited<ReturnType<FileService['actionTarget']>>
      if (current && descriptor.delivery !== undefined) {
        const temporary = await this.outputs.resolve({ ...descriptor.delivery.target, version: 'current' }, this.files, true)
        try { target = await this.files.actionTarget({ sessionId: lease.registration.ownerId, fileId: temporary.fileId }) }
        finally { this.files.release({ sessionId: lease.registration.ownerId, fileId: temporary.fileId }) }
      } else target = await this.files.actionTarget({ sessionId: lease.registration.ownerId, fileId: descriptor.fileId })
      this.lease(windowId, leaseId)
      return target
    } finally { lease.holds--; this.finishLease(lease) }
  }
  async previewResource(windowId: number, leaseId: string, relativePath: string, policy?: FileViewPreviewPolicy): Promise<FileViewLease> {
    const parent = this.lease(windowId, leaseId); parent.holds++
    try {
      const { ownerId, descriptor } = parent.registration
      if (relativePath === '') {
        if (policy !== undefined && descriptor.delivery === undefined) await this.checkPreviewPath(policy, (await this.files.previewTarget({ sessionId: ownerId, fileId: descriptor.fileId })).path)
        return this.cloneLease(windowId, leaseId)
      }
      let child: FileDescriptor
      if (descriptor.delivery !== undefined) child = await this.files.resolve(ownerId, relativePath, descriptor.delivery.target.turnId, descriptor.fileId, true)
      else {
        const base = dirname((await this.files.previewTarget({ sessionId: ownerId, fileId: descriptor.fileId })).path)
        const target = resolve(policy?.root.realPath ?? base, relativePath)
        const expected = policy === undefined ? await realpath(target).catch((error) => { throw toUserFileError(error, 'file') }) : await this.checkPreviewPath(policy, target)
        if (policy === undefined && (!within(base, target) || !within(base, expected))) throw new Error('网页资源超出 HTML 所在目录')
        child = await this.files.registerPath(ownerId, target, undefined, undefined, {}, false, true)
        try {
          const actual = (await this.files.previewTarget({ sessionId: ownerId, fileId: child.fileId })).path
          if (policy === undefined ? !within(base, actual) : await this.checkPreviewPath(policy, actual) !== expected) throw new Error('网页资源超出授权目录或登记期间发生变化')
        }
        catch (error) { this.files.release({ sessionId: ownerId, fileId: child.fileId }); throw error }
      }
      if (this.disposed || this.closedWindows.has(windowId) || parent.released || parent.epoch !== this.window(windowId) || this.deletedSessions.has(parent.context?.scopeId ?? ownerId)) { this.files.release({ sessionId: ownerId, fileId: child.fileId }); throw new Error('文件来源已关闭或会话已删除') }
      return this.makeLease(windowId, parent.source, { ownerId, descriptor: child, references: 0 }, parent.context)
    } finally { parent.holds--; this.finishLease(parent) }
  }
  private async checkPreviewPath(policy: FileViewPreviewPolicy, target: string): Promise<string> {
    let rootReal: string
    try { rootReal = await realpath(policy.root.path) } catch (error) { throw toUserFileError(error, 'directory') }
    if (rootReal !== policy.root.realPath || !within(policy.root.realPath, target)) throw new Error('网页资源根已变化或路径越界')
    let actual: string
    try { actual = await realpath(target) } catch (error) { throw toUserFileError(error, 'file') }
    if (!within(policy.root.realPath, actual) || policy.blockedRoots.some(root => within(root, actual)) || fileViewPreviewSensitivePath(actual) || fileViewPreviewSensitivePath(target)) throw new Error('网页资源位于受保护目录或敏感文件')
    return actual
  }
  private clearWindow(windowId: number): void {
    for (const [id, lease] of this.leases) if (lease.windowId === windowId) this.release(windowId, id)
    for (const context of [...this.contexts.values()]) if (context.windowId === windowId && !context.closing) this.closeContext(windowId, context.id)
    for (const [key, operation] of this.operations) if (key.startsWith(`fileViews:${windowId}:`)) { operation.controller.abort(); for (const owner of operation.owners) this.files.cancel(owner, key) }
  }
  resetWindow(windowId: number, epoch: number): { ok: true } {
    const current = this.window(windowId)
    if (epoch < current) throw new Error('文件页面已重载，旧操作已失效')
    if (epoch === current) return ok
    this.clearWindow(windowId)
    this.windowEpochs.set(windowId, epoch)
    return ok
  }
  releaseWindow(windowId: number): { ok: true } {
    if (this.closedWindows.has(windowId)) return ok
    this.clearWindow(windowId)
    this.closedWindows.add(windowId)
    return ok
  }
  /** 外部客户端也能删除会话，资源真删除不能依赖某个renderer恰好收到导航事件。 */
  releaseSession(sessionId: string): void {
    this.deletedSessions.add(sessionId)
    for (const [key, operation] of this.operations) {
      const context = operation.contextId === undefined ? undefined : this.contexts.get(operation.contextId)
      if (!operation.owners.has(sessionId) && context?.scopeId !== sessionId) continue
      operation.controller.abort()
      for (const owner of operation.owners) this.files.cancel(owner, key)
    }
    for (const [id, lease] of this.leases) if (lease.registration.ownerId === sessionId || lease.context?.scopeId === sessionId) this.release(lease.windowId, id)
    for (const context of [...this.contexts.values()]) if (context.scopeId === sessionId && !context.closing) this.closeContext(context.windowId, context.id)
  }
  dispose(): void { this.disposed = true; for (const lease of [...this.leases.values()]) this.release(lease.windowId, lease.id); for (const operation of this.operations.values()) operation.controller.abort(); for (const context of this.contexts.values()) this.files.releaseDesktopOwner(context.ownerId); this.contexts.clear(); for (const entry of this.watchers.values()) { clearTimeout(entry.timer); entry.watcher.close() } this.watchers.clear(); this.scanner.dispose() }
}
