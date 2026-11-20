/**
 * 存储分区的纯呈现逻辑（archive-view 同款定位）：main 的 storage:usage 只回
 * 顶层条目字节数的事实，归类成展示分类、明细两档聚合、字节格式化都在这里，
 * 单测钉行为。归类学 zcode storageCatalog（前缀规则单一事实源），但 ~/.cogent
 * 顶层布局小而稳定（见 docs/模块/工作区与项目.md 存储根一节），按整目录名
 * 归类即可。
 */
import type { StorageUsageEntry } from '@/env.d'

/** 展示分类 id：与存储根顶层目录一一对应，其余（配置文件 / projects / sounds…）归 other */
export type StorageCategoryId = 'sessions' | 'attachments' | 'inspect' | 'engine' | 'other'

/**
 * 分类元数据：label 供图例与 aria，swatch 是分段条/图例圆点的底色类。
 * 分类着色是设置页唯一的多色图表点 —— 前四类用固定色相保证可分辨，
 * other 用主题灰 token（它语义上是「余量」，不属于数据类别）；
 * 深色档提亮一档保持对比（amber/blue/violet 400）
 */
export const STORAGE_CATEGORIES: Record<StorageCategoryId, { label: string; swatch: string }> = {
  sessions: { label: '会话转录', swatch: 'bg-amber-400 dark:bg-amber-500' },
  attachments: { label: '附件', swatch: 'bg-emerald-500 dark:bg-emerald-400' },
  inspect: { label: '观测日志', swatch: 'bg-blue-500 dark:bg-blue-400' },
  engine: { label: '引擎数据', swatch: 'bg-violet-500 dark:bg-violet-400' },
  other: { label: '配置与其他', swatch: 'bg-muted-foreground/40' },
}

/** 顶层条目名 → 分类（整目录名匹配；文件与未知目录归 other） */
const CATEGORY_BY_NAME: Record<string, StorageCategoryId> = {
  sessions: 'sessions',
  attachments: 'attachments',
  inspect: 'inspect',
  pi: 'engine'
}

export function categorizeEntry(name: string): StorageCategoryId {
  return CATEGORY_BY_NAME[name] ?? 'other'
}

/** 图例项（也承载分段条的段） */
export interface StorageLegendItem {
  id: StorageCategoryId
  label: string
  bytes: number
  swatch: string
}

/**
 * 分类聚合 → 图例/分段条数据：0 字节类不进（空类没有可画的段），
 * 按 bytes 降序（大头在前），平字节时保持 STORAGE_CATEGORIES 声明序
 * （聚合遍历枚举序，Map 保插入序实现这一点）
 */
export function buildLegend(entries: StorageUsageEntry[]): StorageLegendItem[] {
  const totals = new Map<StorageCategoryId, number>()
  for (const id of Object.keys(STORAGE_CATEGORIES) as StorageCategoryId[]) totals.set(id, 0)
  for (const entry of entries) {
    const id = categorizeEntry(entry.name)
    totals.set(id, (totals.get(id) ?? 0) + entry.bytes)
  }
  return [...totals.entries()]
    .filter(([, bytes]) => bytes > 0)
    .map(([id, bytes]) => ({ id, ...STORAGE_CATEGORIES[id], bytes }))
    .sort((a, b) => b.bytes - a.bytes)
}

/**
 * 明细行（给用户看的两档，2026-11-20 用户定调）：会话转录单列 —— 用户自己
 * 的数据值得单独一眼；其余（附件 / 观测日志 / 引擎数据 / 配置杂项）聚合为
 * 「其他」，不铺内部条目清单。0 字节档不进（空档没有可报的数）
 */
export interface StorageDetailRow {
  label: string
  bytes: number
}

export function buildDetail(entries: StorageUsageEntry[]): StorageDetailRow[] {
  let sessions = 0
  let rest = 0
  for (const entry of entries) {
    if (categorizeEntry(entry.name) === 'sessions') sessions += entry.bytes
    else rest += entry.bytes
  }
  const rows: StorageDetailRow[] = []
  if (sessions > 0) rows.push({ label: STORAGE_CATEGORIES.sessions.label, bytes: sessions })
  if (rest > 0) rows.push({ label: '其他', bytes: rest })
  return rows
}

/**
 * 字节格式化（1024 进制）：0 字节 / 512 B / 1 KB / 305.2 MB / 2 GB。
 * 一位小数、整值去尾零 —— 参考稿口径（745.4 MB、1 GB 并存），
 * tabular-nums 由调用处负责，这里只出文本
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 字节'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // B 档取整；以上一位小数并去尾零（2.0 GB → 2 GB）
  const text = unit === 0 ? String(value) : value.toFixed(1).replace(/\.0$/, '')
  return `${text} ${units[unit]}`
}
