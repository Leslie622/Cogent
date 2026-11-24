/** 真 Host/pi/工具的换根回归：工作 cwd、配置与来源一起变，JSONL 原位置不变。 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { ChatMessage, ProjectSummary, SessionSummary } from '../../src/protocol'
import { findPiTranscriptFile } from '../../src/host/kernel/transcript'
import { chunk, closeLoopback, initEngine, listenLoopback, makeTempDir, removeDir, sse, startEngine } from './harness'

type Action = { text: string } | { tool: 'read' | 'write' | 'powershell' | 'bash'; args: Record<string, string> }
interface RequestBody { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> }
async function fixture() {
  const home = makeTempDir('cogent-roots-')
  writeFileSync(join(home, 'marker.txt'), 'FILE_CONTENT_HOME')
  const roots = Object.fromEntries(['A', 'B', 'C', 'D'].map(name => {
    const path = join(home, name)
    mkdirSync(join(path, '.cogent', 'skills', `skill-${name.toLowerCase()}`), { recursive: true })
    writeFileSync(join(path, 'AGENTS.md'), `ROOT_INSTRUCTION_${name}`)
    writeFileSync(join(path, 'marker.txt'), `FILE_CONTENT_${name}`)
    writeFileSync(join(path, '.cogent', 'skills', `skill-${name.toLowerCase()}`, 'SKILL.md'), `---\nname: skill-${name.toLowerCase()}\ndescription: SKILL_DESCRIPTION_${name}\n---\n技能正文`)
    return [name, path]
  })) as Record<'A' | 'B' | 'C' | 'D', string>
  const actions: Action[] = [], requests: RequestBody[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (data: string) => { body += data })
    request.on('end', () => {
      requests.push(JSON.parse(body) as RequestBody)
      const action = actions.shift() ?? { text: '完成' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if ('tool' in action) response.write(sse(chunk({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: action.tool, arguments: JSON.stringify(action.args) } }] })) + sse(chunk({}, 'tool_calls')))
      else response.write(sse(chunk({ content: action.text })) + sse(chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })))
      response.end('data: [DONE]\n\n')
    })
  })
  const port = await listenLoopback(server)
  let engine = startEngine(home)
  await initEngine(engine, { client: 'root-test', providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock'] }] })
  const project = (await engine.send<{ summary: ProjectSummary }>('project.create', { name: '项目', cwds: [roots.A] })).result!.summary
  const create = async (cwd?: string) => (await engine.send<SessionSummary>('session.create', { projectId: project.id, ...(cwd && { cwd }), permissionMode: 'ask' })).result!
  const run = async (id: string, text: string, withRead = true) => {
    const start = requests.length
    if (withRead) actions.push({ tool: 'read', args: { path: 'marker.txt' } })
    actions.push({ text: `回答 ${text}` })
    expect((await engine.send('agent.submit', { sessionId: id, text, model: 'mock' })).error).toBeUndefined()
    try { await engine.waitEvent('run.completed', params => params.sessionId === id) }
    catch (cause) { throw new Error(`${text}: ${JSON.stringify(engine.events.findLast(event => event.method === 'run.failed' && event.params.sessionId === id)?.params)}`, { cause }) }
    return requests.slice(start)
  }
  return { home, roots, actions, requests, project, create, run, get engine() { return engine },
    restart: async () => { await engine.stop(); engine = startEngine(home); await engine.send('initialize', { client: 'root-restart', protocolVersion: 3, credentials: { 'custom/mock': { apiKey: 'sk-mock' } } }) },
    close: async () => { await engine.stop(); await closeLoopback(server); removeDir(home) } }
}

const prompt = (request: RequestBody): string => JSON.stringify(request.messages.filter(message => message.role === 'system'))
const toolResult = (request: RequestBody): string => JSON.stringify(request.messages.filter(message => message.role === 'tool'))

it('A→B 的指令/技能/MCP/相对工具和新来源一致，显式 cwd、多根与原历史保持各自归属', async () => {
  const f = await fixture()
  try {
    const { A, B, C, D } = f.roots
    await f.engine.send('mcp.sync', { servers: [{ name: 'roots', type: 'stdio', command: process.execPath,
      args: [resolve('tests/integration/mock-mcp-server.mjs')], exposure: 'direct' }] })
    writeFileSync(join(B, '.cogent', 'mcp.json'), JSON.stringify({ mcpServers: { roots: { enabled: false } } }))
    const inherited = await f.create(), explicit = await f.create(C), lazy = await f.create()
    const first = await f.run(inherited.id, '根 A')
    expect(prompt(first[0])).toContain('ROOT_INSTRUCTION_A')
    expect(first[0].tools?.some(tool => tool.function.name === 'mcp__roots__echo')).toBe(true)
    const originalFile = findPiTranscriptFile(A, f.home, inherited.id)!
    const originalBytes = readFileSync(originalFile, 'utf8')
    await f.run(explicit.id, '显式 C 原回合')
    expect((await f.engine.send('project.update', { projectId: f.project.id, name: '换根', cwds: [B, D] })).error).toBeUndefined()
    const second = await f.run(inherited.id, '根 B')
    expect(prompt(second[0])).toContain('ROOT_INSTRUCTION_B')
    expect(prompt(second[0])).toContain('ROOT_INSTRUCTION_D')
    expect(prompt(second[0])).not.toContain('ROOT_INSTRUCTION_A')
    expect(prompt(second[0])).toContain('SKILL_DESCRIPTION_B')
    expect(prompt(second[0])).not.toContain('SKILL_DESCRIPTION_A')
    expect(second[0].tools?.some(tool => tool.function.name === 'mcp__roots__echo')).toBe(false)
    expect(toolResult(second[1])).toContain('FILE_CONTENT_B')
    await f.engine.send('session.setPermission', { sessionId: inherited.id, mode: 'auto' })
    f.actions.push({ tool: process.platform === 'win32' ? 'powershell' : 'bash', args: { command: process.platform === 'win32' ? '(Get-Location).Path' : 'pwd' } })
    const shell = await f.run(inherited.id, '检查命令目录', false)
    expect(toolResult(shell[1])).toContain(JSON.stringify(B).slice(1, -1))
    expect(readFileSync(originalFile, 'utf8').startsWith(originalBytes)).toBe(true)
    expect(findPiTranscriptFile(B, f.home, inherited.id)).toBeUndefined()
    const history = (await f.engine.send<{ messages: ChatMessage[] }>('session.messages', { sessionId: inherited.id })).result!.messages
    const users = history.filter(message => message.role === 'user')
    expect(users.map(message => message.fileContext)).toMatchObject([
      { cwd: A, roots: [A] }, { cwd: B, roots: [B, D] }, { cwd: B, roots: [B, D] }
    ])
    const explicitResult = await f.run(explicit.id, '显式 C 新回合')
    expect(toolResult(explicitResult[1])).toContain('FILE_CONTENT_C')
    expect(prompt(explicitResult[0])).toContain('ROOT_INSTRUCTION_B')
    expect(prompt(explicitResult[0])).not.toContain('ROOT_INSTRUCTION_A')
    const lazyResult = await f.run(lazy.id, '首次发送')
    expect(toolResult(lazyResult[1])).toContain('FILE_CONTENT_B')
    expect(findPiTranscriptFile(A, f.home, lazy.id)).toBeDefined()
    await f.restart()
    const restored = await f.run(inherited.id, '重启后的 B')
    expect(toolResult(restored[1])).toContain('FILE_CONTENT_B')
    expect((await f.engine.send<{ messages: ChatMessage[] }>('session.messages', { sessionId: inherited.id })).result!.messages[0].fileContext?.cwd).toBe(A)
    expect((await f.engine.send('session.delete', { sessionId: inherited.id })).result).toEqual({ deleted: true })
    expect(existsSync(originalFile)).toBe(false)
  } finally { await f.close() }
})

it('审批中拒绝换根/移除，B 的相对写入不能沿用 A 的信任，旧回合续写不能改写来源', async () => {
  const f = await fixture()
  try {
    const session = await f.create()
    for (const [index, root] of [f.roots.A, f.roots.B].entries()) {
      if (index === 1) {
        await f.engine.send('project.update', { projectId: f.project.id, name: 'B', cwds: [root] })
        expect((await f.engine.send('session.continue', { sessionId: session.id })).error?.message).toContain('目录已变化')
      }
      f.actions.push({ tool: 'write', args: { path: 'written.txt', content: `写入 ${index}` } }, { text: '已写入' })
      await f.engine.send('agent.submit', { sessionId: session.id, text: `写入 ${index}`, model: 'mock' })
      const approval = await f.engine.waitEvent('approval.request', params => params.sessionId === session.id)
      expect(approval.params.outsideRoots).not.toBe(true)
      expect((await f.engine.send('project.update', { projectId: f.project.id, name: '忙', cwds: [f.roots.D] })).error?.message).toContain('正在工作')
      expect((await f.engine.send('project.delete', { projectId: f.project.id })).error?.message).toContain('正在工作')
      // 只改名不换根可在运行时完成。
      expect((await f.engine.send('project.update', { projectId: f.project.id, name: '改名', cwds: [root] })).error).toBeUndefined()
      await f.engine.send('approval.respond', { requestId: approval.params.requestId, approved: true, always: 'workspace' })
      await f.engine.waitEvent('run.completed', params => params.sessionId === session.id)
      expect(readFileSync(join(root, 'written.txt'), 'utf8')).toBe(`写入 ${index}`)
    }
  } finally { await f.close() }
})

it('移除空闲项目后会话回落主目录，旧转录及显式 cwd 不丢失', async () => {
  const f = await fixture()
  try {
    const inherited = await f.create(), explicit = await f.create(f.roots.C)
    await f.run(inherited.id, '移除前')
    expect((await f.engine.send('project.delete', { projectId: f.project.id })).result).toEqual({ deleted: true })
    expect(toolResult((await f.run(inherited.id, '移除后'))[1])).toContain('FILE_CONTENT_HOME')
    expect(toolResult((await f.run(explicit.id, '显式 cwd'))[1])).toContain('FILE_CONTENT_C')
    const history = (await f.engine.send<{ messages: ChatMessage[] }>('session.messages', { sessionId: inherited.id })).result!.messages
    expect(history.filter(message => message.role === 'user').map(message => message.fileContext)).toMatchObject([
      { cwd: f.roots.A, roots: [f.roots.A] }, { cwd: f.home, roots: [] }
    ])
  } finally { await f.close() }
})
