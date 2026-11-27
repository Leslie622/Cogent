/** 有界工作区目录扫描：跳过版本库/依赖缓存与嵌套仓库，不跟随目录符号链接。 */
import type { Dirent } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChangeCoverage } from '../../../shared/changes'
import { CHANGE_LIMITS, canonicalPath, type SnapshotSide } from './types'

const EXCLUDED_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.pnpm-store', '.yarn'])

export interface ScannedEntry {
  canonical: string
  absolutePath: string
  side: SnapshotSide
}

export interface ScanResult {
  entries: ScannedEntry[]
  coverage: Exclude<ChangeCoverage, 'tools-only'>
  warnings: string[]
  incompleteDirs: string[]
}

export const isInside = (root: string, target: string): boolean => {
  const part = relative(root, target)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
}

export interface NormalizedRoot {
  path: string
  realPath: string
  name: string
}

/** 去重并规范化工作区根；只保留当前存在的目录根，缺失根记入警告。 */
export async function normalizeRoots(roots: readonly string[]): Promise<{
  roots: NormalizedRoot[]
  warnings: string[]
}> {
  const seen = new Set<string>()
  const result: NormalizedRoot[] = []
  const warnings: string[] = []
  for (const raw of roots) {
    const abs = resolve(raw)
    try {
      const real = await realpath(abs)
      const key = canonicalPath(real)
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ path: abs, realPath: real, name: basename(abs) || abs })
    } catch (error) {
      warnings.push(`工作区目录不可访问（${abs}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { roots: result, warnings }
}

/** 格式化显示路径：单根用根内相对路径，多根带根名，根外显示绝对路径。 */
export function formatChangePath(
  absolutePath: string,
  roots: readonly NormalizedRoot[]
): { display: string; outsideWorkspace: boolean } {
  const norm = resolve(absolutePath)
  const normCanon = canonicalPath(norm)
  for (const root of roots) {
    const rootCanon = canonicalPath(root.path)
    if (isInside(rootCanon, normCanon)) {
      const rel = relative(root.path, norm).split(sep).join('/')
      const display = roots.length === 1 ? rel : `${root.name}/${rel}`
      return { display: display || root.name, outsideWorkspace: false }
    }
  }
  return { display: norm.split(sep).join('/'), outsideWorkspace: true }
}

export async function scanWorkspaceRoots(
  roots: readonly NormalizedRoot[],
  hostRoot: string,
  capture: (absolutePath: string, signal: AbortSignal) => Promise<SnapshotSide>,
  cancelSignal: AbortSignal,
  timeoutMs = CHANGE_LIMITS.scanTimeoutMs
): Promise<ScanResult> {
  const entries: ScannedEntry[] = []
  const warnings: string[] = []
  let coverage: Exclude<ChangeCoverage, 'tools-only'> = 'complete'
  const hostCanon = canonicalPath(resolve(hostRoot))
  const seenFiles = new Set<string>()
  const incompleteDirs = new Set<string>()
  const activeDirs = new Map<string, { pending: number; truncated: boolean }>()
  const queue: Array<{ root: NormalizedRoot; dir: string; dirCanon: string; isRoot: boolean }> = roots.map((root) => ({
    root,
    dir: root.path,
    dirCanon: canonicalPath(root.path),
    isRoot: true
  }))
  const fileQueue: Array<{ childPath: string; childCanon: string; parentCanon: string }> = []
  const inFlight = new Set<Promise<void>>()

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const scanSignal = AbortSignal.any([cancelSignal, timeoutSignal])
  const isTimedOut = (): boolean => timeoutSignal.aborted
  let reservedFiles = 0
  let stoppedReason: 'none' | 'timeout' | 'limit' = 'none'

  const dispatchAvailable = (): void => {
    while (fileQueue.length > 0 && inFlight.size < CHANGE_LIMITS.concurrency && !isTimedOut()) {
      cancelSignal.throwIfAborted()
      const item = fileQueue.shift()!
      const p = (async () => {
        try {
          const side = await capture(item.childPath, scanSignal)
          if (side.kind !== 'absent') {
            if (side.kind === 'unknown' || (side.kind === 'file' && side.unreadable !== undefined)) {
              coverage = 'partial'
            }
            entries.push({ canonical: item.childCanon, absolutePath: item.childPath, side })
          }
          const dirState = activeDirs.get(item.parentCanon)
          if (dirState !== undefined) {
            dirState.pending--
            if (dirState.pending === 0 && !dirState.truncated) {
              activeDirs.delete(item.parentCanon)
            }
          }
        } catch (error) {
          if (cancelSignal.aborted) throw error
          if (isTimedOut()) {
            stoppedReason = 'timeout'
            return
          }
          throw error
        }
      })().finally(() => {
        inFlight.delete(p)
      })
      inFlight.add(p)
    }
    if (isTimedOut() && stoppedReason === 'none') {
      stoppedReason = 'timeout'
    }
  }

  while (!isTimedOut() && ((stoppedReason === 'none' && queue.length > 0) || fileQueue.length > 0 || inFlight.size > 0)) {
    cancelSignal.throwIfAborted()
    if (isTimedOut()) {
      stoppedReason = 'timeout'
      break
    }

    while (fileQueue.length === 0 && queue.length > 0 && stoppedReason === 'none') {
      cancelSignal.throwIfAborted()
      if (isTimedOut()) {
        stoppedReason = 'timeout'
        break
      }
      if (reservedFiles >= CHANGE_LIMITS.maxFiles) {
        stoppedReason = 'limit'
        break
      }
      const current = queue.shift()!
      if (isInside(hostCanon, current.dirCanon)) continue

      let dirents: Dirent[]
      try {
        dirents = await readdir(current.dir, { withFileTypes: true })
      } catch (error) {
        coverage = 'partial'
        warnings.push(`无法读取目录 ${current.dir}：${error instanceof Error ? error.message : String(error)}`)
        incompleteDirs.add(current.dirCanon)
        continue
      }

      cancelSignal.throwIfAborted()
      if (isTimedOut()) {
        incompleteDirs.add(current.dirCanon)
        stoppedReason = 'timeout'
        break
      }

      if (!current.isRoot && dirents.some((d) => d.name === '.git')) {
        warnings.push(`跳过嵌套 Git 仓库目录：${relative(current.root.path, current.dir).split(sep).join('/')}`)
        incompleteDirs.add(current.dirCanon)
        continue
      }

      let dirPending = 0
      let dirTruncated = false
      for (const dirent of dirents) {
        const childPath = join(current.dir, dirent.name)
        const childCanon = canonicalPath(childPath)
        if (isInside(hostCanon, childCanon)) continue

        if (dirent.isDirectory()) {
          if (EXCLUDED_DIRS.has(dirent.name)) continue
          queue.push({ root: current.root, dir: childPath, dirCanon: childCanon, isRoot: false })
          continue
        }

        if (seenFiles.has(childCanon)) continue
        if (reservedFiles >= CHANGE_LIMITS.maxFiles) {
          dirTruncated = true
          stoppedReason = 'limit'
          break
        }
        seenFiles.add(childCanon)
        reservedFiles++
        dirPending++
        fileQueue.push({ childPath, childCanon, parentCanon: current.dirCanon })
      }
      if (dirPending > 0 || dirTruncated) {
        activeDirs.set(current.dirCanon, { pending: dirPending, truncated: dirTruncated })
      }
    }

    dispatchAvailable()
    if (isTimedOut()) {
      stoppedReason = 'timeout'
      break
    }
    if (inFlight.size > 0 && (inFlight.size >= CHANGE_LIMITS.concurrency || (fileQueue.length === 0 && (queue.length === 0 || stoppedReason === 'limit')))) {
      await Promise.race(inFlight)
    }
  }

  if (inFlight.size > 0) {
    await Promise.allSettled(inFlight)
  }
  cancelSignal.throwIfAborted()

  if (isTimedOut() || stoppedReason === 'timeout') {
    coverage = 'partial'
    warnings.push('工作区扫描超时或被取消，改动清单可能不完整')
  } else if (stoppedReason === 'limit') {
    coverage = 'partial'
    warnings.push(`工作区文件数超过 ${CHANGE_LIMITS.maxFiles.toLocaleString()} 上限，改动清单不完整`)
  }

  for (const dirCanon of activeDirs.keys()) {
    incompleteDirs.add(dirCanon)
  }
  for (const item of queue) {
    incompleteDirs.add(item.dirCanon)
  }

  return { entries, coverage, warnings, incompleteDirs: [...incompleteDirs] }
}
