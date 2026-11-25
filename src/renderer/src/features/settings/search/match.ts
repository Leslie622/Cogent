/**
 * 设置搜索纯函数匹配器：
 *   - NFKC 归一化、忽略英文大小写、折叠空白；不把输入当正则表达式
 *   - 空格分隔多关键词 AND 命中（支持跨标题/别名/路径组合匹配，如「外观 字体」）
 *   - 优先级：标题 > 别名 > 路径 > 说明（desc），同级按原始顺序稳定排序
 *   - 页面入口与配置项分开统计、各自去重，左侧按两者section合集过滤并隐藏空分组
 */
import type { SettingsSectionId } from '@/stores/settings'
import {
  SETTING_ITEM_ENTRIES,
  SETTING_PAGE_ENTRIES,
  type SearchEnvironment,
  type SettingItemEntry,
  type SettingPageEntry,
} from './catalog'

export type MatchField = 'title' | 'alias' | 'path' | 'desc'

export interface SettingSearchResult {
  entry: SettingItemEntry
  /** 最强命中字段（决定排序优先级与副说明展示） */
  primaryMatch: MatchField
  /** 若仅通过别名命中，展示匹配到的别名，不改写真实配置项名称 */
  matchedAlias?: string
  score: number
}

export interface PageSearchResult {
  entry: SettingPageEntry
  primaryMatch: Exclude<MatchField, 'desc'>
  matchedAlias?: string
  score: number
}

export interface SettingsSearchOutput {
  tokens: string[]
  items: SettingSearchResult[]
  pages: PageSearchResult[]
  matchedSectionIds: Set<SettingsSectionId>
}

export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeSearchText(query)
  if (normalized === '') return []
  return normalized.split(' ').filter(Boolean)
}

const FIELD_RANK: Record<MatchField, number> = {
  title: 400,
  alias: 300,
  path: 200,
  desc: 100,
}

function matchTokens(
  tokens: string[],
  fields: { title: string; aliases: readonly string[]; path: string; desc?: string },
): { primaryMatch: MatchField; matchedAlias?: string; score: number } | null {
  const normTitle = normalizeSearchText(fields.title)
  const normAliases = fields.aliases.map((a) => ({ raw: a, norm: normalizeSearchText(a) }))
  const normPath = normalizeSearchText(fields.path)
  const normDesc = fields.desc !== undefined ? normalizeSearchText(fields.desc) : ''

  let bestField: MatchField | null = null
  let bestScore = -1
  let matchedAlias: string | undefined

  for (const token of tokens) {
    let tokenRank = -1
    let tokenAlias: string | undefined

    if (normTitle.includes(token)) {
      // 精确匹配与前缀匹配略微加权，仍保持在同阶内
      const bonus = normTitle === token ? 30 : normTitle.startsWith(token) ? 15 : 0
      tokenRank = FIELD_RANK.title + bonus
      if (bestField === null || tokenRank > bestScore) bestField = 'title'
    } else {
      const hitAlias = normAliases.find((a) => a.norm.includes(token))
      if (hitAlias) {
        const bonus = hitAlias.norm === token ? 20 : 0
        tokenRank = FIELD_RANK.alias + bonus
        tokenAlias = hitAlias.raw
        if (bestField === null || tokenRank > bestScore) {
          bestField = 'alias'
          matchedAlias = hitAlias.raw
        }
      } else if (normPath.includes(token)) {
        tokenRank = FIELD_RANK.path
        if (bestField === null || tokenRank > bestScore) bestField = 'path'
      } else if (normDesc !== '' && normDesc.includes(token)) {
        tokenRank = FIELD_RANK.desc
        if (bestField === null || tokenRank > bestScore) bestField = 'desc'
      } else {
        // AND 约束：任一关键词未命中则整体不匹配
        return null
      }
    }

    if (tokenRank > bestScore) {
      bestScore = tokenRank
      if (tokenAlias !== undefined && bestField === 'alias') matchedAlias = tokenAlias
    }
  }

  if (bestField === null) return null
  return {
    primaryMatch: bestField,
    matchedAlias: bestField === 'alias' ? matchedAlias : undefined,
    score: bestScore,
  }
}

export function searchSettings(
  query: string,
  env: SearchEnvironment = {},
): SettingsSearchOutput {
  const tokens = tokenizeSearchQuery(query)
  const matchedSectionIds = new Set<SettingsSectionId>()
  if (tokens.length === 0) {
    return { tokens, items: [], pages: [], matchedSectionIds }
  }

  const items: SettingSearchResult[] = []
  for (const entry of SETTING_ITEM_ENTRIES) {
    if (entry.isVisible && !entry.isVisible(env)) continue
    const hit = matchTokens(tokens, {
      title: entry.title,
      aliases: entry.aliases,
      path: entry.path,
      desc: entry.desc,
    })
    if (!hit) continue
    items.push({ entry, ...hit })
    matchedSectionIds.add(entry.section)
  }

  items.sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)

  const pages: PageSearchResult[] = []
  for (const entry of SETTING_PAGE_ENTRIES) {
    const hit = matchTokens(tokens, {
      title: entry.title,
      aliases: entry.aliases,
      path: entry.path,
    })
    if (!hit || hit.primaryMatch === 'desc') continue
    pages.push({
      entry,
      primaryMatch: hit.primaryMatch,
      matchedAlias: hit.matchedAlias,
      score: hit.score,
    })
    matchedSectionIds.add(entry.section)
  }

  pages.sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)

  return { tokens, items, pages, matchedSectionIds }
}

/** 切分文本以高亮命中关键词（大小写不敏感，非正则转义） */
export function splitHighlightSegments(
  text: string,
  tokens: readonly string[],
): Array<{ text: string; matched: boolean }> {
  if (text === '' || tokens.length === 0) return [{ text, matched: false }]
  const lower = text.toLowerCase()
  const ranges: Array<[number, number]> = []

  for (const rawToken of tokens) {
    const token = rawToken.toLowerCase()
    if (token === '') continue
    let from = 0
    while (from < lower.length) {
      const idx = lower.indexOf(token, from)
      if (idx === -1) break
      ranges.push([idx, idx + token.length])
      from = idx + token.length
    }
  }

  if (ranges.length === 0) return [{ text, matched: false }]
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  // 合并重叠区间
  const merged: Array<[number, number]> = []
  for (const [start, end] of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end)
    } else {
      merged.push([start, end])
    }
  }

  const result: Array<{ text: string; matched: boolean }> = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) result.push({ text: text.slice(cursor, start), matched: false })
    result.push({ text: text.slice(start, end), matched: true })
    cursor = end
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor), matched: false })
  return result
}
