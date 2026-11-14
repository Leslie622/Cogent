/**
 * HTTP 门传输层单测：只测传输语义（帧进帧出 / 体积上限 / 非请求帧 400 /
 * 路由 404），不碰注册表 —— 帧处理逻辑由 handleFrame 持有，这里用假实现
 * 钉住两边的契约（FrameHandler 返回什么，HTTP 层就回什么）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { startHttpRpc, type FrameHandler, type HttpRpcServer } from './server'
import type { RpcResponse } from '../../protocol'

/** 假 handleFrame：回显 method 到 result，模拟注册表行为 */
const echoHandler: FrameHandler = (raw) => {
  const frame = JSON.parse(raw) as { id: number; method: string }
  return Promise.resolve({ jsonrpc: '2.0', id: frame.id, result: { echo: frame.method } })
}

const servers: HttpRpcServer[] = []

async function start(handler: FrameHandler = echoHandler): Promise<{ server: HttpRpcServer; url: string }> {
  const server = await startHttpRpc(handler)
  servers.push(server)
  return { server, url: `http://127.0.0.1:${server.port}/rpc` }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('startHttpRpc 传输语义', () => {
  it('POST /rpc 帧进帧出：请求帧原样拿到响应帧', async () => {
    const { url } = await start()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session.list', params: {} })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { echo: 'session.list' }
    })
  })

  it('handleFrame 返回 null（事件/畸形帧）时回 400', async () => {
    const { url } = await start(() => Promise.resolve(null))
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'run.started', params: {} })
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('not a request frame')
  })

  it('业务错误帧恒 200：错误住在帧的 error 字段（应用层语义）', async () => {
    const { url } = await start(() =>
      Promise.resolve({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'unknown method: nope' }
      } satisfies RpcResponse)
    )
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }) })
    expect(res.status).toBe(200)
    const frame = (await res.json()) as RpcResponse
    expect(frame.error?.message).toContain('unknown method')
  })

  it('单帧体积超上限回 413（网络信任边界守卫）', async () => {
    const { url } = await start()
    const big = 'x'.repeat(1_000_001)
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'm', big }) })
    expect(res.status).toBe(413)
  })

  it('未知路径与非 POST 方法都到不了帧处理（Hono 默认 404，无自动 405）', async () => {
    const { server } = await start()
    const base = `http://127.0.0.1:${server.port}`
    expect((await fetch(base + '/nope', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(base + '/rpc')).status).toBe(404)
  })

  it('close 后端口不再服务', async () => {
    const { server, url } = await start()
    await server.close()
    const res = await fetch(url, { method: 'POST', body: '{}' }).catch((e: Error) => e)
    // 连接被拒（ECONNREFUSED）即视为已关；仍能拿到响应才算失败
    expect(res instanceof Error || res.status >= 500).toBe(true)
  })
})
