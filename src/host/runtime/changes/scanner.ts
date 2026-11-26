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
}

const isInside = (root: string, target: string): boolean => {
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
  capture: (absolutePath: string) => Promise<SnapshotSide>,
  signal: AbortSignal
): Promise<ScanResult> {
  const entries: ScannedEntry[] = []
  const warnings: string[] = []
  let coverage: Exclude<ChangeCoverage, 'tools-only'> = 'complete'
  const hostCanon = canonicalPath(resolve(hostRoot))
  const seenFiles = new Set<string>()
  const queue: Array<{ root: NormalizedRoot; dir: string; isRoot: boolean }> = roots.map((root) => ({
    root,
    dir: root.path,
    isRoot: true
  }))

  const isAborted = (): boolean => signal.aborted

  while (queue.length > 0) {
    if (isAborted()) {
      coverage = 'partial'
      warnings.push('工作区扫描超时或被取消，改动清单可能不完整')
      break
    }
    if (entries.length >= CHANGE_LIMITS.maxFiles) {
      coverage = 'partial'
      warnings.push(`工作区文件数超过 ${CHANGE_LIMITS.maxFiles.toLocaleString()} 上限，改动清单不完整`)
      break
    }
    const current = queue.shift()!
    if (isInside(hostCanon, canonicalPath(current.dir))) continue

    let dirents: Dirent[]
    try {
      dirents = await readdir(current.dir, { withFileTypes: true })
    } catch (error) {
      coverage = 'partial'
      warnings.push(`无法读取目录 ${current.dir}：${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    if (!current.isRoot && dirents.some((d) => d.name === '.git')) {
      warnings.push(`跳过嵌套 Git 仓库目录：${relative(current.root.path, current.dir).split(sep).join('/')}`)
      continue
    }

    for (const dirent of dirents) {
      if (isAborted() || entries.length >= CHANGE_LIMITS.maxFiles) break
      const childPath = join(current.dir, dirent.name)
      const childCanon = canonicalPath(childPath)
      if (isInside(hostCanon, childCanon)) continue

      if (dirent.isDirectory()) {
        if (EXCLUDED_DIRS.has(dirent.name)) continue
        queue.push({ root: current.root, dir: childPath, isRoot: false })
        continue
      }

      if (seenFiles.has(childCanon)) continue
      seenFiles.add(childCanon)
      const side = await capture(childPath)
      if (side.kind === 'absent') continue
      if (side.kind === 'unknown' || (side.kind === 'file' && side.unreadable !== undefined)) {
        coverage = 'partial'
      }
      entries.push({ canonical: childCanon, absolutePath: childPath, side })
    }
  }

  return { entries, coverage, warnings }
}
