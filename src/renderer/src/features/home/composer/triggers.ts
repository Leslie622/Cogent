/**
 * 输入区触发符解析与候选模糊匹配（纯函数，无 DOM/Lexical 依赖）。
 * - `/` 唤起命令+技能面板；
 * - `$`、`¥`(U+00A5)、`￥`(U+FFE5) 均归一为 `$` 唤起技能面板（兼容中文输入法 Shift+4）；
 * - `@` 唤起当前作用域下 MCP 资源，不把普通邮箱或正文标签当结构化引用。
 */
import type { ActiveTrigger, ComposerSuggestionItem, TriggerKind } from './types'

const ACTIVE_TRIGGER_RE = /(?:^|[\s\uFFFC])([/@$¥￥])([^\s/@$¥￥]*)$/

function normalizeTrigger(raw: string): TriggerKind {
  return raw === '/' ? '/' : raw === '@' ? '@' : '$'
}

/**
 * 从当前文本节点的光标前切片提取活跃触发词。
 * 仅在行首、空白字符或实体哨兵 `\uFFFC` 之后触发，避免网址（`https://`）或正文词中误弹。
 */
export function extractActiveTrigger(textBeforeCursor: string): ActiveTrigger | null {
  const match = ACTIVE_TRIGGER_RE.exec(textBeforeCursor)
  if (match === null) return null
  const rawTrigger = match[1]
  const query = match[2]
  const end = textBeforeCursor.length
  const start = end - query.length - rawTrigger.length
  return {
    kind: normalizeTrigger(rawTrigger),
    query,
    start,
    end
  }
}

export function triggerSignature(trigger: ActiveTrigger | null): string | null {
  if (trigger === null) return null
  // anchorKey 参与签名：start 是节点内相对偏移，删掉重输的触发词与被关闭的那次同形，
  // 必须靠节点身份区分，否则抑制签名会命中后来重新输入的触发词。
  return `${trigger.kind}:${trigger.anchorKey ?? ''}:${trigger.start}:${trigger.query}`
}

function scoreText(text: string, query: string): number | null {
  const target = text.trim().toLowerCase()
  const needle = query.trim().toLowerCase()
  if (target.length === 0) return null
  if (needle.length === 0) return 0
  if (target.startsWith(needle)) return target.length - needle.length
  const idx = target.indexOf(needle)
  if (idx !== -1) return 100 + idx
  let score = 200
  let cursor = 0
  for (const ch of needle) {
    const found = target.indexOf(ch, cursor)
    if (found === -1) return null
    score += found - cursor
    cursor = found + 1
  }
  return score + (target.length - needle.length)
}

export function scoreSuggestion(item: ComposerSuggestionItem, query: string): number | null {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length === 0) return 0
  const bareLabel = item.label.replace(/^[/@$]/, '')
  const scores: number[] = []
  const bare = scoreText(bareLabel, trimmed)
  if (bare !== null) scores.push(bare)
  const full = scoreText(item.label, trimmed)
  if (full !== null) scores.push(full + 20)
  for (const keyword of item.keywords) {
    const kw = scoreText(keyword, trimmed)
    if (kw !== null) scores.push(kw + 150)
  }
  const desc = scoreText(item.description, trimmed)
  if (desc !== null) scores.push(desc + 300)
  if (scores.length === 0) return null
  return Math.min(...scores)
}

/**
 * 过滤候选并保持分组展示序（命令组在前，技能组在后），组内按相关性排序。
 */
export function filterSuggestions(
  items: readonly ComposerSuggestionItem[],
  query: string
): ComposerSuggestionItem[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return [...items]
  const scored: Array<{ item: ComposerSuggestionItem; score: number; order: number }> = []
  items.forEach((item, order) => {
    const score = scoreSuggestion(item, trimmed)
    if (score !== null) scored.push({ item, score, order })
  })
  scored.sort((a, b) => {
    const groups = { command: 0, skill: 1, 'mcp-prompt': 2, 'mcp-resource': 3 }
    if (a.item.group !== b.item.group) return groups[a.item.group] - groups[b.item.group]
    if (a.score !== b.score) return a.score - b.score
    return a.order - b.order
  })
  return scored.map((entry) => entry.item)
}

/**
 * 返回跨分组全局匹配度最高的候选下标，用于面板初始高亮；无查询时落在首项 0。
 */
export function bestSuggestionIndex(items: readonly ComposerSuggestionItem[], query: string): number {
  if (items.length === 0) return -1
  const trimmed = query.trim()
  if (trimmed.length === 0) return 0
  let bestIdx = 0
  let bestScore = Number.POSITIVE_INFINITY
  items.forEach((item, index) => {
    const score = scoreSuggestion(item, trimmed)
    if (score !== null && score < bestScore) {
      bestScore = score
      bestIdx = index
    }
  })
  return bestIdx
}
