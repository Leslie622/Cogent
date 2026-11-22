/** 真构建 Host + pi 工具循环 + mock SSE：申报/终态/停止/继续/重启的端到端行为。 */
import { createServer, type ServerResponse } from 'node:http'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TurnOutputs } from '../../src/shared/outputs'
import type { FileDescriptor } from '../../src/shared/files'
import { startEngine, initEngine, makeTempDir, removeDir, chunk, sse, type EngineHandle } from './harness'

type Action = { tool: string; args: object; id?: string } | { text: string; finish?: 'stop' | 'length' } | { hold: true } | { error: true }
const home = makeTempDir('cogent-output-home-')
const cwd = makeTempDir('cogent-output-ws-')
const actions: Action[] = []
const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
let held: ServerResponse | undefined
let engine: EngineHandle
let port: number
let call = 0
const server = createServer((request, response) => {
  let body = ''
  request.on('data', (part: Buffer) => { body += part.toString() })
  request.on('end', () => {
    requests.push(JSON.parse(body) as typeof requests[number])
    const action = actions.shift()
    if (action === undefined) { response.writeHead(500); response.end('没有预定模型动作'); return }
    if ('error' in action) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: '真实provider失败测试', type: 'invalid_request_error' } })); return }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if ('hold' in action) { held = response; return }
    if ('tool' in action) {
      response.write(sse(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: action.id ?? `call-${++call}`, type: 'function', function: { name: action.tool, arguments: JSON.stringify(action.args) } }] })))
      response.write(sse(chunk({}, 'tool_calls')))
    } else {
      response.write(sse(chunk({ role: 'assistant', content: action.text })))
      const output = action.finish === 'length' ? 4096 : 3
      response.write(sse(chunk({}, action.finish ?? 'stop', { usage: { prompt_tokens: 10, completion_tokens: output, total_tokens: output + 10 } })))
    }
    response.end('data: [DONE]\n\n')
  })
})
async function setup() {
  await initEngine(engine, { client: 'outputs-test', port, providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: [], modelDefs: [{ id: 'mock', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] }] })
}
async function create() {
  const { result } = await engine.send('session.create', { cwd, permissionMode: 'auto' })
  return result!.id!
}
async function submit(sessionId: string, text = '交付文件') {
  const result = await engine.send('agent.submit', { sessionId, text, model: 'mock' })
  expect(result.error).toBeUndefined()
  return engine.waitEvent('run.completed', (p) => p.sessionId === sessionId, 20_000)
}
async function docs(sessionId: string) { const result = await engine.send<TurnOutputs[]>('outputs.get', { sessionId }); expect(result.error).toBeUndefined(); return result.result! }
const report = (paths: string[], id?: string): Action => ({ tool: 'report_outputs', args: { deliverables: paths.map((path) => ({ path, note: '测试交付' })) }, id })
async function readDelivery(sessionId: string, doc: TurnOutputs) {
  const resolved = await engine.send<FileDescriptor>('outputs.resolve', { sessionId, turnId: doc.turnId, revision: doc.revision, outputId: doc.published[0].outputId, version: 'delivery' })
  expect(resolved.error).toBeUndefined()
  const read = await engine.send<{ base64: string }>('files.readChunk', { sessionId, fileId: resolved.result!.fileId, version: resolved.result!.version, operationId: crypto.randomUUID(), offset: 0, length: 1000 })
  expect(read.error).toBeUndefined()
  return Buffer.from(read.result!.base64, 'base64').toString('utf8')
}

describe('产物正式交付链', () => {
  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    port = (server.address() as { port: number }).port
    engine = startEngine(home); await setup()
    writeFileSync(join(cwd, '报告 #%.txt'), '\ufeffA\r\n')
    writeFileSync(join(cwd, 'B.zip'), 'existing zip bytes')
  })
  afterAll(() => { held?.destroy(); engine.kill(); server.close(); removeDir(home); removeDir(cwd) })

  it('真实write→申报→再次write→终态复核，并在删除源/Host重启后读取相同交付字节', async () => {
    const sid = await create()
    const count = requests.length
    actions.push({ tool: 'write', args: { path: '交付.txt', content: '申报时A' } }, report(['交付.txt']), { tool: 'write', args: { path: '交付.txt', content: '\ufeff最终B\r\n' } }, { text: '完成 `交付.txt`' })
    const terminal = await submit(sid)
    expect(requests.length - count).toBe(4)
    expect(JSON.stringify(requests.slice(count))).toContain('如有需要单独交给用户的文件')
    const [doc] = await docs(sid)
    expect(doc).toMatchObject({ state: 'ready', outcome: 'completed', declared: true })
    const events = engine.events.filter((event) => event.params.sessionId === sid)
    const publishAt = events.findIndex((event) => event.method === 'outputs.updated' && event.params.state === 'ready')
    expect(publishAt).toBeLessThan(events.indexOf(terminal))
    expect(events.filter((event) => event.method.startsWith('run.') && event.method !== 'run.started')).toHaveLength(1)
    rmSync(join(cwd, '交付.txt'))
    expect(await readDelivery(sid, doc)).toBe('\ufeff最终B\r\n')
    engine.kill(); engine = startEngine(home); await setup()
    expect(await readDelivery(sid, (await docs(sid))[0])).toBe('\ufeff最终B\r\n')
  })
  it('申报既有ZIP无须改写；非法申报保留；[]撤回后刷新不补卡', async () => {
    const sid = await create()
    actions.push(report(['B.zip', '报告 #%.txt'], 'good'), report(['missing.txt'], 'invalid'), { text: '完成' })
    await submit(sid)
    const [doc] = await docs(sid)
    expect(doc.published.map((item) => item.name)).toEqual(['B.zip', '报告 #%.txt'])
    expect(engine.events.find((e) => e.method === 'tool.completed' && e.params.callId === 'invalid')!.params.isError).toBe(true)
    const empty = await create()
    actions.push(report(['B.zip']), report([]), { text: '不交付文件' })
    await submit(empty)
    expect((await docs(empty))[0]).toMatchObject({ declared: true, active: [], published: [] })
    expect(readFileSync(join(cwd, 'B.zip'), 'utf8')).toBe('existing zip bytes')
  })
  it('漏报不造卡；正文提路径不自动交付，关闭自动标题时普通聊天无额外模型请求', async () => {
    const sid = await create(); const count = requests.length
    actions.push({ text: '参考 [ZIP](B.zip)，这里只是正文链接' })
    await submit(sid)
    expect(await docs(sid)).toEqual([]); expect(requests.length - count).toBe(1)
  })
  it('ask_user挂起不发布正式卡，停止仍结算已确认文件且唯一aborted终态', async () => {
    const sid = await create()
    actions.push(report(['B.zip']), { tool: 'ask_user', args: { questions: [{ question: '继续吗？', options: [{ label: '是' }, { label: '否' }] }] } })
    await engine.send('agent.submit', { sessionId: sid, text: '申报后询问', model: 'mock' })
    await engine.waitEvent('question.asked', (p) => p.sessionId === sid)
    expect((await docs(sid))[0]).toMatchObject({ state: 'running', published: [] })
    await engine.send('agent.abort', { sessionId: sid })
    const terminal = await engine.waitEvent('run.failed', (p) => p.sessionId === sid)
    expect(terminal.params.reason).toBe('aborted')
    expect((await docs(sid))[0]).toMatchObject({ state: 'ready', outcome: 'aborted', published: [{ name: 'B.zip' }] })
    expect(actions).toEqual([])
  })
  it('自动续写只在最后发布；手动继续沿用turn和旧卡，清空后只剩一次发布', async () => {
    const sid = await create()
    actions.push(report(['B.zip']), ...Array.from({ length: 4 }, () => ({ text: '截断片段', finish: 'length' as const })))
    await submit(sid)
    const [first] = await docs(sid)
    expect(first.published).toHaveLength(1)
    expect(engine.events.filter((e) => e.method === 'outputs.updated' && e.params.sessionId === sid && e.params.state === 'ready')).toHaveLength(1)
    actions.push(report([]), { text: '继续结束' })
    const continued = engine.send('session.continue', { sessionId: sid })
    await engine.waitEvent('run.completed', (p) => p.sessionId === sid)
    expect((await continued).error).toBeUndefined()
    const [last] = await docs(sid)
    expect(last.turnId).toBe(first.turnId); expect(last.published).toEqual([])
  })
  it('真实provider失败保留确认文件，卡片结果为error而非完整任务成功', async () => {
    const sid = await create()
    actions.push(report(['B.zip']), { error: true })
    await engine.send('agent.submit', { sessionId: sid, text: '失败场景', model: 'mock' })
    const terminal = await engine.waitEvent('run.failed', (p) => p.sessionId === sid, 20000)
    expect(terminal.params.reason).toBe('error')
    expect((await docs(sid))[0]).toMatchObject({ state: 'ready', outcome: 'error', published: [{ name: 'B.zip' }] })
  })
})
