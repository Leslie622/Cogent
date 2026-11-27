/** 本轮改动列表的内部存储与快照边界类型。 */
import type { ChangeCoverage, TurnChangeItem, TurnChangesSummary } from '../../../shared/changes'

export const CHANGE_LIMITS = {
  concurrency: 8,
  maxFiles: 20_000,
  maxFileBytes: 20 * 1024 ** 2,
  maxHashBytes: 100 * 1024 ** 2,
  turnBlobBudget: 256 * 1024 ** 2,
  sessionBlobBudget: 1024 ** 3,
  scanTimeoutMs: 10_000,
  diffTimeoutMs: 1_000
} as const

export const canonicalPath = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path

export type SnapshotSide =
  | { kind: 'absent' }
  | { kind: 'file'; sha256?: string; size: number; mode: number; saved: boolean; oversized?: boolean; unreadable?: string }
  | { kind: 'symlink'; target: string; mode: number }
  | { kind: 'unknown'; reason: string }

export interface BaselineEntry {
  canonical: string
  absolutePath: string
  side: SnapshotSide
  source: 'workspace' | 'tool'
}

export interface StoredChangeEntry {
  item: TurnChangeItem
  before: SnapshotSide
  after: SnapshotSide
}

export interface TurnChangesDocument {
  summary: TurnChangesSummary
  entries: StoredChangeEntry[]
  baseline?: {
    entries: BaselineEntry[]
    coverage: ChangeCoverage
    warnings: string[]
  }
}

export interface StatCacheEntry {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  sha256: string
}
