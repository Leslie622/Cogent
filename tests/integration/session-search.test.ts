/** 真 Host/worker/磁盘闭环：不挂 renderer 搜索历史、更新、归档/删除、重启，确认只读。 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { chunk, sse, initEngine, makeTempDir, removeDir, startEngine, type EngineHandle } from './harness'
import type { SearchPage } from '../../src/shared/session-search'
import type { ChatMessage } from '../../src/protocol'

let root: string, engine: EngineHandle, id: string, file: string, original: string
beforeAll(async () => {
  root = makeTempDir('cogent-search-protocol-'); id = randomUUID()
  mkdirSync(join(root, 'sessions'))
  file = join(root, 'sessions', `${id}.json`)
  original = JSON.stringify({ version: 1, summary: { id, title: '历史搜索测试', createdAt: 1, updatedAt: 2, cwd: root, projectId: 'removed-project' },
    transcript: [{ role: 'user', content: '用户说你好，请检查登录报错 100%_literal', timestamp: 1 }] })
  writeFileSync(file, original)
  engine = startEngine(root)
  await engine.send('initialize', { client: 'search-test', protocolVersion: 3 })
})
afterAll(() => { engine.kill(); removeDir(root) })

it('未打开的 v1 历史可搜，来源与历史接口一致，源文件不变', async () => {
  for (const query of ['你好', '登录报错', '100%_literal']) {
    const result = await engine.send<SearchPage>('session.search', { query })
    expect(result.error).toBeUndefined()
    expect(result.result!.issues).toEqual([])
    expect(result.result!.items[0].session.id).toBe(id)
    const history = await engine.send<{ messages: Array<{ sources: Array<{ id: string }> }> }>('session.messages', { sessionId: id })
    expect(result.result!.items[0].hits[0].anchor.sourceId).toBe(history.result!.messages[0].sources[0].id)
  }
  expect(readFileSync(file, 'utf8')).toBe(original)
})

it('重命名立即参与搜索，归档需显式包含，删除后不可复活', async () => {
  await engine.send('session.rename', { sessionId: id, title: 'changed-title' })
  expect((await engine.send<SearchPage>('session.search', { query: 'changed-title' })).result!.items[0].session.id).toBe(id)
  await engine.send('session.archive', { sessionId: id, archived: true })
  expect((await engine.send<SearchPage>('session.search', { query: '你好' })).result!.items).toEqual([])
  expect((await engine.send<SearchPage>('session.search', { query: '你好', includeArchived: true })).result!.items).toHaveLength(1)
  engine.kill(); engine = startEngine(root)
  await engine.send('initialize', { client: 'search-restart', protocolVersion: 3 })
  expect((await engine.send<SearchPage>('session.search', { query: '你好', includeArchived: true })).result!.items).toHaveLength(1)
  await engine.send('session.delete', { sessionId: id })
  expect((await engine.send<SearchPage>('session.search', { query: '你好', includeArchived: true })).result!.items).toEqual([])
  expect((await engine.send('session.search.rebuild', {})).result).toEqual({ ok: true })
})

it('入口拒绝非法查询，不把失败写成空结果', async () => {
  expect((await engine.send('session.search', { query: 'a', limit: -1 })).error).toBeDefined()
  expect((await engine.send('session.search', { query: '\0' })).error).toBeDefined()
})

it('真实 pi 直播终态与历史回查、搜索结果共享同一个提交来源', async () => {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(sse(chunk({ role: 'assistant', content: '直播来源回答 needlelive' })))
      response.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })))
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const port = (server.address() as AddressInfo).port
    await initEngine(engine, { client: 'live-search', port, providers: [{ id: 'custom/mock', name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock'] }] })
    const created = await engine.send<{ id: string }>('session.create', { cwd: root })
    const sessionId = created.result!.id
    expect((await engine.send('agent.submit', { sessionId, text: '你好', model: 'mock', provider: 'custom/mock' })).error).toBeUndefined()
    const completed = await engine.waitEvent('run.completed', (params) => params.sessionId === sessionId)
    const segments = completed.params.messages!
    const liveSource = segments.find((message) => message.content.includes('needlelive'))!.sources![0].id
    const history = await engine.send<{ messages: ChatMessage[] }>('session.messages', { sessionId })
    expect(history.result!.messages.find((message) => message.role === 'assistant')!.sources![0].id).toBe(liveSource)
    const searched = await engine.send<SearchPage>('session.search', { query: 'needlelive' })
    expect(searched.result!.items[0].hits[0].anchor.sourceId).toBe(liveSource)
    expect(engine.events.some((event) => event.method === 'message.source' && event.params.sourceId === liveSource)).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
