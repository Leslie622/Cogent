/** 外部模型流只有明确完成才能报成功；挂起的流必须超时并收到取消信号。 */
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testModelConnectivity } from '../../../src/host/runtime/model-connectivity'

const model: Model<'openai-completions'> = {
  id: 'mock', name: 'Mock', provider: 'custom/mock', api: 'openai-completions',
  baseUrl: 'http://localhost/v1', reasoning: false, input: ['text'],
  contextWindow: 4096, maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}
const message: AssistantMessage = {
  role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: 0
}
afterEach(() => vi.useRealTimers())

describe('独立模型探测', () => {
  it('使用最小提示与模型允许的预算，正常完成后清理计时器', async () => {
    vi.useFakeTimers()
    const stream = createAssistantMessageEventStream()
    stream.push({ type: 'done', reason: 'stop', message })
    const streamSimple = vi.fn(() => stream)
    expect(await testModelConnectivity({ streamSimple }, model)).toEqual({ elapsedMs: 0 })
    expect(streamSimple.mock.calls[0]).toEqual([model, {
      systemPrompt: 'You are Cogent connectivity probe.',
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }]
    }, expect.objectContaining({ maxTokens: 256, maxRetries: 0, reasoning: undefined })])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('接口错误保留可诊断信息，不作为正常回复', async () => {
    const stream = createAssistantMessageEventStream()
    stream.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: '401 Invalid API key' } })
    await expect(testModelConnectivity({ streamSimple: () => stream }, model)).rejects.toThrow('401 Invalid API key')
  })

  it('没有完成事件的流明确失败', async () => {
    const stream = createAssistantMessageEventStream()
    stream.end()
    await expect(testModelConnectivity({ streamSimple: () => stream }, model)).rejects.toThrow('完成前结束')
  })

  it('60 秒取消请求并结束等待，即使上游没有回送取消事件', async () => {
    vi.useFakeTimers()
    const stream = createAssistantMessageEventStream()
    const streamSimple = vi.fn<Parameters<typeof testModelConnectivity>[0]['streamSimple']>(() => stream)
    const probe = testModelConnectivity({ streamSimple }, model)
    const rejection = expect(probe).rejects.toThrow('模型测试超时（60 秒）')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejection
    expect(streamSimple.mock.calls[0][2]!.signal!.aborted).toBe(true)
    stream.end()
    expect(vi.getTimerCount()).toBe(0)
  })
})
