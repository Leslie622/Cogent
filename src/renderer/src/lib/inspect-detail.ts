/** 控制台复用已留存的轮终消息：完成入口定位最后一轮，正文投影不改写原始 JSON。 */
import { z } from 'zod'
import type { InspectEntrySummary } from '@/env.d'

export function inspectDetailSource(entry: InspectEntrySummary, entries: InspectEntrySummary[]): InspectEntrySummary {
  if (entry.kind !== 'run.completed') return entry
  return entries.findLast((candidate) => candidate.run === entry.run && candidate.seq < entry.seq && candidate.kind === 'turn.completed') ?? entry
}

const assistantSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('thinking'), thinking: z.string() }),
    z.object({ type: z.literal('toolCall') }),
  ])),
})

export function readAssistantText(content: string): { text: string; thinking: string; error: string | null } {
  // 旧记录可能在采集时截断；只能提示无法提取，不能把残缺 JSON 当成完整回复。
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return { text: '', thinking: '', error: '无法提取完整回复：留存消息不是完整 JSON，请查看下方原始记录。' }
  }
  const parsed = assistantSchema.safeParse(value)
  if (!parsed.success) return { text: '', thinking: '', error: '无法提取完整回复：留存消息格式不匹配，请查看下方原始记录。' }
  return {
    text: parsed.data.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    thinking: parsed.data.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join(''),
    error: null,
  }
}
