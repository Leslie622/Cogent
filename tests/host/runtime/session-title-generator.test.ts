/** 标题模型的外部边界：纯文本、错误式返回、预算与可取消期限。 */
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { generateSessionTitle, titleFromMessage } from '../../../src/host/kernel/session-title'

const model: Model<'openai-completions'> = {
  id: 'mock', name: 'Mock', provider: 'custom/mock', api: 'openai-completions', baseUrl: 'http://localhost/v1',
  reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}
export const titleMessage = (text: string): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 24,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: 0
})
afterEach(() => vi.useRealTimers())

it('问候也生成；只发送专用指令与有限原始素材，不附工具或主上下文', async () => {
  const completeSimple = vi.fn<ModelRuntime['completeSimple']>().mockResolvedValue(titleMessage('“问候交流”\n多余说明'))
  const response = vi.fn()
  expect(await generateSessionTitle({ completeSimple }, model, '你好', new AbortController().signal, response)).toBe('问候交流')
  expect(completeSimple.mock.calls[0][1].messages).toEqual([{ role: 'user', content: '{"input":"你好"}', timestamp: completeSimple.mock.calls[0][1].messages[0].timestamp }])
  expect(completeSimple.mock.calls[0][1]).not.toHaveProperty('tools')
  expect(completeSimple.mock.calls[0][2]).toMatchObject({ maxTokens: 256, reasoning: undefined, maxRetries: 0 })
  expect(response).toHaveBeenCalledOnce()
})

it.each(['error', 'aborted', 'length', 'toolUse'] as const)('返回式 %s 不当作成功', (stopReason) => {
  expect(() => titleFromMessage({ ...titleMessage('假标题'), stopReason })).toThrow()
})
it.each(['', '  ', '\u001b[31m标题', '你'.repeat(65)])('无效文本 %j 不覆盖标题', (text) => {
  expect(() => titleFromMessage(titleMessage(text))).toThrow()
})
it('纯思考与夹带工具调用不作为标题', () => {
  expect(() => titleFromMessage({ ...titleMessage(''), content: [{ type: 'thinking', thinking: '推理内容' }] })).toThrow()
  expect(() => titleFromMessage({ ...titleMessage('标题'), content: [{ type: 'toolCall', id: 't', name: 'write', arguments: {} }] })).toThrow()
})
it('Unicode 输入按码点限制；必需思考的模型只取最低支持档', async () => {
  const completeSimple = vi.fn<ModelRuntime['completeSimple']>().mockResolvedValue(titleMessage('图片交流'))
  await generateSessionTitle({ completeSimple }, { ...model, reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' }
  }, '😀'.repeat(4_001), new AbortController().signal, () => {})
  const body = completeSimple.mock.calls[0][1].messages[0].content as string
  expect(Array.from((JSON.parse(body) as { input: string }).input)).toHaveLength(4_000)
  expect(completeSimple.mock.calls[0][2]).toMatchObject({ reasoning: 'low', maxTokens: 2048 })
})
it('超时取消且结束等待，即使供应商不响应；晚到结果不形成未处理拒绝', async () => {
  vi.useFakeTimers()
  let finish!: (value: AssistantMessage) => void
  const completeSimple = vi.fn<ModelRuntime['completeSimple']>(() => new Promise((resolve) => { finish = resolve }))
  const generation = generateSessionTitle({ completeSimple }, model, '你好', new AbortController().signal, () => {})
  const rejected = expect(generation).rejects.toThrow('20 秒')
  await vi.advanceTimersByTimeAsync(20_000)
  await rejected
  expect(completeSimple.mock.calls[0][2]!.signal!.aborted).toBe(true)
  finish(titleMessage('晚到标题'))
  await Promise.resolve()
  expect(vi.getTimerCount()).toBe(0)
})
it('主动取消与取消前启动都不会留下计时器或多发请求', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const completeSimple = vi.fn<ModelRuntime['completeSimple']>(() => new Promise(() => {}))
  const pending = generateSessionTitle({ completeSimple }, model, '你好', controller.signal, () => {})
  controller.abort(new Error('手动命名'))
  await expect(pending).rejects.toThrow('手动命名')
  await expect(generateSessionTitle({ completeSimple }, model, '你好', controller.signal, () => {})).rejects.toThrow('手动命名')
  expect(completeSimple).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('请求拒绝保留真实错误并清掉超时任务', async () => {
  vi.useFakeTimers()
  const completeSimple = vi.fn<ModelRuntime['completeSimple']>().mockRejectedValue(new Error('401 Unauthorized'))
  await expect(generateSessionTitle({ completeSimple }, model, '你好', new AbortController().signal, () => {})).rejects.toThrow('401 Unauthorized')
  expect(vi.getTimerCount()).toBe(0)
})
