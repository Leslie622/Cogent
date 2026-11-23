/**
 * HTTP 门鉴权集成（阶段 2b 验收）：真 Host 构建产物 + COGENT_HTTP_RPC=1，
 * 走 D3 票据全链 —— stdio 签发（模拟 main 血缘）→ HTTP 兑换长期 token →
 * 档位强制、跨代失效与业务事件分发。匿名、query token、票据重放矩阵由源码层覆盖（global-setup
 * 已守卫 build 产物新鲜度，测的就是打包后的真协议链路）。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { closeLoopback, chunk, initEngine, listenLoopback, makeTempDir, removeDir, sleep, sse, startEngine, type EngineHandle } from './harness'

let home: string
let engine: EngineHandle
let base: string

// ———— S11 的 mock LLM（OpenAI chat.completions SSE 形状，compaction.test 同款） ————

let mockPort: number
let mockServer: Server

/** 流式回一段文本即收（message.delta 事件源） */
const textResponse = (res: { write: (s: string) => void; end: () => void }, text: string): void => {
  res.write(sse(chunk({ content: text })))
  res.write(sse(chunk({}, 'stop')))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 从 stderr 监听行解析端口（2b 的端口上报通道；main 集成后换协议字段） */
function listeningBase(target: EngineHandle, timeoutMs = 15_000): Promise<string> {
  return (async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const line = target.stderrLines.find((l) => l.includes('http rpc listening on'))
      if (line) return `http://127.0.0.1:${/:(\d+)\s*$/.exec(line)?.[1]}`
      await sleep(100)
    }
    throw new Error('HTTP 门未在限时内上报监听行')
  })()
}

beforeAll(async () => {
  home = makeTempDir('cogent-http-auth-')
  engine = startEngine(home, { COGENT_HTTP_RPC: '1' })
  const init = await engine.send<{ service?: string; httpPort?: number }>('initialize', {
    client: 'http-auth-it',
    protocolVersion: 1
  })
  expect(init.result?.service, 'stdio 握手先行（HTTP 门与 stdio 同进程共存）').toBe('cogent-agent')
  base = await listeningBase(engine)
  // 2b-2：端口上报双通道（协议字段 vs stderr 日志）必须一致
  expect(init.result?.httpPort).toBe(Number(base.split(':').pop()))
  // S11 的 mock LLM：任意请求都回一段流式文本
  mockServer = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      textResponse(res, 'WS-EVENT-IT-MARK')
    })
  })
  mockPort = await listenLoopback(mockServer)
})

afterAll(async () => {
  await engine.stop()
  await closeLoopback(mockServer)
  removeDir(home)
})

interface TokenGrant {
  token: string
  scope: string
}

/** stdio 签发（main 血缘角色）→ HTTP 兑换 */
async function grant(scope: 'readonly' | 'write' | 'admin'): Promise<TokenGrant> {
  const issue = await engine.send<{ ticket: string }>('capability.issue', { scope })
  const ticket = issue.result?.ticket
  if (!ticket) throw new Error(`capability.issue 失败: ${JSON.stringify(issue.error)}`)
  const res = await fetch(base + '/auth/exchange', { method: 'POST', body: JSON.stringify({ ticket }) })
  expect(res.status, `exchange(${scope}) 应 200`).toBe(200)
  return (await res.json()) as TokenGrant
}

function rpc(token: string, method: string, params: Record<string, unknown> = {}): Promise<Response> {
  return fetch(base + '/rpc', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
}

it('真实注册表签票、兑换、执行业务；完整重启后旧 token 失效', async () => {
  // S1/S2 readonly 票据兑换
  const readonlyGrant = await grant('readonly')
  expect(readonlyGrant.scope).toBe('readonly')

  // S3 读方法放行：帧内拿真注册表结果
  const list = await rpc(readonlyGrant.token, 'session.list')
  expect(list.status).toBe(200)
  expect(((await list.json()) as { result?: unknown }).result).toEqual([])

  // S4 档位强制：readonly 调写方法 403
  expect((await rpc(readonlyGrant.token, 'session.create', { title: 'x' })).status).toBe(403)
  expect((await rpc(readonlyGrant.token, 'session.titleSettings.get')).status).toBe(200)
  expect((await rpc(readonlyGrant.token, 'session.titleSettings.set', { enabled: false })).status).toBe(403)

  // S7 write 档全链：真创建会话（写进临时隔离根，无害）
  const writeGrant = await grant('write')
  expect((await rpc(writeGrant.token, 'session.titleSettings.set', { enabled: false })).status).toBe(403)
  const titleAdmin = await grant('admin')
  expect((await rpc(titleAdmin.token, 'session.titleSettings.set', { enabled: false })).status).toBe(200)
  const titleSettings = await rpc(readonlyGrant.token, 'session.titleSettings.get')
  expect(await titleSettings.json()).toMatchObject({ result: { enabled: false } })
  await rpc(titleAdmin.token, 'session.titleSettings.set', { enabled: true })
  const created = await rpc(writeGrant.token, 'session.create', { title: 'http-auth' })
  expect(created.status).toBe(200)
  const summary = (await created.json()) as { result?: { id?: string } }
  expect(summary.result?.id).toBeTruthy()

  const handshake = { client: 'network-readonly', protocolVersion: 3 }
  const info = await rpc(readonlyGrant.token, 'initialize', handshake)
  expect(await info.json()).toMatchObject({ result: { service: 'cogent-agent' } })
  const credentialsBefore = await engine.send('credentials.list')
  const injection = await rpc(readonlyGrant.token, 'initialize', {
    ...handshake, credentials: { openai: { apiKey: 'test-only-not-accepted' } }
  })
  expect(await injection.json()).toMatchObject({ error: { code: -32602 } })
  const credentialsAfter = await engine.send('credentials.list')
  expect(credentialsAfter.result).toEqual(credentialsBefore.result)

  // S8 防自签提权：readonly token 经 HTTP 调 capability.issue → 403
  expect((await rpc(readonlyGrant.token, 'capability.issue', { scope: 'admin' })).status).toBe(403)

  // S9 跨代失效：token 生命周期 = Host 进程（重启 → 新 rootSecret → 旧 token 作废）
  await engine.stop()
  engine = startEngine(home, { COGENT_HTTP_RPC: '1' })
  await engine.send('initialize', { client: 'http-auth-it-gen2', protocolVersion: 1 })
  base = await listeningBase(engine)
  const stale = await rpc(writeGrant.token, 'session.list')
  expect(stale.status, 'Host 重启后旧 token 应 401').toBe(401)
})

it('WS 门（S10–S11）：请求帧走同一注册表，真事件流端到端推到连接', async () => {
  await initEngine(engine, {
    client: 'http-auth-ws',
    providers: [
      {
        id: 'custom/mock',
        name: 'Mock',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        models: ['mock'],
        modelDefs: [{ id: 'mock', contextWindow: 64_000 }]
      }
    ]
  })

  // S10：write token 开 WS，请求帧上行 → 响应帧沿同连接回（与 /rpc 同一 handleFrame）
  const grant2 = await grant('write')
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${grant2.token}`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', (e: Error) => reject(e))
  })
  const wsSend = (method: string, params: Record<string, unknown> = {}): void => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }))
  }
  const firstReply = new Promise<string>((resolve) => ws.once('message', (d) => resolve((d as Buffer).toString())))
  wsSend('session.list')
  // 前一场景流已建过会话，此处只断言真注册表返回（数组形状，非空壳回显）
  const listFrame = JSON.parse(await firstReply) as { result?: unknown }
  expect(Array.isArray(listFrame.result), `WS 应拿到真注册表结果: ${JSON.stringify(listFrame)}`).toBe(true)

  // S11：submit 触发引擎事件 → notify 双写（stdout 给 main + broadcastEvent 给 WS）
  const created = await rpc(grant2.token, 'session.create', { title: 'ws-it' })
  const sessionId = ((await created.json()) as { result?: { id?: string } }).result?.id
  expect(sessionId).toBeTruthy()
  const received: string[] = []
  ws.on('message', (d) => received.push((d as Buffer).toString()))
  await rpc(grant2.token, 'agent.submit', { sessionId: sessionId as string, text: 'hi', model: 'mock' })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const methods = received.map((line) => (JSON.parse(line) as { method?: string }).method)
    if (methods.includes('run.started') && methods.includes('run.completed')) break
    await sleep(100)
  }
  const methods = received.map((line) => (JSON.parse(line) as { method?: string }).method)
  expect(methods, `WS 事件流应含 run.started/message.delta/run.completed，实得: ${methods.join(',')}`).toContain(
    'run.started'
  )
  expect(methods).toContain('message.delta')
  expect(methods).toContain('run.completed')
  // 同一事件也走了 stdio 出口（main 不因 WS 增挂而丢事件）
  expect(engine.events.some((e) => e.method === 'run.completed' && e.params.sessionId === sessionId)).toBe(true)
  ws.close()
})
