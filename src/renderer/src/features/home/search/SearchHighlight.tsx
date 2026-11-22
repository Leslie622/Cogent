/** 搜索摘录只拆纯文本；不把摘要解释为 HTML 或 Markdown。 */
import type { SearchRange } from '@shared/session-search'
export function SearchHighlight({ text, ranges }: { text: string; ranges: SearchRange[] }) {
  const parts: React.ReactNode[] = []
  let offset = 0
  for (const range of ranges) {
    parts.push(text.slice(offset, range.start), <mark key={`${range.start}:${range.end}`} className="search-mark">{text.slice(range.start, range.end)}</mark>)
    offset = range.end
  }
  parts.push(text.slice(offset))
  return <>{parts}</>
}
