/** MCP 交互验证用户输入、会话隔离及取消收尾，不依赖浏览器或远程服务。 */
import { describe, expect, it, vi } from 'vitest'
import { McpElicitationService, isMcpBrowserUrl } from '../../../src/host/runtime/mcp-elicitation'
import type { McpElicitationRequest } from '../../../src/protocol'

describe('MCP elicitation', () => {
  it('超时仅收口一次，后续会话取消与重复回答不能恢复请求', async () => {
    vi.useFakeTimers()
    try {
      const notify = vi.fn(), resolved = vi.fn()
      const service = new McpElicitationService(notify, resolved, 100)
      const waiting = service.request({ message: '填写', requestedSchema: { type: 'object', properties: {} } }, { server: 's', sessionId: 'a' })
      const request = service.list('a')[0]
      await vi.advanceTimersByTimeAsync(100)
      await expect(waiting).resolves.toEqual({ action: 'cancel' })
      service.cancelSession('a')
      service.dispose()
      expect(resolved).toHaveBeenCalledOnce()
      expect(() => service.respond({ requestId: request.requestId, action: 'accept', content: {} })).toThrow('已完成')
    } finally { vi.useRealTimers() }
  })
  it('错误答案不消费挂起请求，合法答案只返回声明字段', async () => {
    let request: McpElicitationRequest | undefined
    const resolved = vi.fn()
    const service = new McpElicitationService((value) => { request = value }, resolved)
    const waiting = service.request({ message: '选择区域', requestedSchema: { type: 'object', properties: { region: { type: 'string', enum: ['tw', 'us'] }, seats: { type: 'integer', minimum: 1 } }, required: ['region'] } }, { server: 'example', sessionId: 'session-a' })
    expect(service.list('session-b')).toEqual([])
    expect(() => service.respond({ requestId: request!.requestId, action: 'accept', content: { region: 'other' } })).toThrow('字段要求')
    expect(service.list('session-a')).toHaveLength(1)
    service.respond({ requestId: request!.requestId, action: 'accept', content: { region: 'tw', seats: 2 } })
    await expect(waiting).resolves.toEqual({ action: 'accept', content: { region: 'tw', seats: 2 } })
    expect(resolved).toHaveBeenCalledOnce()
    expect(() => service.respond({ requestId: request!.requestId, action: 'decline' })).toThrow('已完成')
  })
  it('没有明确调用会话时取消；会话中止解除挂起并移除请求', async () => {
    const notify = vi.fn()
    const service = new McpElicitationService(notify, vi.fn())
    await expect(service.request({}, { server: 'example' })).resolves.toEqual({ action: 'cancel' })
    expect(notify).not.toHaveBeenCalled()
    const controller = new AbortController()
    const waiting = service.request({ mode: 'url', message: '授权', url: 'https://example.com/auth', elicitationId: 'auth-a' }, { server: 'example', sessionId: 'session-a', signal: controller.signal })
    controller.abort()
    await expect(waiting).resolves.toEqual({ action: 'cancel' })
    expect(service.list('session-a')).toEqual([])
  })
  it('只取消指定会话，退出收口其余请求', async () => {
    const service = new McpElicitationService(vi.fn(), vi.fn())
    const params = { message: '确认', requestedSchema: { type: 'object', properties: {} } }
    const a = service.request(params, { server: 's', sessionId: 'a' })
    const b = service.request(params, { server: 's', sessionId: 'b' })
    service.cancelSession('a')
    await expect(a).resolves.toEqual({ action: 'cancel' })
    expect(service.list('b')).toHaveLength(1)
    service.dispose()
    await expect(b).resolves.toEqual({ action: 'cancel' })
  })
  it('危险URL与不支持的schema在展示前拒绝', () => {
    const notify = vi.fn()
    const service = new McpElicitationService(notify, vi.fn())
    expect(() => service.request({ mode: 'url', message: 'open', url: 'file:///C:/private', elicitationId: 'a' }, { server: 's', sessionId: 'a' })).toThrow('不允许')
    expect(() => service.request({ message: 'secret', requestedSchema: { type: 'object', properties: { password: { type: 'object' } } } }, { server: 's', sessionId: 'a' })).toThrow('类型')
    expect(notify).not.toHaveBeenCalled()
    expect(isMcpBrowserUrl('https://user:pass@example.com')).toBe(false)
    expect(isMcpBrowserUrl('http://example.com')).toBe(false)
    expect(isMcpBrowserUrl('http://127.0.0.1:1234/auth')).toBe(true)
  })
})
