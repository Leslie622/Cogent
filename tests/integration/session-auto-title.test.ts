/** 无 renderer 的真 Host 协议测试：标题并发、三方言路由、独立账本及配置/摘要重启恢复。 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { InspectEntrySummary, SessionSummary } from '../../src/protocol'
import type { SessionTitleSettings } from '../../src/shared/session-title'
import { chunk, makeTempDir, removeDir, sse, startEngine, type EngineHandle } from './harness'

let engine: EngineHandle
let server: Server
let home: string
let port: number
let holdMain = false
const pendingMain: ServerResponse[] = []
const requests: Array<{ path: string; title: boolean; auth: string | undefined; body: Record<string, unknown> }> = []
// 通用 harness 的 summary 为工具文本子集；本册按具体事件读取会话摘要合同。
const summaryOf = (params: unknown): SessionSummary => (params as { summary: SessionSummary }).summary

function respond(res: ServerResponse, path: string, text: string) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (path.includes('/anthropic/')) {
    for (const event of [
      { type: 'message_start', message: { id: 'msg_title', type: 'message', role: 'assistant', model: 'same', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' }
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  } else if (path.includes('/responses/')) {
    const message = { id: 'msg_title', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    res.write(sse({ type: 'response.created', response: { id: 'resp_title', status: 'in_progress', output: [] } }))
    res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } }))
    res.write(sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }))
    res.write(sse({ type: 'response.output_item.done', output_index: 0, item: message }))
    res.end(sse({ type: 'response.completed', response: { id: 'resp_title', status: 'completed', output: [message], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } } }))
  } else {
    res.write(sse(chunk({ content: text })))
    res.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })))
    res.end('data: [DONE]\n\n')
  }
}
async function configureProviders() {
  expect((await engine.send('providers.custom.sync', { providers: [
    { id: 'custom/chat', name: 'chat', apiFormat: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/chat/v1`, models: ['same'] },
    { id: 'custom/responses', name: 'responses', apiFormat: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/responses/v1`, models: ['same'] },
    { id: 'custom/anthropic', name: 'anthropic', apiFormat: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}/anthropic`, models: ['same'] }
  ], overrides: [] })).error).toBeUndefined()
  for (const providerId of ['custom/chat', 'custom/responses', 'custom/anthropic']) {
    await engine.send('credentials.set', { providerId, apiKey: `sk-${providerId}` })
  }
}
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (data: Buffer) => { raw += data.toString() })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      const title = raw.includes('Generate a concise session title')
      requests.push({ path: req.url!, title, body, auth: req.headers.authorization ?? req.headers['x-api-key'] as string | undefined })
      if (holdMain && !title) pendingMain.push(res)
      else respond(res, req.url!, title ? '问候交流' : '你好，有什么可以帮你？')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  home = makeTempDir('cogent-title-protocol-')
  engine = startEngine(home)
  await engine.send('initialize', { client: 'title-test', protocolVersion: 3 })
  await configureProviders()
})
afterAll(async () => {
  engine.kill()
  for (const response of pendingMain) response.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  removeDir(home)
})

it('无界面首句即生成并广播，主回复仍挂起；标题与主用量分开', async () => {
  holdMain = true
  const created = await engine.send<SessionSummary>('session.create', { cwd: home })
  const id = created.result!.id
  await engine.send('agent.submit', { sessionId: id, text: '你好', model: 'same', provider: 'custom/chat' })
  const temporary = await engine.waitEvent('session.summaryChanged', (params) => summaryOf(params).id === id)
  expect(summaryOf(temporary.params).title).toBe('你好')
  const generated = await engine.waitEvent('session.summaryChanged', (params) => summaryOf(params).id === id && summaryOf(params).title === '问候交流')
  expect(engine.events.some((event) => event.method === 'run.completed' && event.params.sessionId === id)).toBe(false)
  expect(summaryOf(generated.params).updatedAt).toBe(summaryOf(temporary.params).updatedAt)
  holdMain = false
  for (const response of pendingMain.splice(0)) respond(response, '/chat/v1/chat/completions', '你好，有什么可以帮你？')
  const completed = await engine.waitEvent('run.completed', (params) => params.sessionId === id)
  expect(completed.params.messages).toHaveLength(1)
  expect(completed.params.messages![0]).toMatchObject({ usage: { totalTokens: 24 } })
  const entries = (await engine.send<{ entries: InspectEntrySummary[] }>('inspect.entries', { sessionId: id })).result!.entries
  expect(entries.filter((entry) => entry.kind === 'title.finished')).toHaveLength(1)
  const request = requests.find((entry) => entry.title)!
  expect(request.auth).toBe('Bearer sk-custom/chat')
  expect(request.body).not.toHaveProperty('tools')
  expect(request.body).toMatchObject({ max_completion_tokens: 256, messages: [
    { role: 'system', content: expect.stringContaining('Generate a concise session title') as string },
    { role: 'user', content: '{"input":"你好"}' }
  ] })
  // 重启只恢复摘要；标题策略也由 Host 自行恢复，与页面挂载无关。
  expect((await engine.send('session.titleSettings.set', { enabled: false, model: { provider: 'custom/responses', id: 'same' } })).result).toEqual({ enabled: false })
  engine.kill(); engine = startEngine(home)
  await engine.send('initialize', { client: 'title-restart', protocolVersion: 3 })
  expect((await engine.send<SessionTitleSettings>('session.titleSettings.get')).result).toEqual({ enabled: false })
  expect((await engine.send<SessionSummary[]>('session.list')).result!.find((session) => session.id === id)?.title).toBe('问候交流')
  await configureProviders()
})

it.each(['responses', 'anthropic'] as const)('标题跟随首条 %s 对话模型的端点与凭据，旧独立选择不生效', async (dialect) => {
  expect((await engine.send('session.titleSettings.set', { enabled: true, model: { provider: 'custom/chat', id: 'same' } })).result).toEqual({ enabled: true })
  const session = (await engine.send<SessionSummary>('session.create', { cwd: home })).result!
  const count = requests.length
  await engine.send('agent.submit', { sessionId: session.id, text: '你好', model: 'same', provider: `custom/${dialect}` })
  await engine.waitEvent('session.summaryChanged', (params) => summaryOf(params).id === session.id && summaryOf(params).title === '问候交流')
  await engine.waitEvent('run.completed', (params) => params.sessionId === session.id)
  const request = requests.slice(count).find((entry) => entry.title)!
  expect(new URL(request.path, 'http://localhost').pathname).toBe(dialect === 'responses' ? '/responses/v1/responses' : '/anthropic/v1/messages')
  expect(request.auth).toContain(`sk-custom/${dialect}`)
  expect(request.body).not.toHaveProperty('tools')
})

it('关闭功能仍显示原文标题；显式命名包括默认文案不覆盖，不额外请求', async () => {
  await engine.send('session.titleSettings.set', { enabled: false })
  const count = requests.filter((request) => request.title).length
  for (const title of [undefined, '新会话']) {
    const session = (await engine.send<SessionSummary>('session.create', { cwd: home, ...(title !== undefined && { title }) })).result!
    await engine.send('agent.submit', { sessionId: session.id, text: '你好', model: 'same', provider: 'custom/chat' })
    await engine.waitEvent('run.completed', (params) => params.sessionId === session.id)
    const saved = (await engine.send<SessionSummary[]>('session.list')).result!.find((item) => item.id === session.id)!
    expect(saved.title).toBe(title ?? '你好')
  }
  expect(requests.filter((request) => request.title)).toHaveLength(count)
})

it.each([null, {}, { enabled: 'yes' }, { enabled: true, model: { provider: 'x' } }])('非法配置 %j 走参数错误帧，原设置不变', async (params) => {
  const previous = (await engine.send<SessionTitleSettings>('session.titleSettings.get')).result
  expect((await engine.send('session.titleSettings.set', params)).error?.code).toBe(-32602)
  expect((await engine.send<SessionTitleSettings>('session.titleSettings.get')).result).toEqual(previous)
})
