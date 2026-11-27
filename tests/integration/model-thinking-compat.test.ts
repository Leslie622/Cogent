/**
 * 模型思考映射、compat 覆盖与端点发现集成回归（真 Host + pi + loopback HTTP）。
 *
 * 1. openai-responses 模型配置 off: null 时，即使传入 thinkingLevel: 'off'，引擎也会 clamp 到低档而不发 effort: 'none'；
 * 2. openai-completions 模型配置模型级 compat（deepseek + supportsDeveloperRole:false + maxTokensField:max_tokens）与映射重命名（max->high）按实生效；
 * 3. models.discover 经 Host 真实拉取端点 /models 列表（复用 Host 已保存凭据）。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { closeLoopback, listenLoopback, check, chunk, type EngineHandle, initEngine, makeTempDir, removeDir, sse, startEngine } from './harness'

const home = makeTempDir('cogent-model-compat-home-')
const ws = makeTempDir('cogent-model-compat-ws-')
const requests: Array<{ method: string; path: string; auth?: string; body?: Record<string, unknown> }> = []

const server: Server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    requests.push({ method: 'GET', path: req.url, auth: req.headers.authorization })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'discovered-ds', context_length: 131072, max_output_tokens: 16384, supported_parameters: ['reasoning'] }
      ]
    }))
    return
  }

  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const parsed = JSON.parse(body) as Record<string, unknown>
    requests.push({ method: req.method ?? 'POST', path: req.url ?? '', auth: req.headers.authorization, body: parsed })
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } })}\n\n`)
      res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } })}\n\n`)
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' })}\n\n`)
      res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(sse(chunk({ content: 'ok' })))
    res.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

const engine: EngineHandle = startEngine(home)
let port = 0

beforeAll(async () => {
  port = await listenLoopback(server)
  await initEngine(engine, {
    client: 'model-compat-it',
    providers: [
      {
        id: 'custom/resp',
        name: 'Resp',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiFormat: 'openai-responses',
        models: [],
        modelDefs: [
          {
            id: 'mandatory-o3',
            reasoning: true,
            thinkingLevelMap: { off: null, low: 'low', high: 'high' }
          }
        ]
      },
      {
        id: 'custom/gw',
        name: 'Gateway',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiFormat: 'openai-completions',
        models: [],
        modelDefs: [
          {
            id: 'mapped-ds',
            reasoning: true,
            thinkingLevelMap: { low: 'low', max: 'high' },
            compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
          }
        ]
      }
    ]
  })
  await engine.send('credentials.set', { providerId: 'custom/resp', apiKey: 'sk-resp' })
  await engine.send('credentials.set', { providerId: 'custom/gw', apiKey: 'sk-gw' })
}, 60_000)

afterAll(async () => {
  await engine.stop()
  await closeLoopback(server)
  for (const dir of [home, ws]) removeDir(dir)
})

it('禁用 off 的 responses 模型收到 off 会自动 clamp 为 low，不发 effort: none', async () => {
  const modelsRes = await engine.send<{ models: Array<{ id: string; provider: string; thinkingLevels: string[] }> }>('models.list', {})
  const o3 = modelsRes.result?.models.find((m) => m.provider === 'custom/resp' && m.id === 'mandatory-o3')
  check('1. models.list 不含 off', JSON.stringify(o3?.thinkingLevels) === JSON.stringify(['low', 'high']))

  const created = await engine.send<{ id: string }>('session.create', { cwd: ws })
  const sid = created.result!.id
  const sub = await engine.send('agent.submit', {
    sessionId: sid, text: 'hi', model: 'mandatory-o3', provider: 'custom/resp', thinkingLevel: 'off'
  })
  check('2. submit 受理', sub.result?.accepted === true, JSON.stringify(sub.error ?? {}))
  await engine.waitEvent('run.completed', (p) => p.sessionId === sid)
  const req = requests.find((r) => r.path === '/v1/responses')
  expect((req?.body?.reasoning as { effort?: string } | undefined)?.effort).toBe('low')
})

it('模型级 compat 与映射重命名生效（deepseek + max_tokens + system + max->high）', async () => {
  const created = await engine.send<{ id: string }>('session.create', { cwd: ws })
  const sid = created.result!.id
  const sub = await engine.send('agent.submit', {
    sessionId: sid, text: 'hi', model: 'mapped-ds', provider: 'custom/gw', thinkingLevel: 'max'
  })
  check('3. submit 受理', sub.result?.accepted === true, JSON.stringify(sub.error ?? {}))
  await engine.waitEvent('run.completed', (p) => p.sessionId === sid)
  const req = requests.find((r) => r.path === '/v1/chat/completions')
  expect(req?.body?.thinking).toEqual({ type: 'enabled' })
  expect(req?.body?.reasoning_effort).toBe('high')
  expect(req?.body?.max_tokens).toBeTypeOf('number')
  expect(req?.body?.max_completion_tokens).toBeUndefined()
  const messages = req?.body?.messages as Array<{ role: string }>
  expect(messages[0]?.role).toBe('system')
})

it('models.discover 复用 Host 凭据并返回解析后的候选模型', async () => {
  const res = await engine.send<{ models: Array<{ id: string; contextWindow?: number; reasoning?: boolean }> }>('models.discover', {
    providerId: 'custom/gw',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiFormat: 'openai-completions'
  })
  expect(res.error).toBeUndefined()
  expect(res.result?.models).toEqual([
    { id: 'discovered-ds', contextWindow: 131072, maxTokens: 16384, reasoning: true }
  ])
  const getReq = requests.find((r) => r.method === 'GET' && r.path === '/v1/models')
  expect(getReq?.auth).toBe('Bearer sk-gw')
})
