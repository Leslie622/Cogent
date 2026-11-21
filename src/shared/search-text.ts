/** 搜索与安全高亮共用字面匹配；Unicode 大小写展开后仍能映射回原文 UTF-16 区间。 */
import type { SearchRange } from './session-search'

export function searchTokens(query: string): string[] {
  const balanced = (query.match(/"/g) ?? []).length % 2 === 0
  const parts = balanced ? query.match(/"[^"]+"|[^\s"]+/gu) ?? [] : query.split(/\s+/u)
  return [...new Set(parts.map((part) => normalizeSearchText(balanced && part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part).text).filter((part) => part !== ''))]
}

export function normalizeSearchText(text: string): { text: string; starts: number[]; ends: number[] } {
  let normalized = ''
  const starts: number[] = [], ends: number[] = []
  let offset = 0
  for (const character of text) {
    const lower = character.toLowerCase()
    normalized += lower
    for (let i = 0; i < lower.length; i++) { starts.push(offset); ends.push(offset + character.length) }
    offset += character.length
  }
  return { text: normalized, starts, ends }
}

export function matchSearchText(text: string, tokens: string[]): SearchRange[] {
  if (tokens.length === 0) return []
  const folded = normalizeSearchText(text)
  if (!tokens.every((token) => folded.text.includes(token))) return []
  const ranges: SearchRange[] = []
  for (const token of tokens) {
    let start = folded.text.indexOf(token)
    while (start !== -1) {
      ranges.push({ start: folded.starts[start], end: folded.ends[start + token.length - 1] })
      start = folded.text.indexOf(token, start + token.length)
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: SearchRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous !== undefined && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

export function searchSnippet(text: string, ranges: SearchRange[], center = ranges[0].start): { snippet: string; ranges: SearchRange[] } {
  const start = Math.max(0, center - 48), end = Math.min(text.length, center + 130)
  const prefix = start > 0 ? '…' : ''
  return {
    snippet: prefix + text.slice(start, end) + (end < text.length ? '…' : ''),
    ranges: ranges.filter((range) => range.start < end && range.end > start)
      .map((range) => ({ start: Math.max(range.start, start) - start + prefix.length, end: Math.min(range.end, end) - start + prefix.length }))
  }
}
