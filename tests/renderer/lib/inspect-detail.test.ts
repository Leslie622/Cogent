/** 控制台正文提取只读持久化边界，跨 run 不借用回复，截断数据明确报错。 */
import { describe, expect, it } from 'vitest'
import { inspectDetailSource, readAssistantText } from '@/lib/inspect-detail'
import type { InspectEntrySummary } from '@/env.d'

const entry = (seq: number, run: number, kind: InspectEntrySummary['kind']): InspectEntrySummary => ({
  seq, run, kind, title: kind, ts: 1234, hasDetail: kind === 'turn.completed',
})

describe('控制台完整回复', () => {
  it('完成入口只选本 run、终态之前最后一轮，不跨 run 或跳过无详情的最后一轮', () => {
    const last = entry(4, 1, 'turn.completed')
    const completed = entry(5, 1, 'run.completed')
    const entries = [entry(1, 1, 'run.started'), entry(2, 1, 'turn.completed'), last, completed, entry(6, 2, 'turn.completed')]
    expect(inspectDetailSource(completed, entries)).toBe(last)
    expect(inspectDetailSource(last, entries)).toBe(last)
    expect(inspectDetailSource(completed, [entries[4], completed])).toBe(completed)
    const missing = { ...last, hasDetail: false }
    expect(inspectDetailSource(completed, [entries[1], missing, completed])).toBe(missing)
  })

  it('正文按块顺序拼接，保留换行、反引号及 Markdown 转义，思考与工具参数不混入', () => {
    const text = '`![图片](图片.png)`\n`[未随附](未随附.txt)`\n\\[字面方括号\\]'
    const result = readAssistantText(JSON.stringify({ role: 'assistant', content: [
      { type: 'thinking', thinking: '思考' },
      { type: 'text', text: text.slice(0, 10) },
      { type: 'toolCall', name: 'read', arguments: { text: '不是正文' } },
      { type: 'text', text: text.slice(10) },
    ] }))
    expect(result).toEqual({ text, thinking: '思考', error: null })
  })

  it('截断、不匹配或非 assistant 消息明确报错；纯工具轮不捏造正文', () => {
    for (const content of ['{"role":"assistant","content":[\n…[已截断，原始 400000 字符]', '{}', '{"role":"user","content":[]}']) {
      const result = readAssistantText(content)
      expect(result.text).toBe('')
      expect(result.thinking).toBe('')
      expect(result.error).toContain('无法提取完整回复')
    }
    expect(readAssistantText('{"role":"assistant","content":[{"type":"toolCall"}]}')).toEqual({ text: '', thinking: '', error: null })
  })
})
