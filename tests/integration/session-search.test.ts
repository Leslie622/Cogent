/** 真 Host/worker/磁盘闭环：不挂 renderer 搜索历史、更新、归档/删除、重启，确认只读。 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { chunk, sse, initEngine, listenLoopback, makeTempDir, removeDir, startEngine, type EngineHandle } from './harness'
import type { SearchPage } from '../../src/shared/session-search'
import type { ChatMessage } from '../../src/protocol'
import { piSessionDir } from '../../src/host/kernel/transcript'

function mockModel(text: string) {
  return createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(sse(chunk({ role: 'assistant', content: text })))
      response.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })))
      response.end('data: [DONE]\n\n')
    })
  })
}

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
afterAll(async () => { await engine.stop(); removeDir(root) })

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
  await engine.stop(); engine = startEngine(root)
  await engine.send('initialize', { client: 'search-restart', protocolVersion: 3 })
  expect((await engine.send<SearchPage>('session.search', { query: '你好', includeArchived: true })).result!.items).toHaveLength(1)
  await engine.send('session.delete', { sessionId: id })
  expect((await engine.send<SearchPage>('session.search', { query: '你好', includeArchived: true })).result!.items).toEqual([])
  expect((await engine.send('session.search.rebuild', {})).result).toEqual({ ok: true })
})

it('恢复摘要后，未装配 pi 的会话也按原目录锚点删除转录', async () => {
  const home = makeTempDir('cogent-delete-history-')
  let restored: EngineHandle | undefined
  try {
    const sessionId = randomUUID()
    const projectId = randomUUID()
    const originalCwd = join(home, 'original')
    const newProjectCwd = join(home, 'new-project-root')
    const summaryPath = join(home, 'sessions', `${sessionId}.json`)
    const transcriptDirectory = piSessionDir(originalCwd, join(home, 'pi'))
    const transcriptPath = join(transcriptDirectory, `2026-01-01T00-00-00_${sessionId}.jsonl`)
    for (const directory of [originalCwd, newProjectCwd, join(home, 'sessions'), join(home, 'projects'), transcriptDirectory]) {
      mkdirSync(directory, { recursive: true })
    }
    writeFileSync(join(home, 'projects', `${projectId}.json`), JSON.stringify({
      version: 2, summary: { id: projectId, name: '项目', cwds: [newProjectCwd], createdAt: 1 }
    }))
    writeFileSync(summaryPath, JSON.stringify({
      version: 2, piCwd: originalCwd,
      summary: { id: sessionId, projectId, title: '待删除的历史会话', createdAt: 1, updatedAt: 2 }
    }))
    const timestamp = '2026-01-01T00:00:00Z'
    const content = '原工作目录的历史输入'
    writeFileSync(transcriptPath, [
      { type: 'session', version: 3, id: sessionId, cwd: originalCwd, timestamp },
      { type: 'message', id: '12345678', parentId: null, timestamp, message: { role: 'user', content, timestamp: 1 } }
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')

    restored = startEngine(home)
    await restored.send('initialize', { client: 'delete-restored-history', protocolVersion: 3 })
    const history = await restored.send<{ messages: ChatMessage[] }>('session.messages', { sessionId })
    expect(history.result?.messages).toEqual([expect.objectContaining({ role: 'user', content })])

    expect((await restored.send('session.delete', { sessionId })).result).toEqual({ deleted: true })
    expect(existsSync(summaryPath)).toBe(false)
    expect(existsSync(transcriptPath)).toBe(false)
  } finally {
    await restored?.stop()
    removeDir(home)
  }
})

it('入口拒绝非法查询，不把失败写成空结果', async () => {
  expect((await engine.send('session.search', { query: 'a', limit: -1 })).error).toBeDefined()
  expect((await engine.send('session.search', { query: '\0' })).error).toBeDefined()
})

it('真实 pi 直播终态与历史回查、搜索结果共享同一个提交来源', async () => {
  const server = mockModel('直播来源回答 needlelive')
  const port = await listenLoopback(server)
  try {
    await initEngine(engine, { client: 'live-search', providers: [{ id: 'custom/mock', name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock'] }] })
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

it('首次发送导入 v1 时，目录附件、回合和直播来源只绑定本轮输入', async () => {
  const server = mockModel('收到')
  const port = await listenLoopback(server)
  const home = makeTempDir('cogent-import-v1-')
  let restored: EngineHandle | undefined
  try {
    const sessionId = randomUUID()
    const directory = { kind: 'directory', name: '资料', path: join(home, '资料') }
    const summaryPath = join(home, 'sessions', `${sessionId}.json`)
    const oldText = '旧输入'
    const newText = '新输入'
    const inputId = 'current-input'
    mkdirSync(join(home, 'sessions'))
    mkdirSync(directory.path)
    writeFileSync(summaryPath, JSON.stringify({
      version: 1, summary: { id: sessionId, title: '旧会话', createdAt: 1, updatedAt: 2, cwd: home },
      transcript: [{ role: 'user', content: oldText, timestamp: 1 }]
    }))

    restored = startEngine(home)
    await initEngine(restored, { client: 'v1-import-test', providers: [{ id: 'custom/mock', name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock'] }] })
    const submitted = await restored.send('agent.submit', { sessionId, text: newText, model: 'mock', provider: 'custom/mock', inputId, directories: [directory] })
    expect(submitted.error).toBeUndefined()
    await restored.waitEvent('run.completed', (params) => params.sessionId === sessionId)

    const history = await restored.send<{ messages: ChatMessage[] }>('session.messages', { sessionId })
    const users = history.result!.messages.filter((message) => message.role === 'user')
    expect(users.map((message) => message.content)).toEqual([oldText, newText])
    expect(users[0].fileContext).toBeUndefined()
    expect(users[0].directories).toBeUndefined()
    expect(users[1]).toMatchObject({ turnId: inputId, directories: [directory], fileContext: { turnId: inputId } })
    const liveSources = restored.events.filter((event) => event.method === 'message.source' &&
      event.params.sessionId === sessionId && event.params.role === 'user')
    expect(liveSources.map((event) => event.params.sourceId)).toEqual([users[1].sources![0].id])
    expect(JSON.parse(readFileSync(summaryPath, 'utf8'))).toMatchObject({ version: 2, piCwd: home })
  } finally {
    await restored?.stop()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    removeDir(home)
  }
})
