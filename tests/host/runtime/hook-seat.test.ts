/** 请求取消包装的契约回归：保留pi准备结果/错误，阻止已取消或等待中被取消的后续请求。 */
import type { PrepareRequestContext } from '@earendil-works/pi-agent-core'
import { describe, expect, it, vi } from 'vitest'
import { wrapRequestCancellation } from '../../../src/host/runtime/hook-seat'

const request: PrepareRequestContext = {
  context: { messages: [] },
  thinkingLevel: 'off',
  model: {
    id: 'test', name: 'test', api: 'openai-completions', provider: 'test',
    baseUrl: 'http://127.0.0.1', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000, maxTokens: 100
  }
}

describe('请求准备的取消接力', () => {
  it('已取消时不运行原准备钩子', async () => {
    const abort = new AbortController()
    const reason = new Error('已停止')
    abort.abort(reason)
    const original = vi.fn()
    await expect(wrapRequestCancellation(original)(request, abort.signal)).rejects.toBe(reason)
    expect(original).not.toHaveBeenCalled()
  })

  it('等待原钩子期间停止，返回结果不能继续交付', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const abort = new AbortController()
    const original = vi.fn(() => blocked)
    const running = wrapRequestCancellation(original)(request, abort.signal)
    expect(original).toHaveBeenCalledWith(request, abort.signal)
    const reason = new Error('等待期间已停止')
    abort.abort(reason)
    release()
    await expect(running).rejects.toBe(reason)
  })

  it('未取消时原准备结果与对象身份保持', async () => {
    const update = { context: { messages: [] } }
    const original = vi.fn(() => update)
    await expect(wrapRequestCancellation(original)(request)).resolves.toBe(update)
    expect(original).toHaveBeenCalledOnce()
  })

  it('原钩子的真实错误不被包装成取消', async () => {
    const error = new Error('上下文准备失败')
    await expect(wrapRequestCancellation(() => Promise.reject<undefined>(error))(request)).rejects.toBe(error)
    await expect(wrapRequestCancellation(undefined)(request)).resolves.toBeUndefined()
  })
})
