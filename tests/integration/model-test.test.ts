/** 真 Host + pi + loopback SSE：探测复用当前端点/鉴权，独立于聊天且绝不伪报成功。 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { closeLoopback, chunk, makeTempDir, removeDir, sse, startEngine, type EngineHandle } from './harness'

let engine: EngineHandle
let server: Server
let home: string
let rejectNext = false
const requests: Array<{ path: string; auth: string; body: Record<string, unknown> }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (data) => { body += data })
    req.on('end', () => {
      requests.push({ path: req.url!, auth: req.headers.authorization!, body: JSON.parse(body) as Record<string, unknown> })
      if (rejectNext) {
        rejectNext = false
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid probe API key', type: 'authentication_error' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sse(chunk({ content: 'ok' })))
      res.write(sse(chunk({}, 'stop')))
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  home = makeTempDir('cogent-model-test-')
  engine = startEngine(home)
  await engine.send('initialize', { client: 'model-test', protocolVersion: 3 })
  for (const providerId of ['custom/one', 'custom/two', 'deepseek']) {
    await engine.send('credentials.set', { providerId, apiKey: `sk-${providerId}` })
  }
  const synced = await engine.send('providers.custom.sync', {
    providers: ['one', 'two'].map((name) => ({
      id: `custom/${name}`, name, baseUrl: `http://127.0.0.1:${port}/${name}/v1`, models: [],
      modelDefs: [{ id: 'probe', maxTokens: 256 }, { id: 'disabled' }], disabledModels: ['disabled']
    })),
    overrides: [{ providerId: 'deepseek', baseUrl: `http://127.0.0.1:${port}/builtin/v1`, models: [{ id: 'probe' }] }]
  })
  expect(synced.error).toBeUndefined()
})
afterAll(async () => {
  await engine.stop()
  await closeLoopback(server)
  removeDir(home)
})

it('同名模型按供应商双键命中真实路由与凭据，测试不创建会话或聊天事件', async () => {
  for (const name of ['one', 'two']) {
    const response = await engine.send<{ elapsedMs: number }>('models.test', { providerId: `custom/${name}`, modelId: 'probe' })
    expect(response.error).toBeUndefined()
    expect(response.result!.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(requests.at(-1)).toMatchObject({ path: `/${name}/v1/chat/completions`, auth: `Bearer sk-custom/${name}`,
      body: { model: 'probe', stream: true, max_completion_tokens: 256, messages: [
        { role: 'system', content: 'You are Cogent connectivity probe.' },
        { role: 'user', content: 'hi' }
      ] } })
    expect(requests.at(-1)!.body).not.toHaveProperty('tools')
  }
  expect((await engine.send('session.list', {})).result).toEqual([])
  expect(engine.events).toEqual([])
})

it('内置供应商同样使用当前覆盖端点', async () => {
  const response = await engine.send('models.test', { providerId: 'deepseek', modelId: 'probe' })
  expect(response.error).toBeUndefined()
  expect(requests.at(-1)).toMatchObject({ path: '/builtin/v1/chat/completions', auth: 'Bearer sk-deepseek' })
})

it('401 原样反馈，不重试，失败后仍可重新测试', async () => {
  rejectNext = true
  const count = requests.length
  const response = await engine.send('models.test', { providerId: 'custom/one', modelId: 'probe' })
  expect(response.result).toBeUndefined()
  expect(response.error!.message).toContain('Invalid probe API key')
  expect(requests).toHaveLength(count + 1)
  expect((await engine.send('models.test', { providerId: 'custom/one', modelId: 'probe' })).error).toBeUndefined()
})

it.each([null, {}, { providerId: 'custom/one' }, { providerId: 1, modelId: 'probe' }, { providerId: ' ', modelId: 'probe' }])('非法参数 %j 返回参数错误', async (params) => {
  expect((await engine.send('models.test', params)).error!.code).toBe(-32602)
})

it.each(['missing', 'disabled'])('目录外或禁用模型 %s 明确失败，不能旁路注册表', async (modelId) => {
  const count = requests.length
  const response = await engine.send('models.test', { providerId: 'custom/one', modelId })
  expect(response.error!.message).toContain('模型不存在或已禁用')
  expect(requests).toHaveLength(count)
})
