/** 本轮改动列表 Host 服务：预约回合、审批放行后按需捕获、收尾净差结算、按需读取与会话隔离清理。 */
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { ChangeCoverage, ChangeKind, ChangeOutcome, TurnChangeItem, TurnChangesSummary, TurnFileDiff } from '../../../shared/changes'
import { resolveToolFilePath } from '../files/paths'
import { createDefaultDiffCalculator, type DiffCalculator } from './diff-client'
import { decodeBuffer } from './diff-core'
import { formatChangePath, normalizeRoots, scanWorkspaceRoots, type NormalizedRoot } from './scanner'
import { ChangeStorage } from './storage'
import {
  CHANGE_LIMITS,
  canonicalPath,
  type BaselineEntry,
  type SnapshotSide,
  type StatCacheEntry,
  type StoredChangeEntry,
  type TurnChangesDocument
} from './types'

const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'glob',
  'read_attachment',
  'report_outputs',
  'todo_write',
  'ask_user',
  'enter_plan',
  'submit_plan',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource'
])

const FILE_TOOLS = new Set(['write', 'edit'])
const key = (sessionId: string, turnId: string) => `${sessionId}/${turnId}`
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface RunState {
  sessionId: string
  turnId: string
  owner: object
  controller: AbortController
  rawRoots: string[]
  roots?: NormalizedRoot[]
  resume: boolean
  touched: boolean
  workspaceScanned: boolean
  coverage: ChangeCoverage
  warnings: string[]
  baseline: Map<string, BaselineEntry>
  baselineIncompleteDirs: Set<string>
  observedTools: Set<string>
  remainingTurnBudget: number
  remainingSessionBudget: number
  previousDoc?: TurnChangesDocument
  phase: 'running' | 'finalizing' | 'ready'
  queue: Promise<void>
}

function isUnderDirSet(targetCanon: string, dirSet: Set<string>): boolean {
  if (dirSet.size === 0) return false
  let cur = targetCanon
  for (let parent = dirname(cur); ; cur = parent, parent = dirname(cur)) {
    if (dirSet.has(cur)) return true
    if (parent === cur) return false
  }
}

function sameSide(a: SnapshotSide, b: SnapshotSide): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'absent') return true
  if (a.kind === 'symlink' && b.kind === 'symlink') return a.target === b.target && a.mode === b.mode
  if (a.kind === 'unknown' && b.kind === 'unknown') return a.reason === b.reason
  if (a.kind === 'file' && b.kind === 'file') {
    if (a.unreadable !== undefined || b.unreadable !== undefined) return false
    if (a.sha256 !== undefined && b.sha256 !== undefined) {
      return a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode
    }
    return false
  }
  return false
}

function makeChangeId(canonical: string, oldCanonical?: string): string {
  const input = oldCanonical === undefined ? canonical : `${canonical}<-${oldCanonical}`
  return createHash('sha256').update(input).digest('hex').slice(0, 24)
}

export class WorkspaceChangesService {
  readonly storage: ChangeStorage
  private readonly diffCalc: DiffCalculator
  private runs = new Map<string, RunState>()
  private deletions = new Map<string, Promise<void>>()
  private deleted = new Set<string>()
  private lifetimes = new Map<string, AbortController>()
  private statCaches = new Map<string, Map<string, StatCacheEntry>>()

  constructor(
    private hostRoot: string,
    private updated: (summary: TurnChangesSummary) => void,
    diffCalc?: DiffCalculator
  ) {
    this.storage = new ChangeStorage(hostRoot)
    this.diffCalc = diffCalc ?? createDefaultDiffCalculator()
  }

  begin(sessionId: string, turnId: string, owner: object, roots: string[], resume = false): void {
    const id = key(sessionId, turnId)
    const run: RunState = {
      sessionId,
      turnId,
      owner,
      controller: new AbortController(),
      rawRoots: [...roots],
      resume,
      touched: false,
      workspaceScanned: false,
      coverage: roots.length > 0 ? 'complete' : 'tools-only',
      warnings: [],
      baseline: new Map(),
      baselineIncompleteDirs: new Set(),
      observedTools: new Set(),
      remainingTurnBudget: CHANGE_LIMITS.turnBlobBudget,
      remainingSessionBudget: CHANGE_LIMITS.sessionBlobBudget,
      phase: 'running',
      queue: Promise.resolve()
    }
    this.runs.set(id, run)
  }

  private getRun(sessionId: string, turnId: string, owner: object): RunState {
    const run = this.runs.get(key(sessionId, turnId))
    if (run === undefined || run.owner !== owner) throw new Error('改动追踪回合已失效')
    run.controller.signal.throwIfAborted()
    return run
  }

  private enqueue<T>(run: RunState, task: () => Promise<T>): Promise<T> {
    const next = run.queue.then(task)
    run.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private statCache(sessionId: string): Map<string, StatCacheEntry> {
    let cache = this.statCaches.get(sessionId)
    if (cache === undefined) {
      cache = new Map()
      this.statCaches.set(sessionId, cache)
    }
    return cache
  }

  private async ensurePrepared(run: RunState): Promise<void> {
    if (run.roots === undefined) {
      const normalized = await normalizeRoots(run.rawRoots)
      run.roots = normalized.roots
      run.warnings.push(...normalized.warnings)
      if (normalized.roots.length === 0) {
        run.coverage = 'tools-only'
        if (run.rawRoots.length === 0) {
          run.warnings.push('未绑定工作区目录，仅追踪文件工具改动')
        } else {
          run.coverage = 'partial'
        }
      }
      const used = await this.storage.sessionBlobBytes(run.sessionId)
      run.remainingSessionBudget = Math.max(0, CHANGE_LIMITS.sessionBlobBudget - used)
    }
    if (run.resume && run.previousDoc === undefined) {
      run.previousDoc = await this.storage.load(run.sessionId, run.turnId)
      if (run.previousDoc !== undefined) {
        for (const entry of run.previousDoc.entries) {
          const canon = canonicalPath(resolve(entry.item.absolutePath))
          run.baseline.set(canon, {
            canonical: canon,
            absolutePath: entry.item.absolutePath,
            side: entry.before,
            source: entry.item.source === 'workspace' ? 'workspace' : 'tool'
          })
          if (entry.item.oldAbsolutePath !== undefined) {
            const oldCanon = canonicalPath(resolve(entry.item.oldAbsolutePath))
            run.baseline.set(oldCanon, {
              canonical: oldCanon,
              absolutePath: entry.item.oldAbsolutePath,
              side: entry.before,
              source: entry.item.source === 'workspace' ? 'workspace' : 'tool'
            })
          }
        }
        if (run.previousDoc.baseline !== undefined) {
          for (const base of run.previousDoc.baseline.entries) {
            if (!run.baseline.has(base.canonical)) run.baseline.set(base.canonical, base)
          }
        }
      }
    }
  }

  private async captureInto(run: RunState, absolutePath: string, signal: AbortSignal): Promise<SnapshotSide> {
    const budget = Math.min(run.remainingTurnBudget, run.remainingSessionBudget)
    const { side, bytesWritten } = await this.storage.captureSide(
      run.sessionId,
      absolutePath,
      budget,
      signal,
      this.statCache(run.sessionId)
    )
    run.remainingTurnBudget = Math.max(0, run.remainingTurnBudget - bytesWritten)
    run.remainingSessionBudget = Math.max(0, run.remainingSessionBudget - bytesWritten)
    return side
  }

  /** 仅在审批放行后调用；只读工具零开销直接返回。 */
  async beforeTool(
    sessionId: string,
    turnId: string,
    owner: object,
    toolName: string,
    args: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (READ_ONLY_TOOLS.has(toolName)) return
    const run = this.getRun(sessionId, turnId, owner)
    await this.enqueue(run, async () => {
      const combined = signal === undefined ? run.controller.signal : AbortSignal.any([run.controller.signal, signal])
      combined.throwIfAborted()
      run.touched = true
      await this.ensurePrepared(run)

      if (FILE_TOOLS.has(toolName)) {
        if (typeof args.path !== 'string') return
        const resolved = resolveToolFilePath(args.path, { cwd, platform: process.platform })
        const canon = canonicalPath(resolved)
        run.observedTools.add(canon)
        if (!run.baseline.has(canon)) {
          const side = await this.captureInto(run, resolved, combined)
          run.baseline.set(canon, { canonical: canon, absolutePath: resolved, side, source: 'tool' })
        }
        return
      }

      if (run.workspaceScanned) return
      run.workspaceScanned = true
      if (run.roots!.length === 0) return

      const scan = await scanWorkspaceRoots(
        run.roots!,
        this.hostRoot,
        (path, scanSignal) => this.captureInto(run, path, scanSignal),
        combined,
        CHANGE_LIMITS.scanTimeoutMs
      )
      for (const dir of scan.incompleteDirs) {
        run.baselineIncompleteDirs.add(dir)
      }
      for (const entry of scan.entries) {
        if (!run.baseline.has(entry.canonical)) {
          run.baseline.set(entry.canonical, {
            canonical: entry.canonical,
            absolutePath: entry.absolutePath,
            side: entry.side,
            source: 'workspace'
          })
        }
      }
      if (scan.coverage === 'partial') run.coverage = 'partial'
      run.warnings.push(...scan.warnings)
    })
  }

  async afterTool(
    sessionId: string,
    turnId: string,
    owner: object,
    toolName: string,
    args: Record<string, unknown>,
    cwd: string
  ): Promise<void> {
    if (!FILE_TOOLS.has(toolName) || typeof args.path !== 'string') return
    const run = this.runs.get(key(sessionId, turnId))
    if (run === undefined || run.owner !== owner) return
    await this.enqueue(run, () => {
      const resolved = resolveToolFilePath(args.path as string, { cwd, platform: process.platform })
      run.observedTools.add(canonicalPath(resolved))
      return Promise.resolve()
    })
  }

  /** 纯只读新回合：零磁盘扫描与落盘，立即返回 true 让 finishRun 短路。 */
  finishEmpty(sessionId: string, turnId: string, owner: object): boolean {
    const run = this.getRun(sessionId, turnId, owner)
    if (run.touched || run.resume) return false
    this.runs.delete(key(sessionId, turnId))
    return true
  }

  async finalize(sessionId: string, turnId: string, owner: object, outcome: ChangeOutcome): Promise<void> {
    const run = this.getRun(sessionId, turnId, owner)
    if (!run.touched && !run.resume) {
      this.runs.delete(key(sessionId, turnId))
      return
    }
    try {
      await this.enqueue(run, async () => {
        run.phase = 'finalizing'
        const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(CHANGE_LIMITS.scanTimeoutMs + 5_000)])
        await this.ensurePrepared(run)
        if (!run.touched && run.previousDoc !== undefined) {
          const updated: TurnChangesDocument = {
            ...run.previousDoc,
            summary: {
              ...run.previousDoc.summary,
              revision: run.previousDoc.summary.revision + 1,
              state: 'ready',
              outcome
            },
            baseline: undefined
          }
          await this.storage.commit(updated, signal)
          run.phase = 'ready'
          this.updated(updated.summary)
          return
        }

        const afterMap = new Map<string, { absolutePath: string; side: SnapshotSide; source: 'workspace' | 'tool' }>()
        if (run.workspaceScanned && run.roots!.length > 0) {
          const scan = await scanWorkspaceRoots(
            run.roots!,
            this.hostRoot,
            (path, scanSignal) => this.captureInto(run, path, scanSignal),
            signal,
            CHANGE_LIMITS.scanTimeoutMs
          )
          if (scan.coverage === 'partial') run.coverage = 'partial'
          run.warnings.push(...scan.warnings)
          for (const entry of scan.entries) {
            afterMap.set(entry.canonical, { absolutePath: entry.absolutePath, side: entry.side, source: 'workspace' })
          }
        }

        // 先补采被文件工具直接触及的路径，再核对未被终点扫描覆盖的基线文件，超时则诚实标 partial。
        const missingTargets = [
          ...[...run.observedTools].filter((canon) => !afterMap.has(canon)),
          ...[...run.baseline.keys()].filter((canon) => !afterMap.has(canon) && !run.observedTools.has(canon))
        ]
        const isFinalizeAborted = (): boolean => signal.aborted
        for (const canon of missingTargets) {
          if (isFinalizeAborted()) {
            if (run.controller.signal.aborted) signal.throwIfAborted()
            run.coverage = 'partial'
            run.warnings.push('收尾补采超时，部分基线文件未完成终点核对')
            break
          }
          const base = run.baseline.get(canon)
          const abs = base?.absolutePath ?? canon
          try {
            const side = await this.captureInto(run, abs, signal)
            afterMap.set(canon, {
              absolutePath: abs,
              side,
              source: base?.source ?? 'tool'
            })
          } catch (error) {
            if (run.controller.signal.aborted) throw error
            if (isFinalizeAborted()) {
              run.coverage = 'partial'
              run.warnings.push('收尾补采超时，部分基线文件未完成终点核对')
              break
            }
            throw error
          }
        }

        const rawEntries = await this.buildEntries(run, afterMap, signal)
        const entries = this.collapseRenames(rawEntries, run.roots!)
        entries.sort((a, b) => a.item.path.localeCompare(b.item.path))

        let totalAdded = 0
        let totalDeleted = 0
        let incompleteCount = 0
        for (const entry of entries) {
          if (entry.item.added === null || entry.item.deleted === null) {
            incompleteCount++
          } else {
            totalAdded += entry.item.added
            totalDeleted += entry.item.deleted
          }
        }
        const uniqueWarnings = Array.from(new Set(run.warnings))
        const revision = (run.previousDoc?.summary.revision ?? 0) + 1
        const summary: TurnChangesSummary = {
          version: 1,
          sessionId,
          turnId,
          revision,
          state: 'ready',
          coverage: run.workspaceScanned ? run.coverage : (run.coverage === 'partial' ? 'partial' : 'tools-only'),
          totalAdded,
          totalDeleted,
          incompleteCount,
          items: entries.map((entry) => entry.item),
          warnings: uniqueWarnings,
          outcome
        }
        const doc: TurnChangesDocument = { summary, entries }
        await this.storage.commit(doc, signal)
        run.phase = 'ready'
        this.updated(summary)
        await this.collectSessionBlobs(sessionId)
      })
    } finally {
      if (this.runs.get(key(sessionId, turnId)) === run) this.runs.delete(key(sessionId, turnId))
    }
  }

  private async buildEntries(
    run: RunState,
    afterMap: Map<string, { absolutePath: string; side: SnapshotSide; source: 'workspace' | 'tool' }>,
    signal: AbortSignal
  ): Promise<StoredChangeEntry[]> {
    const result: StoredChangeEntry[] = []
    const allKeys = new Set([...run.baseline.keys(), ...afterMap.keys()])
    for (const canon of allKeys) {
      signal.throwIfAborted()
      const base = run.baseline.get(canon)
      const afterEntry = afterMap.get(canon)
      // 起点未扫到该目录时未知 before，不能把既有文件误判为新增；终点未补采时未知 after，不能误判为删除。
      if (base === undefined && afterEntry !== undefined && !run.observedTools.has(canon) && run.workspaceScanned && isUnderDirSet(canon, run.baselineIncompleteDirs)) {
        run.coverage = 'partial'
        continue
      }
      if (base !== undefined && afterEntry === undefined) {
        run.coverage = 'partial'
        continue
      }
      const before: SnapshotSide = base?.side ?? { kind: 'absent' }
      const after: SnapshotSide = afterEntry?.side ?? { kind: 'absent' }
      if (sameSide(before, after)) continue

      const absolutePath = afterEntry?.absolutePath ?? base!.absolutePath
      const { display, outsideWorkspace } = formatChangePath(absolutePath, run.roots!)
      const source: TurnChangeItem['source'] =
        base?.source === 'tool' && afterEntry?.source === 'workspace'
          ? 'merged'
          : run.observedTools.has(canon) && base?.source === 'workspace'
            ? 'merged'
            : (base?.source ?? afterEntry?.source ?? 'tool')

      const computed = await this.evaluateChange(run.sessionId, display, absolutePath, canon, before, after, outsideWorkspace, source, signal)
      if (computed !== undefined) result.push(computed)
    }
    return result
  }

  private async evaluateChange(
    sessionId: string,
    display: string,
    absolutePath: string,
    canon: string,
    before: SnapshotSide,
    after: SnapshotSide,
    outsideWorkspace: boolean,
    source: TurnChangeItem['source'],
    signal: AbortSignal
  ): Promise<StoredChangeEntry | undefined> {
    const changeId = makeChangeId(canon)
    const baseItem = {
      changeId,
      path: display,
      absolutePath,
      ...(outsideWorkspace && { outsideWorkspace: true }),
      source
    }

    if (before.kind === 'unknown' || after.kind === 'unknown') {
      const reason = before.kind === 'unknown' ? before.reason : (after as Extract<SnapshotSide, { kind: 'unknown' }>).reason
      const kind: ChangeKind = before.kind === 'absent' ? 'added' : after.kind === 'absent' ? 'deleted' : 'modified'
      return { item: { ...baseItem, kind, added: null, deleted: null, reason }, before, after }
    }

    if (before.kind === 'symlink' || after.kind === 'symlink') {
      const kind: ChangeKind =
        before.kind === 'absent' ? 'added' : after.kind === 'absent' ? 'deleted' : 'type-changed'
      const reason =
        before.kind === 'symlink' && after.kind === 'symlink'
          ? `符号链接目标变更：${before.target} → ${after.target}`
          : '文件与符号链接类型变更'
      return { item: { ...baseItem, kind, added: null, deleted: null, reason }, before, after }
    }

    // 两侧现均已收窄为 absent | file
    const beforeFile = before.kind === 'file' ? before : undefined
    const afterFile = after.kind === 'file' ? after : undefined

    if (beforeFile?.unreadable !== undefined || afterFile?.unreadable !== undefined) {
      const reason = beforeFile?.unreadable ?? afterFile?.unreadable ?? '文件不可读'
      const kind: ChangeKind = beforeFile === undefined ? 'added' : afterFile === undefined ? 'deleted' : 'modified'
      return { item: { ...baseItem, kind, added: null, deleted: null, reason }, before, after }
    }

    if (beforeFile?.oversized === true || afterFile?.oversized === true || beforeFile?.saved === false || afterFile?.saved === false) {
      const kind: ChangeKind = beforeFile === undefined ? 'added' : afterFile === undefined ? 'deleted' : 'modified'
      return {
        item: { ...baseItem, kind, added: null, deleted: null, oversized: true, reason: '超出单文件或容量预算' },
        before,
        after
      }
    }

    if (beforeFile !== undefined && afterFile !== undefined && beforeFile.sha256 === afterFile.sha256 && beforeFile.mode !== afterFile.mode) {
      return {
        item: { ...baseItem, kind: 'mode-changed', added: 0, deleted: 0, reason: '文件权限模式变化' },
        before,
        after
      }
    }

    const beforeBuf = beforeFile?.sha256 === undefined ? null : await this.storage.readBlob(sessionId, beforeFile.sha256, beforeFile.size, signal)
    const afterBuf = afterFile?.sha256 === undefined ? null : await this.storage.readBlob(sessionId, afterFile.sha256, afterFile.size, signal)
    const stat = await this.diffCalc.stat(beforeBuf, afterBuf, CHANGE_LIMITS.diffTimeoutMs, signal)

    if (stat.status === 'binary') {
      const kind: ChangeKind = beforeFile === undefined ? 'added' : afterFile === undefined ? 'deleted' : 'modified'
      return { item: { ...baseItem, kind, added: null, deleted: null, binary: true }, before, after }
    }
    if (stat.status === 'timeout') {
      const kind: ChangeKind = beforeFile === undefined ? 'added' : afterFile === undefined ? 'deleted' : 'modified'
      return { item: { ...baseItem, kind, added: null, deleted: null, reason: '差异计算超时' }, before, after }
    }
    if (stat.status === 'eol-or-encoding') {
      return {
        item: { ...baseItem, kind: 'eol-or-encoding', added: 0, deleted: 0, reason: '换行符或文本编码变化' },
        before,
        after
      }
    }

    const kind: ChangeKind = beforeFile === undefined ? 'added' : afterFile === undefined ? 'deleted' : 'modified'
    return { item: { ...baseItem, kind, added: stat.added, deleted: stat.deleted }, before, after }
  }

  /** 对非空且内容 hash 唯一配对的一删一增折叠为重命名，歧义时保持独立条目。 */
  private collapseRenames(entries: StoredChangeEntry[], roots: readonly NormalizedRoot[]): StoredChangeEntry[] {
    const deletedByHash = new Map<string, StoredChangeEntry[]>()
    const addedByHash = new Map<string, StoredChangeEntry[]>()
    for (const entry of entries) {
      if (entry.item.kind === 'deleted' && entry.before.kind === 'file' && entry.before.saved && entry.before.size > 0 && entry.before.sha256 !== undefined) {
        const list = deletedByHash.get(entry.before.sha256) ?? []
        list.push(entry)
        deletedByHash.set(entry.before.sha256, list)
      }
      if (entry.item.kind === 'added' && entry.after.kind === 'file' && entry.after.saved && entry.after.size > 0 && entry.after.sha256 !== undefined) {
        const list = addedByHash.get(entry.after.sha256) ?? []
        list.push(entry)
        addedByHash.set(entry.after.sha256, list)
      }
    }

    const consumed = new Set<StoredChangeEntry>()
    const merged: StoredChangeEntry[] = []
    for (const [hash, deletes] of deletedByHash) {
      const adds = addedByHash.get(hash)
      if (deletes.length !== 1 || adds === undefined || adds.length !== 1) continue
      const del = deletes[0]
      const add = adds[0]
      consumed.add(del)
      consumed.add(add)
      const oldDisplay = formatChangePath(del.item.absolutePath, roots).display
      const newCanon = canonicalPath(add.item.absolutePath)
      const oldCanon = canonicalPath(del.item.absolutePath)
      merged.push({
        item: {
          ...add.item,
          changeId: makeChangeId(newCanon, oldCanon),
          oldPath: oldDisplay,
          oldAbsolutePath: del.item.absolutePath,
          kind: 'renamed',
          added: 0,
          deleted: 0,
          source: del.item.source === add.item.source ? add.item.source : 'merged'
        },
        before: del.before,
        after: add.after
      })
    }

    return [...entries.filter((entry) => !consumed.has(entry)), ...merged]
  }

  async get(sessionId: string, turnId?: string): Promise<TurnChangesSummary[]> {
    if (this.deleted.has(sessionId)) return []
    let lifetime = this.lifetimes.get(sessionId)
    if (lifetime === undefined) {
      lifetime = new AbortController()
      this.lifetimes.set(sessionId, lifetime)
    }
    const docs =
      turnId === undefined
        ? await this.storage.list(sessionId)
        : [await this.storage.load(sessionId, turnId)].filter((doc): doc is TurnChangesDocument => doc !== undefined)
    if (this.deleted.has(sessionId)) return []

    const result: TurnChangesSummary[] = []
    for (const doc of docs) {
      const run = this.runs.get(key(sessionId, doc.summary.turnId))
      if (run !== undefined) {
        result.push({ ...doc.summary, state: run.phase })
        continue
      }
      if (doc.summary.state === 'running' || doc.summary.state === 'finalizing') {
        const interrupted: TurnChangesDocument = {
          ...doc,
          summary: {
            ...doc.summary,
            revision: doc.summary.revision + 1,
            state: 'interrupted',
            warnings: Array.from(new Set([...doc.summary.warnings, '上次运行中断，未冻结终态快照']))
          },
          baseline: undefined
        }
        await this.storage.commit(interrupted, AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]))
        result.push(interrupted.summary)
      } else {
        result.push(doc.summary)
      }
    }
    await this.collectSessionBlobs(sessionId).catch((error: unknown) => {
      process.stderr.write(`[changes] 回收孤立对象失败: ${message(error)}\n`)
    })
    return this.deleted.has(sessionId) ? [] : result
  }

  async diff(sessionId: string, turnId: string, revision: number, changeId: string): Promise<TurnFileDiff> {
    if (this.deleted.has(sessionId)) throw new Error('会话已删除')
    const doc = await this.storage.load(sessionId, turnId)
    if (doc === undefined || revision > doc.summary.revision) throw new Error('改动记录不存在')
    if (revision !== doc.summary.revision) throw new Error('改动记录已更新，请从最新列表重新打开')
    const entry = doc.entries.find((candidate) => candidate.item.changeId === changeId)
    if (entry === undefined) throw new Error('未找到对应的文件改动记录')

    const { item, before, after } = entry
    const base: Omit<TurnFileDiff, 'status' | 'beforeExists' | 'afterExists'> = {
      sessionId,
      turnId,
      revision,
      changeId,
      path: item.path,
      absolutePath: item.absolutePath,
      ...(item.oldPath !== undefined && { oldPath: item.oldPath }),
      kind: item.kind,
      added: item.added,
      deleted: item.deleted,
      ...(item.reason !== undefined && { reason: item.reason }),
      ...(before.kind === 'file' && { beforeSize: before.size }),
      ...(after.kind === 'file' && { afterSize: after.size })
    }

    const beforeExists = before.kind !== 'absent'
    const afterExists = after.kind !== 'absent'

    if (before.kind === 'unknown' || after.kind === 'unknown') {
      return { ...base, status: 'unavailable', beforeExists, afterExists }
    }
    if (before.kind === 'symlink' || after.kind === 'symlink') {
      return { ...base, status: 'non-text-change', beforeExists, afterExists }
    }
    if (before.kind === 'file' && before.unreadable !== undefined || after.kind === 'file' && after.unreadable !== undefined) {
      return { ...base, status: 'unreadable', beforeExists, afterExists }
    }
    if (item.oversized === true || (before.kind === 'file' && !before.saved) || (after.kind === 'file' && !after.saved)) {
      return { ...base, status: 'oversized', beforeExists, afterExists }
    }
    if (item.binary === true) {
      return { ...base, status: 'binary', beforeExists, afterExists }
    }

    const signal = AbortSignal.timeout(CHANGE_LIMITS.scanTimeoutMs)
    const beforeBuf =
      before.kind === 'file' && before.sha256 !== undefined
        ? await this.storage.readBlob(sessionId, before.sha256, before.size, signal)
        : null
    const afterBuf =
      after.kind === 'file' && after.sha256 !== undefined
        ? await this.storage.readBlob(sessionId, after.sha256, after.size, signal)
        : null

    const beforeDecoded = beforeBuf === null ? null : decodeBuffer(beforeBuf)
    const afterDecoded = afterBuf === null ? null : decodeBuffer(afterBuf)
    if ((beforeDecoded !== null && beforeDecoded.binary) || (afterDecoded !== null && afterDecoded.binary)) {
      return { ...base, status: 'binary', beforeExists, afterExists }
    }

    return {
      ...base,
      status: item.reason === '差异计算超时' ? 'timeout' : 'text',
      beforeExists,
      afterExists,
      ...(beforeDecoded?.binary === false && { beforeText: beforeDecoded.text, beforeEncoding: beforeDecoded.encoding }),
      ...(afterDecoded?.binary === false && { afterText: afterDecoded.text, afterEncoding: afterDecoded.encoding })
    }
  }

  private async collectSessionBlobs(sessionId: string): Promise<void> {
    if (this.deleted.has(sessionId)) return
    const docs = await this.storage.list(sessionId)
    const retained = new Set<string>()
    for (const doc of docs) {
      for (const entry of doc.entries) {
        if (entry.before.kind === 'file' && entry.before.saved && entry.before.sha256 !== undefined) retained.add(entry.before.sha256)
        if (entry.after.kind === 'file' && entry.after.saved && entry.after.sha256 !== undefined) retained.add(entry.after.sha256)
      }
      if (doc.baseline !== undefined) {
        for (const base of doc.baseline.entries) {
          if (base.side.kind === 'file' && base.side.saved && base.side.sha256 !== undefined) retained.add(base.side.sha256)
        }
      }
    }
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) continue
      for (const base of run.baseline.values()) {
        if (base.side.kind === 'file' && base.side.saved && base.side.sha256 !== undefined) retained.add(base.side.sha256)
      }
    }
    await this.storage.collectBlobs(sessionId, retained)
  }

  releaseSession(sessionId: string): Promise<void> {
    this.deleted.add(sessionId)
    this.statCaches.delete(sessionId)
    this.lifetimes.get(sessionId)?.abort()
    this.lifetimes.delete(sessionId)
    const pendingQueues: Promise<void>[] = []
    for (const [id, run] of this.runs) {
      if (run.sessionId !== sessionId) continue
      run.controller.abort()
      pendingQueues.push(run.queue)
      this.runs.delete(id)
    }
    const removal = Promise.allSettled(pendingQueues).then(() => this.storage.removeSession(sessionId))
    this.deletions.set(sessionId, removal)
    void removal.finally(() => this.deletions.delete(sessionId)).catch(() => {})
    return removal
  }

  async drain(): Promise<void> {
    const active = [...this.runs.values()].map((run) => run.queue)
    await Promise.allSettled([...active, ...this.deletions.values()])
  }

  dispose(): void {
    for (const run of this.runs.values()) run.controller.abort()
    for (const lifetime of this.lifetimes.values()) lifetime.abort()
    this.runs.clear()
    this.lifetimes.clear()
    this.statCaches.clear()
    this.diffCalc.dispose()
  }
}
