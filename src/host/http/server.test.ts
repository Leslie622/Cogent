/**
 * HTTP 门传输层单测：钉传输语义（鉴权 401/403、票据 exchange、帧进帧出、
 * 体积上限、路由），不碰注册表 —— 帧处理逻辑由 handleFrame 持有，这里用
 * 假实现钉住两边的契约。鉴权材料用真 auth 工厂（store/token 签验链路在
 * auth.test.ts 已钉，此处只验接线）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createCapabilityStore, createRootSecret, signToken } from './auth'
import { startHttpRpc, type FrameHandler, type HttpRpcServer } from './server'
import type { RpcResponse } from '../../protocol'

/** 假 handleFrame：回显 method 到 result，模拟注册表行为 */
const echoHandler: FrameHandler = (raw) => {
  const frame = JSON.parse(raw) as { id: number; method: string }
  return Promise.resolve({ jsonrpc: '2.0', id: frame.id, result: { echo: frame.method } })
}

const servers: HttpRpcServer[] = []

interface TestApp {
  server: HttpRpcServer
  base: string
  /** 直连本测试的 rootSecret：开一个指定档位的口子签真 token（属性式签名，允许解构） */
  token: (scope: 'readonly' | 'write' | 'admin') => string
}

async function start(handler: FrameHandler = echoHandler): Promise<TestApp> {
  const rootSecret = createRootSecret()
  const store = createCapabilityStore()
  const server = await startHttpRpc(handler, { rootSecret, store })
  servers.push(server)
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    token: (scope) => signToken(rootSecret, scope)
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('鉴权（2b：开门即要 token）', () => {
  it('无 token 访问 /rpc 回 401', async () => {
    const { base } = await start()
    const res = await fetch(base + '/rpc', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('Bearer 头与 ?token= query 双轨等价', async () => {
    const { base, token } = await start()
    const byHeader = await fetch(base + '/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${token('readonly')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.list', params: {} })
    })
    const byQuery = await fetch(`${base}/rpc?token=${token('readonly')}`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session.list', params: {} })
    })
    expect(byHeader.status).toBe(200)
    expect(byQuery.status).toBe(200)
  })

  it('伪造 token 401；401 优先于 404（未知路径也要 token）', async () => {
    const { base } = await start()
    expect((await fetch(base + '/rpc', { method: 'POST', headers: { authorization: 'Bearer forged' }, body: '{}' })).status).toBe(401)
    expect((await fetch(base + '/nope', { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('档位强制：readonly token 调写方法 403、读方法 200', async () => {
    const { base, token } = await start()
    const readonly = { authorization: `Bearer ${token('readonly')}` }
    expect(
      (
        await fetch(base + '/rpc', {
          method: 'POST',
          headers: readonly,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.create', params: {} })
        })
      ).status
    ).toBe(403)
    const ok = await fetch(base + '/rpc', {
      method: 'POST',
      headers: readonly,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session.list', params: {} })
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as RpcResponse & { result: { echo: string } }).result.echo).toBe('session.list')
  })

  it('capability.issue 归 admin：write token 403、admin token 放行', async () => {
    const { base, token } = await start()
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'capability.issue', params: { scope: 'readonly' } })
    expect((await fetch(base + '/rpc', { method: 'POST', headers: { authorization: `Bearer ${token('write')}` }, body: frame })).status).toBe(403)
    expect((await fetch(base + '/rpc', { method: 'POST', headers: { authorization: `Bearer ${token('admin')}` }, body: frame })).status).toBe(200)
  })
})

describe('票据换 token（/auth/exchange）', () => {
  it('issue → exchange 得 token，token 可调 /rpc', async () => {
    const rootSecret = createRootSecret()
    const store = createCapabilityStore()
    const server = await startHttpRpc(echoHandler, { rootSecret, store })
    servers.push(server)
    const { ticket } = store.issue('write')
    const exchange = await fetch(`http://127.0.0.1:${server.port}/auth/exchange`, {
      method: 'POST',
      body: JSON.stringify({ ticket })
    })
    expect(exchange.status).toBe(200)
    const { token } = (await exchange.json()) as { token: string }
    expect(token).toBeTruthy()
    const rpc = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'project.create', params: {} })
    })
    expect(rpc.status).toBe(200)
  })

  it('exchange 消费即焚：重放回 401；伪造票据 401', async () => {
    const rootSecret = createRootSecret()
    const store = createCapabilityStore()
    const server = await startHttpRpc(echoHandler, { rootSecret, store })
    servers.push(server)
    const url = `http://127.0.0.1:${server.port}/auth/exchange`
    const { ticket } = store.issue('readonly')
    const body = JSON.stringify({ ticket })
    expect((await fetch(url, { method: 'POST', body })).status).toBe(200)
    expect((await fetch(url, { method: 'POST', body })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ ticket: 'forged' }) })).status).toBe(401)
  })

  it('exchange 自身免 Bearer（票据就是凭证）', async () => {
    // 独立装配：断言不带任何 token 的请求不被中间件 401 拦 —— 401 来自
    // handler 的票据校验（错误文案含 ticket），两处 401 由此区分
    const server = await startHttpRpc(echoHandler, {
      rootSecret: createRootSecret(),
      store: createCapabilityStore()
    })
    servers.push(server)
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/exchange`, {
      method: 'POST',
      body: JSON.stringify({ ticket: 'whatever' })
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toContain('ticket')
  })
})

describe('传输语义（2a 存量）', () => {
  it('POST /rpc 帧进帧出：请求帧原样拿到响应帧', async () => {
    const { base, token } = await start()
    const res = await fetch(base + '/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${token('readonly')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session.list', params: {} })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { echo: 'session.list' } })
  })

  it('handleFrame 返回 null（事件/畸形帧）时回 400', async () => {
    const { base, token } = await start(() => Promise.resolve(null))
    const res = await fetch(base + '/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${token('readonly')}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'run.started', params: {} })
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('not a request frame')
  })

  it('业务错误帧恒 200：错误住在帧的 error 字段（应用层语义）', async () => {
    const { base, token } = await start(() =>
      Promise.resolve({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'unknown method: nope' }
      } satisfies RpcResponse)
    )
    const res = await fetch(base + '/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${token('readonly')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' })
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as RpcResponse).error?.message).toContain('unknown method')
  })

  it('单帧体积超上限回 413（网络信任边界守卫）', async () => {
    const { base, token } = await start()
    const big = 'x'.repeat(1_000_001)
    const res = await fetch(base + '/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${token('readonly')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.list', big })
    })
    expect(res.status).toBe(413)
  })

  it('未知路径与非 POST 方法都到不了帧处理（Hono 默认 404，无自动 405）', async () => {
    const { base, token } = await start()
    const auth = { authorization: `Bearer ${token('readonly')}` }
    expect((await fetch(base + '/nope', { method: 'POST', headers: auth, body: '{}' })).status).toBe(404)
    expect((await fetch(base + '/rpc', { headers: auth })).status).toBe(404)
  })

  it('close 后端口不再服务', async () => {
    const { server, base, token } = await start()
    await server.close()
    const res = await fetch(base + '/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${token('readonly')}` },
      body: '{}'
    }).catch((e: Error) => e)
    expect(res instanceof Error || res.status >= 500).toBe(true)
  })
})

// ———— WS 门（2c）：upgrade 鉴权 / 双向帧 / 事件广播 / drain close ————

const sockets: WebSocket[] = []

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close()
})

function wsOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    sockets.push(ws)
    ws.on('open', () => resolve(ws))
    ws.on('error', (err: Error) => reject(err))
  })
}

function wsNextMessage(ws: WebSocket): Promise<string> {
  // ws 文本帧 data 恒为 Buffer（node ws 默认不分片）
  return new Promise((resolve) => ws.once('message', (data) => resolve((data as Buffer).toString())))
}

describe('WS 门（2c）', () => {
  it('握手鉴权：无 token / 伪造 token 的 upgrade 被拒（HTTP 401）', async () => {
    const { base } = await start()
    const noToken = await wsOpen(`${base}/ws`).then(
      () => { throw new Error('should not open') },
      (e: Error) => e.message
    )
    expect(noToken).toContain('401')
    const forged = await wsOpen(`${base}/ws?token=forged`).then(
      () => { throw new Error('should not open') },
      (e: Error) => e.message
    )
    expect(forged).toContain('401')
  })

  it('非 /ws 路径的 upgrade 请求被丢弃', async () => {
    const { base, token } = await start()
    const rejected = await wsOpen(`${base}/not-ws?token=${token('readonly')}`).then(
      () => { throw new Error('should not open') },
      (e: Error) => e.message
    )
    expect(rejected).toBeTruthy()
  })

  it('上行请求帧走同一 handleFrame，响应帧沿同连接回', async () => {
    const { base, token } = await start()
    const ws = await wsOpen(`${base}/ws?token=${token('readonly')}`)
    const reply = wsNextMessage(ws)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'session.list', params: {} }))
    expect(JSON.parse(await reply)).toEqual({ jsonrpc: '2.0', id: 5, result: { echo: 'session.list' } })
  })

  it('档位强制与 /rpc 同口径：readonly 经 WS 调写方法回 -32003 帧（防换门绕过）', async () => {
    const { base, token } = await start()
    const ws = await wsOpen(`${base}/ws?token=${token('readonly')}`)
    const reply = wsNextMessage(ws)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'session.create', params: {} }))
    const frame = JSON.parse(await reply) as RpcResponse
    expect(frame.id).toBe(6)
    expect(frame.error?.code).toBe(-32_003)
  })

  it('broadcastEvent：事件帧推给所有在线连接', async () => {
    const { base, server, token } = await start()
    const ws1 = await wsOpen(`${base}/ws?token=${token('readonly')}`)
    const ws2 = await wsOpen(`${base}/ws?token=${token('write')}`)
    const p1 = wsNextMessage(ws1)
    const p2 = wsNextMessage(ws2)
    server.broadcastEvent({ jsonrpc: '2.0', method: 'run.started', params: { sessionId: 's1' } })
    const expected = { jsonrpc: '2.0', method: 'run.started', params: { sessionId: 's1' } }
    expect(JSON.parse(await p1)).toEqual(expected)
    expect(JSON.parse(await p2)).toEqual(expected)
  })

  it('close 先排空：在线连接收到 close(1001) 而非硬断', async () => {
    const { base, server, token } = await start()
    const ws = await wsOpen(`${base}/ws?token=${token('readonly')}`)
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    await server.close()
    expect(await closed).toBe(1001)
  })
})
