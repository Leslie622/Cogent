/**
 * HTTP 门鉴权集成（阶段 2b 验收）：真 Host 构建产物 + COGENT_HTTP_RPC=1，
 * 走 D3 票据全链 —— stdio 签发（模拟 main 血缘）→ HTTP 兑换长期 token →
 * 档位强制 / 重放拒绝 / 跨代失效。curl 驱动验收的可执行化（global-setup
 * 已守卫 build 产物新鲜度，测的就是打包后的真协议链路）。
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { makeTempDir, removeDir, sleep, startEngine, type EngineHandle } from './harness'

let home: string
let engine: EngineHandle
let base: string

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
  const init = await engine.send('initialize', { client: 'http-auth-it', protocolVersion: 1 })
  expect(init.result?.service, 'stdio 握手先行（HTTP 门与 stdio 同进程共存）').toBe('cogent-agent')
  base = await listeningBase(engine)
})

afterAll(() => {
  engine.kill()
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

it('票据全链（S1–S9 场景流一条到底）', async () => {
  // S1/S2 readonly 票据兑换
  const readonlyGrant = await grant('readonly')
  expect(readonlyGrant.scope).toBe('readonly')

  // S3 读方法放行：帧内拿真注册表结果
  const list = await rpc(readonlyGrant.token, 'session.list')
  expect(list.status).toBe(200)
  expect(((await list.json()) as { result?: unknown }).result).toEqual([])

  // S4 档位强制：readonly 调写方法 403
  expect((await rpc(readonlyGrant.token, 'session.create', { title: 'x' })).status).toBe(403)

  // S5 无 token 401；?token= query 双轨等价
  expect((await fetch(base + '/rpc', { method: 'POST', body: '{}' })).status).toBe(401)
  const byQuery = await fetch(`${base}/rpc?token=${readonlyGrant.token}`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'project.list', params: {} })
  })
  expect(byQuery.status).toBe(200)

  // S6 票据重放拒绝（消费即焚）
  const issue = await engine.send<{ ticket: string }>('capability.issue', { scope: 'readonly' })
  const ticket = issue.result?.ticket ?? ''
  const first = await fetch(base + '/auth/exchange', { method: 'POST', body: JSON.stringify({ ticket }) })
  const replay = await fetch(base + '/auth/exchange', { method: 'POST', body: JSON.stringify({ ticket }) })
  expect(first.status).toBe(200)
  expect(replay.status).toBe(401)

  // S7 write 档全链：真创建会话（写进临时隔离根，无害）
  const writeGrant = await grant('write')
  const created = await rpc(writeGrant.token, 'session.create', { title: 'http-auth' })
  expect(created.status).toBe(200)
  const summary = (await created.json()) as { result?: { id?: string } }
  expect(summary.result?.id).toBeTruthy()

  // S8 防自签提权：readonly token 经 HTTP 调 capability.issue → 403
  expect((await rpc(readonlyGrant.token, 'capability.issue', { scope: 'admin' })).status).toBe(403)

  // S9 跨代失效：token 生命周期 = Host 进程（重启 → 新 rootSecret → 旧 token 作废）
  const engine2 = startEngine(home, { COGENT_HTTP_RPC: '1' })
  try {
    await engine2.send('initialize', { client: 'http-auth-it-gen2', protocolVersion: 1 })
    const base2 = await listeningBase(engine2)
    const stale = await fetch(base2 + '/rpc', {
      method: 'POST',
      headers: { authorization: `Bearer ${writeGrant.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.list', params: {} })
    })
    expect(stale.status, 'Host 重启后旧 token 应 401').toBe(401)
  } finally {
    engine2.kill()
  }
})
