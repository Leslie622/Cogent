/**
 * storage-view 纯函数单测：钉字节格式化口径（1024 进制、一位小数去尾零）、
 * 顶层条目 → 展示分类的归类表、图例聚合（0 字节类不进、降序、平字节稳定）、
 * 明细两档聚合（会话转录单列 + 其余归「其他」）。UI 呈现在 StorageSection，
 * 这里只钉数据形状契约。
 */
import { describe, expect, it } from 'vitest'
import {
  buildDetail,
  buildLegend,
  categorizeEntry,
  formatBytes,
  STORAGE_CATEGORIES,
} from '@/features/settings/storage-view'
import type { StorageUsageEntry } from '@/env.d'

const KB = 1024
const MB = 1024 * 1024
const GB = 1024 * 1024 * 1024

const entry = (name: string, bytes: number, dir = true): StorageUsageEntry => ({ name, dir, bytes })

describe('formatBytes', () => {
  it('零与字节档', () => {
    expect(formatBytes(0)).toBe('0 字节')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('一位小数去尾零（参考稿口径：745.4 MB 与 1 GB 并存）', () => {
    expect(formatBytes(KB)).toBe('1 KB')
    expect(formatBytes(1.5 * KB)).toBe('1.5 KB')
    expect(formatBytes(305.2 * MB)).toBe('305.2 MB')
    expect(formatBytes(2 * GB)).toBe('2 GB')
  })

  it('封顶 TB 不越界', () => {
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 TB')
  })
})

describe('categorizeEntry', () => {
  it('已知目录整名归类，其余（文件与未知目录）归 other', () => {
    expect(categorizeEntry('sessions')).toBe('sessions')
    expect(categorizeEntry('attachments')).toBe('attachments')
    expect(categorizeEntry('inspect')).toBe('inspect')
    expect(categorizeEntry('pi')).toBe('engine')
    expect(categorizeEntry('settings.json')).toBe('other')
    expect(categorizeEntry('projects')).toBe('other')
  })
})

describe('buildLegend', () => {
  it('按分类聚合、降序；0 字节类不进图例', () => {
    const legend = buildLegend([
      entry('sessions', 100),
      entry('inspect', 500),
      entry('settings.json', 50, false),
      entry('attachments', 0),
    ])
    expect(legend.map((item) => item.id)).toEqual(['inspect', 'sessions', 'other'])
    expect(legend.map((item) => item.bytes)).toEqual([500, 100, 50])
    expect(legend.every((item) => STORAGE_CATEGORIES[item.id].label === item.label)).toBe(true)
  })

  it('空快照（首启 0 字节）出空图例，不画空段', () => {
    expect(buildLegend([])).toEqual([])
  })
})

describe('buildDetail 明细两档', () => {
  it('会话转录单列，其余（附件/观测日志/引擎数据/杂项）聚合成「其他」', () => {
    expect(
      buildDetail([
        entry('sessions', 100),
        entry('attachments', 50),
        entry('inspect', 500),
        entry('pi', 200),
        entry('settings.json', 10, false),
      ]),
    ).toEqual([
      { label: STORAGE_CATEGORIES.sessions.label, bytes: 100 },
      { label: '其他', bytes: 760 },
    ])
  })

  it('0 字节档不进：空快照出空明细，sessions 为 0 时只出「其他」', () => {
    expect(buildDetail([])).toEqual([])
    expect(buildDetail([entry('sessions', 0), entry('inspect', 30)])).toEqual([
      { label: '其他', bytes: 30 },
    ])
  })
})
