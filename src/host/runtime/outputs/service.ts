/** 产物事务 owner：execute 暂存，pi 最终工具结果确认后提交；回合终态复核后才发布。 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { posix, win32, dirname, resolve } from 'node:path'
import type { FileContext, FileDescriptor } from '../../../shared/files'
import type { OutputDeclaration, OutputItem, OutputOutcome, OutputTarget, TurnOutputs } from '../../../shared/outputs'
import { OutputStorage, OUTPUT_LIMITS } from './storage'
import type { FileService } from '../files/reader'
import { outputReminderText } from '../prompts/reminders'

type Run = { owner: object; controller: AbortController; wrote: boolean; reminded: boolean; resume: boolean; declared: boolean; phase: 'running' | 'finalizing' | 'ready' }
type Pending = { run: Run; doc: TurnOutputs; old: TurnOutputs | undefined; release: () => void; signal: AbortSignal }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const key = (sessionId: string, turnId: string) => `${sessionId}/${turnId}`
const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path

/** 工具参数是字面路径；%/#/: 都不借 Markdown 链接语法重新解释。 */
export function outputPath(raw: string, context: Pick<FileContext, 'cwd' | 'platform'>): string {
  if (raw.length === 0 || raw.length > 32768 || raw.includes('\0')) throw new Error('产物路径为空、过长或含空字符')
  const api = context.platform === 'win32' ? win32 : posix
  const path = raw === '~' ? homedir() : /^~[\\/]/.test(raw) ? api.join(homedir(), raw.slice(2)) : raw
  if (context.platform === 'win32' ? /^\/(?![\/])/.test(path) : /^[a-z]:[\\/]|^\\/i.test(path)) throw new Error('产物路径属于另一种操作系统')
  return api.resolve(context.cwd, path)
}

export class OutputsService {
  readonly storage: OutputStorage
  private runs = new Map<string, Run>()
  private pending = new Map<string, Pending>()
  private queues = new Map<string, Promise<void>>()
  private cleaning = new Map<string, Promise<void>>()
  private deleted = new Set<string>()
  private lifetimes = new Map<string, AbortController>()
  private deletions = new Map<string, Promise<void>>()
  private pinned = new Map<string, { item: OutputItem; sessionId: string; count: number }>()
  constructor(hostRoot: string, private updated: (doc: TurnOutputs) => void) { this.storage = new OutputStorage(hostRoot) }

  begin(sessionId: string, turnId: string, owner: object, resume = false): void {
    const id = key(sessionId, turnId)
    const run: Run = { owner, controller: new AbortController(), wrote: false, reminded: false, resume, declared: false, phase: 'running' }
    this.runs.set(id, run)
    // 继续时立即投影旧卡的“更新中”；不为从未申报的聊天制造空 manifest。
    if (resume) void this.get(sessionId, turnId).then((docs) => { if (this.runs.get(id) === run) for (const doc of docs) this.updated(doc) }).catch((error: unknown) => {
      process.stderr.write(`[outputs] 恢复产物失败: ${message(error)}\n`)
    })
  }
  private run(sessionId: string, turnId: string, owner: object): Run {
    const run = this.runs.get(key(sessionId, turnId))
    if (run === undefined || run.owner !== owner) throw new Error('产物回合已失效')
    run.controller.signal.throwIfAborted()
    return run
  }
  /** 新用户回合从未成功申报时不读盘、不推迟既有终态；继续旧回合需要查其 manifest。 */
  finishEmpty(sessionId: string, turnId: string, owner: object): boolean {
    const run = this.run(sessionId, turnId, owner)
    if (run.declared || run.resume) return false
    this.runs.delete(key(sessionId, turnId))
    return true
  }
  private async lock(id: string): Promise<() => void> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((done) => { release = done })
    this.queues.set(id, next)
    await previous
    return () => { release(); if (this.queues.get(id) === next) this.queues.delete(id) }
  }
  async stage(sessionId: string, context: FileContext, owner: object, callId: string, declarations: OutputDeclaration[], agentSignal?: AbortSignal): Promise<TurnOutputs> {
    const run = this.run(sessionId, context.turnId, owner)
    const release = await this.lock(key(sessionId, context.turnId))
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(OUTPUT_LIMITS.timeout), ...(agentSignal === undefined ? [] : [agentSignal])])
    let items: OutputItem[] = []
    try {
      signal.throwIfAborted()
      const loaded = await this.storage.load(sessionId, context.turnId)
      const old = this.resumed(loaded, run)
      if (declarations.length > OUTPUT_LIMITS.items) throw new Error('一次最多申报100个产物，不能静默截断')
      const targets = new Map<string, { path: string; real: string; note?: string }>()
      for (const declaration of declarations) {
        if (declaration.note !== undefined && declaration.note.length > OUTPUT_LIMITS.note) throw new Error('产物说明最多200字符')
        const path = outputPath(declaration.path, context)
        try {
          const { real } = await this.storage.inspect(path)
          const id = canonical(real)
          const first = targets.get(id)
          targets.set(id, { path: first?.path ?? path, real, ...(declaration.note !== undefined && { note: declaration.note }) })
        } catch (error) { throw new Error(`${path}: ${message(error)}`) }
      }
      const all = await this.storage.list(sessionId)
      const copies = new Map([...all.flatMap((doc) => [...doc.active, ...doc.published]), ...[...this.pinned.values()].filter((pin) => pin.sessionId === sessionId).map((pin) => pin.item)].filter((item) => item.copy.status === 'saved').map((item) => [item.copy.status === 'saved' ? item.copy.relativePath : '', item.size]))
      const used = [...copies.values()].reduce((a, b) => a + b, 0)
      let remaining = Math.min(OUTPUT_LIMITS.revision, Math.max(0, OUTPUT_LIMITS.session - used))
      // 串行捕获天然不超过“两路并发”预算；声明整体提交，任一失败都回收本次副本。
      for (const target of targets.values()) {
        signal.throwIfAborted()
        const existing = [...(old?.active ?? []), ...(old?.published ?? [])].find((item) => canonical(item.realPath) === canonical(target.real))
        try {
          // 身份由Host按会话/回合/真实目标派生，撤回后重新申报仍是同一文件；ID本身不授予访问权。
          const outputId = existing?.outputId ?? createHash('sha256').update(JSON.stringify([sessionId, context.turnId, canonical(target.real)])).digest('hex')
          const item = await this.storage.capture(sessionId, context.turnId, target.path, outputId, target.note, remaining, signal, target.real)
          items.push(item)
          if (item.copy.status === 'saved') remaining -= item.size
        } catch (error) { throw new Error(`${target.path}: ${message(error)}`) }
      }
      const doc: TurnOutputs = { version: 1, sessionId, turnId: context.turnId, revision: (old?.revision ?? 0) + 1, state: 'running', declared: true, active: items, published: old?.published ?? [] }
      this.pending.set(key(sessionId, callId), { run, doc, old, signal, release })
      items = []
      return doc
    } catch (error) { try { await this.discard(items) } finally { release() }; throw error }
  }
  /** public afterToolCall 的原扩展链已经给出最终 verdict，此处才能返回真正的成功回执。 */
  async settle(sessionId: string, callId: string, successful: boolean): Promise<TurnOutputs | undefined> {
    const pendingId = key(sessionId, callId)
    const pending = this.pending.get(pendingId)
    if (pending === undefined) return undefined
    this.pending.delete(pendingId)
    let committed = false
    try {
      if (!successful) return undefined
      pending.signal.throwIfAborted()
      const { doc } = pending
      if (this.runs.get(key(doc.sessionId, doc.turnId)) !== pending.run) throw new Error('产物回合已失效')
      await this.storage.commit(doc, pending.signal)
      committed = true
      pending.signal.throwIfAborted()
      pending.run.declared = true
      this.updated(doc)
      this.scheduleClean(pending.old, doc)
      return doc
    } finally {
      try { if (!committed) await this.discard(pending.doc.active) }
      finally { pending.release() }
    }
  }
  async finalize(sessionId: string, turnId: string, owner: object, outcome: OutputOutcome): Promise<void> {
    const run = this.run(sessionId, turnId, owner)
    if (!run.declared && !run.resume) { this.runs.delete(key(sessionId, turnId)); return }
    run.phase = 'finalizing'
    const release = await this.lock(key(sessionId, turnId))
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(OUTPUT_LIMITS.timeout)])
    const captured: OutputItem[] = []
    let committed = false
    try {
      const old = this.resumed(await this.storage.load(sessionId, turnId), run)
      if (old === undefined) return
      const finalizing: TurnOutputs = { ...old, revision: old.revision + 1, state: 'finalizing' }
      await this.storage.commit(finalizing, signal)
      this.updated(finalizing)
      const all = await this.storage.list(sessionId)
      const retained = new Map([...all.flatMap((doc) => [...doc.active, ...doc.published]), ...[...this.pinned.values()].filter((pin) => pin.sessionId === sessionId).map((pin) => pin.item)].flatMap((item) => item.copy.status === 'saved' ? [[item.copy.relativePath, item.size] as const] : []))
      let remaining = Math.min(OUTPUT_LIMITS.revision, Math.max(0, OUTPUT_LIMITS.session - [...retained.values()].reduce((a, b) => a + b, 0)))
      for (const previous of old.active) {
        try {
          signal.throwIfAborted()
          const item = await this.storage.capture(sessionId, turnId, previous.sourcePath, previous.outputId, previous.note, remaining, signal, previous.realPath)
          captured.push(item.copy.status === 'source-only' && previous.copy.status === 'saved'
            ? { ...previous, warning: '最终版超过副本容量预算，保留最近确认版本；最终版未确认' } : item)
          if (item.copy.status === 'saved') remaining -= item.size
        } catch (error) {
          captured.push({ ...previous, warning: previous.copy.status === 'saved'
            ? `最终版未确认，保留最近确认版本：${message(error)}`
            : `最终版未确认：${message(error)}；未保存交付副本，当前原文件可能不可用` })
        }
      }
      run.controller.signal.throwIfAborted()
      const doc: TurnOutputs = { ...finalizing, revision: finalizing.revision + 1, state: 'ready', active: captured, published: captured, outcome }
      // 复制预算耗尽仍须尝试写明“保留旧版”；小清单提交另给短预算，不无限占住运行预约。
      await this.storage.commit(doc, AbortSignal.any([run.controller.signal, AbortSignal.timeout(2000)]))
      committed = true
      run.controller.signal.throwIfAborted()
      run.phase = 'ready'
      this.updated(doc)
      this.scheduleClean(old, doc)
    } finally {
      try { if (!committed) {
        const old = await this.storage.load(sessionId, turnId)
        const referenced = new Set([...(old?.active ?? []), ...(old?.published ?? [])].flatMap((item) => item.copy.status === 'saved' ? [item.copy.relativePath] : []))
        await this.discard(captured.filter((item) => item.copy.status === 'saved' && !referenced.has(item.copy.relativePath)))
      } } finally {
        release()
        if (this.runs.get(key(sessionId, turnId)) === run) this.runs.delete(key(sessionId, turnId))
      }
    }
  }
  async get(sessionId: string, turnId?: string): Promise<TurnOutputs[]> {
    if (this.deleted.has(sessionId)) return []
    let lifetime = this.lifetimes.get(sessionId)
    if (lifetime === undefined) { lifetime = new AbortController(); this.lifetimes.set(sessionId, lifetime) }
    const docs = turnId === undefined ? await this.storage.list(sessionId) : [await this.storage.load(sessionId, turnId)].filter((doc): doc is TurnOutputs => doc !== undefined)
    if (this.deleted.has(sessionId)) return []
    const result: TurnOutputs[] = []
    for (let doc of docs) {
      const run = this.runs.get(key(sessionId, doc.turnId))
      if (run !== undefined) { result.push({ ...this.resumed(doc, run)!, state: run.phase }); continue }
      if (doc.state !== 'ready' && doc.state !== 'interrupted') {
        const release = await this.lock(key(sessionId, doc.turnId))
        try {
          if (this.deleted.has(sessionId)) return []
          const current = (await this.storage.load(sessionId, doc.turnId))!
          if (this.runs.has(key(sessionId, doc.turnId))) { result.push({ ...current, state: 'running' }); continue }
          if (current.state === 'ready' || current.state === 'interrupted') doc = current
          else {
            doc = { ...current, revision: current.revision + 1, state: 'interrupted', published: current.active, warning: '上次运行中断，保留最近确认版本；未重新读取当前原文件' }
            await this.storage.commit(doc, AbortSignal.any([lifetime.signal, AbortSignal.timeout(OUTPUT_LIMITS.timeout)]))
            lifetime.signal.throwIfAborted()
            this.updated(doc)
          }
        } finally { release() }
      }
      result.push(doc)
    }
    // 重启遗留暂存只按已提交引用清理，正在申报/收尾的回合全部跳过。
    const all = await this.storage.list(sessionId)
    const retained = new Set([...this.pinned.keys(), ...all.flatMap((doc) => [...doc.active, ...doc.published]).flatMap((item) => item.copy.status === 'saved' ? [item.copy.relativePath] : [])])
    try { await this.storage.collect(sessionId, retained, (turn) => this.runs.has(key(sessionId, turn))) }
    catch (error) { process.stderr.write(`[outputs] 回收暂存失败: ${message(error)}\n`) }
    return this.deleted.has(sessionId) ? [] : result
  }
  private resumed(doc: TurnOutputs | undefined, run: Run): TurnOutputs | undefined {
    if (doc === undefined || !run.resume || run.declared || doc.state === 'ready' || doc.state === 'interrupted') return doc
    return { ...doc, published: doc.active, warning: '上次运行中断，保留最近确认版本' }
  }
  async lastConfirmed(sessionId: string, turnId: string): Promise<TurnOutputs | undefined> {
    const doc = await this.storage.load(sessionId, turnId)
    return doc === undefined ? undefined : { ...doc, state: 'interrupted', published: doc.active, warning: '产物结算未完成，保留最近持久确认版本；最终版未确认' }
  }
  wrote(sessionId: string, turnId: string): void { const run = this.runs.get(key(sessionId, turnId)); if (run !== undefined) run.wrote = true }
  async reminder(sessionId: string, turnId: string): Promise<string | undefined> {
    const run = this.runs.get(key(sessionId, turnId))
    if (run === undefined || !run.wrote || run.reminded) return undefined
    run.reminded = true
    if (await this.storage.load(sessionId, turnId) !== undefined) return undefined
    return outputReminderText()
  }
  async resolve(target: OutputTarget, files: FileService, independent = false): Promise<FileDescriptor> {
    const docs = await this.get(target.sessionId, target.turnId)
    const doc: TurnOutputs | undefined = docs.at(0)
    if (doc === undefined || target.revision > doc.revision) throw new Error('产物版本不存在')
    const item = doc.published.find((item) => item.outputId === target.outputId)
    if (item === undefined) throw new Error('该产物已撤回或不属于本回合')
    // 更新中沿用已发布字节；更新完成后的旧卡不能悄悄解析到另一份新交付。
    if (target.revision !== doc.revision) throw new Error('产物卡已更新，请从当前卡片重新打开')
    return this.register(doc, item, target.version, files, independent)
  }
  private async register(doc: TurnOutputs, item: OutputItem, version: 'delivery' | 'current', files: FileService, independent = false): Promise<FileDescriptor> {
    if (version === 'current' || item.copy.status === 'source-only') {
      await this.storage.inspect(item.sourcePath, item.realPath)
      return files.registerPath(doc.sessionId, item.sourcePath, doc.turnId, undefined, {}, true, independent)
    }
    const path = await this.storage.verify(item)
    const deliveryItem = { ...item, copy: item.copy }
    const relativePath = item.copy.relativePath
    this.pinned.set(relativePath, { item, sessionId: doc.sessionId, count: (this.pinned.get(relativePath)?.count ?? 0) + 1 })
    const release = () => {
      const pin = this.pinned.get(relativePath)
      if (pin === undefined) return
      pin.count--
      if (pin.count === 0) this.pinned.delete(relativePath)
    }
    try { return await files.registerPath(doc.sessionId, path, doc.turnId, {
      sourcePath: item.sourcePath, confirmedAt: item.confirmedAt,
      target: { sessionId: doc.sessionId, turnId: doc.turnId, revision: doc.revision, outputId: item.outputId, version: 'delivery' },
      release,
      actionTarget: () => this.storage.export(deliveryItem),
      relative: async (raw) => {
        const { resolveFileTarget } = await import('../files/paths')
        const dependency = resolveFileTarget(raw, { cwd: dirname(item.sourcePath), platform: process.platform }, homedir())
        const match = doc.published.find((candidate) => canonical(resolve(candidate.sourcePath)) === canonical(dependency.path))
        if (match === undefined || match.copy.status !== 'saved') throw new Error('依赖未保存；请单独打开当前原文件查看')
        const descriptor = await this.register(doc, match, 'delivery', files, independent)
        return { ...descriptor, ...(dependency.location !== undefined && { location: dependency.location }) }
      }
    }, {}, true, independent) } catch (error) { release(); throw error }
  }
  private async clean(old: TurnOutputs | undefined, current: TurnOutputs): Promise<void> {
    if (old === undefined) return
    const keep = new Set([...this.pinned.keys(), ...[...current.active, ...current.published].flatMap((item) => item.copy.status === 'saved' ? [item.copy.relativePath] : [])])
    try { await this.storage.removeCopies([...old.active, ...old.published].filter((item) => item.copy.status === 'saved' && !keep.has(item.copy.relativePath))) }
    catch (error) { process.stderr.write(`[outputs] 清理无引用副本失败: ${message(error)}\n`) }
  }
  private scheduleClean(old: TurnOutputs | undefined, current: TurnOutputs): void {
    const job = (this.cleaning.get(current.sessionId) ?? Promise.resolve()).then(() => this.clean(old, current))
    this.cleaning.set(current.sessionId, job)
    void job.then(() => { if (this.cleaning.get(current.sessionId) === job) this.cleaning.delete(current.sessionId) })
  }
  async drain(): Promise<void> { await Promise.all([...this.queues.values(), ...this.cleaning.values(), ...this.deletions.values()]) }
  private async discard(items: OutputItem[]): Promise<void> {
    try { await this.storage.removeCopies(items) }
    catch (error) { process.stderr.write(`[outputs] 回收未提交暂存失败，稍后按manifest引用重试: ${message(error)}\n`) }
  }
  releaseSession(sessionId: string): Promise<void> {
    // 读历史也可能修复中断manifest；删除先封住读修复入口，避免它在rm期间重建目录。
    this.deleted.add(sessionId)
    this.lifetimes.get(sessionId)?.abort()
    this.lifetimes.delete(sessionId)
    for (const [path, pin] of this.pinned) if (pin.sessionId === sessionId) this.pinned.delete(path)
    for (const [id, run] of this.runs) if (id.startsWith(sessionId + '/')) { run.controller.abort(); this.runs.delete(id) }
    // 先让正在复制/提交的持有者结束，再删除；禁止迟到工作重建已删会话目录。
    const jobs = [...this.queues].filter(([id]) => id.startsWith(sessionId + '/')).map(([, job]) => job)
    const cleaning = this.cleaning.get(sessionId)
    if (cleaning !== undefined) jobs.push(cleaning)
    const removal = Promise.all(jobs).then(() => this.storage.removeSession(sessionId))
    this.deletions.set(sessionId, removal)
    void removal.finally(() => this.deletions.delete(sessionId)).catch(() => {})
    return removal
  }
  dispose(): void { for (const run of this.runs.values()) run.controller.abort(); for (const lifetime of this.lifetimes.values()) lifetime.abort(); this.runs.clear(); this.lifetimes.clear(); this.storage.cleanExports() }
}
