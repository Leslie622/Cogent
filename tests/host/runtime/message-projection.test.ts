/** 直播与历史消费同一工具结果，截取方向与换行合同各自独立。 */
import { expect, it } from 'vitest'
import { summarizeToolResult, tailToolResult } from '../../../src/host/runtime/message-projection'

it('工具直播保留最新行，完成摘要仍从开头取单行', () => {
  const text = `开始\n${'中间输出\n'.repeat(501)}最近一行\n最后一行\n`
  const result = { content: [{ type: 'text', text }] }

  const tail = tailToolResult(result)
  expect(tail).toHaveLength(2000)
  expect(tail).toMatch(/最近一行\n最后一行$/)
  expect(tail).not.toContain('开始')

  const summary = summarizeToolResult(result)
  expect(summary).toHaveLength(201)
  expect(summary).toMatch(/^开始 中间输出.*…$/)
  expect(summary).not.toContain('最近一行')
})

it('工具直播左边界跳过被截断的 emoji 并保留能完整容纳的 emoji', () => {
  const tail = '字'.repeat(1999)
  expect(tailToolResult({ content: [{ type: 'text', text: `🙂${tail}` }] })).toBe(tail)
  const fitted = `🙂${tail.slice(1)}`
  expect(tailToolResult({ content: [{ type: 'text', text: `旧${fitted}` }] })).toBe(fitted)
})
