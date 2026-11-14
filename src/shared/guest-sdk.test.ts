/**
 * guest-sdk 单测：钉凭证链（票据→token→Bearer）与事件分发行为。
 * fetch/WebSocket 全部注入假实现，不碰真网络 —— 真链路由
 * tests/integration/http-auth.test.ts（Host 侧）与手动 webview 验收覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import { createGuestSdk, type GuestCredentials } from './guest-sdk'

const credentials: GuestCredentials = { ticket: 'TICKET', httpPort: 58000, scope: 'write' }

interface FakeWs {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

function makeFakeTransport() {
  const ws: FakeWs = { onopen: null, onmessage: null, onclose: null, onerror: null }
  let lastWsUrl = ''
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  // 默认 fetch 行为：exchange 成功、rpc 回显 result
  let rpcResponder: ((body: string) => unknown) | null = null
  const fetchImpl = vi.fn((url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url)
    fetchCalls.push({ url: href, init: init ?? {} })
    // RequestInit.body 在本测试恒为字符串（SDK 只发 JSON.stringify）
    const bodyText = (init?.body ?? '') as string
    if (href.endsWith('/auth/exchange')) {
      return Promise.resolve(new Response(JSON.stringify({ token: 'TOKEN', scope: 'write' }), { status: 200 }))
    }
    if (href.endsWith('/rpc')) {
      const body = rpcResponder?.(bodyText) ?? { jsonrpc: '2.0', id: 1, result: { ok: true } }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  })
  // 回调经 getter/setter 转发到共享 ws 对象：SDK 挂在实例上，测试从共享对象触发
  const WebSocketImpl = class {
    constructor(url: string) {
      lastWsUrl = url
      // 构造后异步 open（对齐真实时序）
      setTimeout(() => this.onopen?.(), 0)
    }
    get onopen(): (() => void) | null { return ws.onopen }
    set onopen(v: (() => void) | null) { ws.onopen = v }
    get onmessage(): ((event: { data: string }) => void) | null { return ws.onmessage }
    set onmessage(v: ((event: { data: string }) => void) | null) { ws.onmessage = v }
    get onclose(): (() => void) | null { return ws.onclose }
    set onclose(v: (() => void) | null) { ws.onclose = v }
    get onerror(): (() => void) | null { return ws.onerror }
    set onerror(v: (() => void) | null) { ws.onerror = v }
  }
  return {
    ws,
    fetchImpl,
    fetchCalls,
    WebSocketImpl,
    lastWsUrl: () => lastWsUrl,
    setRpcResponder: (r: (body: string) => unknown) => (rpcResponder = r)
  }
}

function makeSdk(transport = makeFakeTransport()) {
  const sdk = createGuestSdk({
    getCredentials: () => Promise.resolve(credentials),
    fetchImpl: transport.fetchImpl as unknown as typeof fetch,
    WebSocketImpl: transport.WebSocketImpl as unknown as typeof WebSocket
  })
  return { sdk, transport }
}

describe('createGuestSdk', () => {
  it('ready：票据换 token（exchange 调用形状）+ WS 连接用 query token', async () => {
    const { sdk, transport } = makeSdk()
    await expect(sdk.ready()).resolves.toBe('write')
    const exchange = transport.fetchCalls.find((c) => c.url.endsWith('/auth/exchange'))
    expect(exchange?.init.body).toBe(JSON.stringify({ ticket: 'TICKET' }))
    expect(transport.lastWsUrl()).toBe('ws://127.0.0.1:58000/ws?token=TOKEN')
  })

  it('request：首个请求触发初始化，之后 Bearer token + JSON-RPC 帧出、result 返回', async () => {
    const { sdk, transport } = makeSdk()
    const result = await sdk.request('session.list', {})
    expect(result).toEqual({ ok: true })
    const rpc = transport.fetchCalls.find((c) => c.url.endsWith('/rpc'))
    expect(new Headers(rpc?.init.headers).get('authorization')).toBe('Bearer TOKEN')
    expect((JSON.parse((rpc?.init.body ?? '') as string) as { method: string }).method).toBe('session.list')
  })

  it('request 帧内业务错误 reject（error.message 抛出）', async () => {
    const { sdk, transport } = makeSdk()
    transport.setRpcResponder(() => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }))
    await expect(sdk.request('session.list', {})).rejects.toThrow('nope')
  })

  it('request 传输层拒绝（403 越档）reject', async () => {
    const transport = makeFakeTransport()
    const sdk = createGuestSdk({
      getCredentials: () => Promise.resolve(credentials),
      fetchImpl: () => Promise.resolve(new Response('{"error":"forbidden"}', { status: 403 })),
      WebSocketImpl: transport.WebSocketImpl as unknown as typeof WebSocket
    })
    await expect(sdk.request('session.create', {})).rejects.toThrow('403')
  })

  it('onEvent：事件帧按 method 分发给订阅者，取消订阅后不再收', async () => {
    const { sdk, transport } = makeSdk()
    const received: string[] = []
    const off = sdk.onEvent('message.delta', (p) => received.push(p.delta))
    await sdk.ready()
    transport.ws.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', method: 'message.delta', params: { delta: 'hi' } })
    })
    // 响应帧（有 id）不分发
    transport.ws.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
    expect(received).toEqual(['hi'])
    off()
    transport.ws.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', method: 'message.delta', params: { delta: 'again' } })
    })
    expect(received).toEqual(['hi'])
  })

  it('凭证获取失败：ready 与 request 同一错误 reject', async () => {
    const transport = makeFakeTransport()
    const sdk = createGuestSdk({
      getCredentials: () => Promise.reject(new Error('HTTP 门未开')),
      fetchImpl: transport.fetchImpl as unknown as typeof fetch,
      WebSocketImpl: transport.WebSocketImpl as unknown as typeof WebSocket
    })
    await expect(sdk.ready()).rejects.toThrow('HTTP 门未开')
    await expect(sdk.request('session.list', {})).rejects.toThrow('HTTP 门未开')
  })
})
