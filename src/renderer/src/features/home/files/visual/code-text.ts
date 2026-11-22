/** 源码查看的坐标统一保存为原文本 UTF-16 offset；换行规范化仅用于显示。 */
import type { FileLocation } from '@shared/files'

export interface CodeSelection { anchor: number; head: number }
export interface CodeSearchQuery { search: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }
export interface CodeLine { from: number; to: number }
export interface CodeDocument { text: string; contents: string; lines: CodeLine[] }
export interface CodeMatch { from: number; to: number }
export const EMPTY_CODE_QUERY: CodeSearchQuery = { search: '', caseSensitive: false, regexp: false, wholeWord: false }

export function codeDocument(text: string): CodeDocument {
  const lines: CodeLine[] = []
  let from = 0
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ from, to: match.index })
    from = match.index + match[0].length
  }
  lines.push({ from, to: text.length })
  // Pierre 不渲染 EOF 的空行；补一个显示换行，使空文件和末尾空行仍可定位。
  const normalized = lines.map(line => text.slice(line.from, line.to)).join('\n')
  return { text, lines, contents: lines.at(-1)!.from === text.length ? normalized + '\n' : normalized }
}

export function codeLineAt(document: CodeDocument, offset: number): number {
  let low = 0, high = document.lines.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (document.lines[middle].from <= offset) low = middle
    else high = middle - 1
  }
  return low
}

export function clampCodeSelection(selection: CodeSelection, length: number): CodeSelection {
  return { anchor: Math.max(0, Math.min(length, selection.anchor)), head: Math.max(0, Math.min(length, selection.head)) }
}

export function codeLocation(document: CodeDocument, location: FileLocation): { selection: CodeSelection; status: string } | { warning: string } {
  const column = location.column ?? 1
  if (location.line < 1 || location.line > document.lines.length || (location.endLine !== undefined && (location.endLine < location.line || location.endLine > document.lines.length))) {
    return { warning: '行号超出当前文件范围，已打开文件' }
  }
  const line = document.lines[location.line - 1]
  if (column < 1 || column > line.to - line.from + 1) return { warning: '列号超出当前行范围，已打开文件' }
  const anchor = line.from + column - 1
  return {
    selection: { anchor, head: location.endLine === undefined ? anchor : document.lines[location.endLine - 1].to },
    status: location.endLine === undefined ? `已定位：第 ${location.line} 行，第 ${column} 列` : `已定位：第 ${location.line}～${location.endLine} 行`
  }
}

export function findCodeMatches(text: string, query: CodeSearchQuery): { matches: CodeMatch[]; error: string | null; truncated: boolean } {
  if (query.search === '') return { matches: [], error: null, truncated: false }
  let expression: RegExp
  try {
    expression = new RegExp(query.regexp ? query.search : query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), query.caseSensitive ? 'gu' : 'giu')
  } catch (error) {
    return { matches: [], error: error instanceof Error ? error.message : String(error), truncated: false }
  }
  const matches: CodeMatch[] = []
  const word = /[\p{L}\p{N}_]/u
  for (const match of text.matchAll(expression)) {
    const from = match.index, to = from + match[0].length
    const before = Array.from(text.slice(Math.max(0, from - 2), from)).at(-1) ?? ''
    const after = Array.from(text.slice(to, to + 2))[0] ?? ''
    if (query.wholeWord && (word.test(before) || word.test(after))) continue
    if (matches.length === 10_000) return { matches, error: null, truncated: true }
    matches.push({ from, to })
  }
  return { matches, error: null, truncated: false }
}
