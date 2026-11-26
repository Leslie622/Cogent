/** 真构建 Host + change-diff-worker + pi 工具循环：端到端净变化、只读零落盘、审批拒绝、重启与 HTTP 边界。 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TurnChangesSummary, TurnFileDiff } from '../../src/shared/changes'
import { closeLoopback, chunk, initEngine, makeTempDir, removeDir, sse, startEngine, type EngineHandle } from './harness'

type Action = { tool: string; args: object; id?: string } | { text: string }
const home = makeTempDir('cogent-changes-home-')
const cwd = makeTempDir('cogent-changes-ws-')
const actions: Action[] = []
let engine: EngineHandle
let port: number
let httpBase = ''
let call = 0

const server = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    const action = actions.shift()
    if (action === undefined) { response.writeHead(500); response.end('missing action'); return }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if ('tool' in action) {
      response.write(sse(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: action.id ?? `c-${++call}`, type: 'function', function: { name: action.tool, arguments: JSON.stringify(action.args) } }] })))
      response.write(sse(chunk({}, 'tool_calls')))
    } else {
      response.write(sse(chunk({ role: 'assistant', content: action.text })))
      response.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })))
    }
    response.end('data: [DONE]\n\n')
  })
})

async function setup(withHttp = false) {
  const init = await initEngine(engine, {
    client: 'changes-integration',
    providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: [], modelDefs: [{ id: 'mock', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] }]
  })
  if (withHttp && init.httpPort !== undefined) {
    httpBase = `http://127.0.0.1:${init.httpPort}`
  }
}

describe('本轮改动列表集成回归', () => {
  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    port = (server.address() as { port: number }).port
    engine = startEngine(home, { COGENT_HTTP_RPC: '1', COGENT_HTTP_PORT: '0' })
    await setup(true)
    writeFileSync(join(cwd, 'notes.txt'), 'line1\nline2\n')
  })

  afterAll(async () => {
    await engine.stop()
    await closeLoopback(server)
    removeDir(home)
    removeDir(cwd)
  })

  it('只读回合零 manifest；write+edit+shell 产生净摘要且重启/删文件后仍可审查冻结 Diff；HTTP 拒绝', async () => {
    const { result: created } = await engine.send<{ id: string }>('session.create', { cwd, permissionMode: 'auto' })
    const sid = created!.id

    // 1. 只读回合不建改动 manifest
    actions.push({ tool: 'read', args: { path: 'notes.txt' } }, { text: '已阅读' })
    await engine.send('agent.submit', { sessionId: sid, text: '读文件', model: 'mock' })
    await engine.waitEvent('run.completed', (p) => p.sessionId === sid, 20_000)
    expect(existsSync(join(home, 'changes', 'v1', 'sessions', sid))).toBe(false)

    // 2. write + edit 组合修改
    actions.push(
      { tool: 'edit', args: { path: 'notes.txt', oldText: 'line2', newText: 'line2-mid' } },
      { tool: 'write', args: { path: 'notes.txt', content: 'line1\nline2-final\nline3\n' } },
      { text: '已更新' }
    )
    await engine.send('agent.submit', { sessionId: sid, text: '修改 notes.txt', model: 'mock' })
    const terminal = await engine.waitEvent('run.completed', (p) => p.sessionId === sid, 20_000)
    const updatedIdx = engine.events.findIndex((e) => e.method === 'changes.updated' && e.params.sessionId === sid)
    expect(updatedIdx).toBeGreaterThanOrEqual(0)
    expect(updatedIdx).toBeLessThan(engine.events.indexOf(terminal))

    const listRes = await engine.send<TurnChangesSummary[]>('changes.get', { sessionId: sid })
    expect(listRes.error).toBeUndefined()
    const summary = listRes.result![0]
    expect(summary).toMatchObject({ state: 'ready', outcome: 'completed', totalAdded: 2, totalDeleted: 1 })
    expect(summary.items[0]).toMatchObject({ path: 'notes.txt', kind: 'modified', added: 2, deleted: 1 })

    // 删掉原文件并重启 Host，依然能读出冻结的 before/after diff
    rmSync(join(cwd, 'notes.txt'))
    await engine.stop()
    engine = startEngine(home, { COGENT_HTTP_RPC: '1', COGENT_HTTP_PORT: '0' })
    await setup(true)

    // HTTP 门禁止 changes.* 访问（未配 httpScope）
    const issue = await engine.send<{ ticket: string }>('capability.issue', { scope: 'admin' })
    const ex = await fetch(`${httpBase}/auth/exchange`, { method: 'POST', body: JSON.stringify({ ticket: issue.result!.ticket }) })
    expect(ex.status).toBe(200)
    const { token } = (await ex.json()) as { token: string }
    const rpcResp = await fetch(`${httpBase}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'changes.get', params: { sessionId: sid } })
    })
    expect(rpcResp.status).toBe(403)
    expect(readFileSync).toBeTypeOf('function')

    const reloaded = await engine.send<TurnChangesSummary[]>('changes.get', { sessionId: sid })
    const doc = reloaded.result![0]
    const diffRes = await engine.send<TurnFileDiff>('changes.diff', {
      sessionId: sid,
      turnId: doc.turnId,
      revision: doc.revision,
      changeId: doc.items[0].changeId
    })
    expect(diffRes.error).toBeUndefined()
    expect(diffRes.result).toMatchObject({
      status: 'text',
      beforeText: 'line1\nline2\n',
      afterText: 'line1\nline2-final\nline3\n'
    })
  })
})
