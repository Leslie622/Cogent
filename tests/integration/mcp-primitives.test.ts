/** MCP 升级黑盒：真实 Host RPC、pi延迟工具、审批档位、项目信任与交互原语。 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { McpElicitationRequest, McpListResult, McpPromptInfo, McpResourceInfo, McpServerDef } from '../../src/protocol'
import { chunk, closeLoopback, initEngine, listenLoopback, makeTempDir, removeDir, sse, startEngine } from './harness'

const home = makeTempDir('cogent-mcp-upgrade-home-')
const workspace = makeTempDir('cogent-mcp-upgrade-ws-')
const projectRoot = makeTempDir('cogent-mcp-upgrade-project-')
const mock = join(process.cwd(), 'tests', 'integration', 'mock-mcp-server.mjs')
const def: McpServerDef = { name: 'mock', type: 'stdio', command: process.execPath, args: [mock] }
type Action = { tool: string; args: Record<string, unknown>; callId: string } | { text: string }
const actions: Action[] = []
const bodies: Array<Record<string, unknown>> = []
const llm = createServer((req, res) => {
  let body = ''
  req.on('data', (data) => { body += data })
  req.on('end', () => {
    bodies.push(JSON.parse(body) as Record<string, unknown>)
    const action = actions.shift() ?? { text: 'done' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if ('tool' in action) {
      res.write(sse(chunk({ tool_calls: [{ index: 0, id: action.callId, type: 'function', function: { name: action.tool, arguments: JSON.stringify(action.args) } }] })))
      res.write(sse(chunk({}, 'tool_calls')))
    } else {
      res.write(sse(chunk({ content: action.text })))
      res.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
    }
    res.end('data: [DONE]\n\n')
  })
})
const engine = startEngine(home, { COGENT_TEST_HOST_API_KEY: 'host-must-not-inherit', COGENT_MCP_TEST_TOKEN: 'server-only-env-token' })
let serial = 0
const tool = (name: string, args: Record<string, unknown> = {}): Action => ({ tool: name, args, callId: `mcp-upgrade-${++serial}` })
const text = (value = 'done'): Action => ({ text: value })
async function session(mode = 'auto'): Promise<string> {
  const result = await engine.send('session.create', { cwd: workspace, permissionMode: mode })
  expect(result.error).toBeUndefined()
  return result.result!.id!
}
async function submit(id: string, sequence: Action[], extra: Record<string, unknown> = {}): Promise<void> {
  actions.push(...sequence)
  const result = await engine.send('agent.submit', { sessionId: id, text: 'MCP test', model: 'mock', ...extra })
  expect(result.error).toBeUndefined()
  expect(result.result?.accepted).toBe(true)
}
async function complete(id: string): Promise<void> { await engine.waitEvent('run.completed', (params) => params.sessionId === id, 30_000) }

describe('MCP 升级协议与会话闭环', () => {
  beforeAll(async () => {
    const port = await listenLoopback(llm)
    await initEngine(engine, { client: 'mcp-upgrade', providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock'] }] })
  }, 60_000)
  afterAll(async () => {
    await engine.stop()
    await closeLoopback(llm)
    for (const root of [home, workspace, projectRoot]) removeDir(root)
  })

  it('默认deferred经tool_search激活，配置热禁用影响同一会话下一回合', async () => {
    expect((await engine.send('mcp.sync', { servers: [def] })).error).toBeUndefined()
    const list = await engine.send<McpListResult>('mcp.list', { cwd: workspace })
    expect(list.result?.servers[0]).toMatchObject({ exposure: 'deferred', runtime: { state: 'connected' } })
    const id = await session()
    const start = bodies.length
    await submit(id, [tool('tool_search', { query: 'mock echo' }), tool('mcp__mock__echo', { text: 'deferred-result' }), text()])
    await complete(id)
    expect(JSON.stringify(bodies[start].tools)).toContain('tool_search')
    expect(JSON.stringify(bodies[start].tools)).not.toContain('mcp__mock__echo')
    expect(JSON.stringify(bodies[start + 1].tools)).toContain('mcp__mock__echo')
    expect(JSON.stringify(bodies[start + 2])).toContain('echo: deferred-result')
    await engine.send('mcp.sync', { servers: [{ ...def, enabled: false }] })
    const disabledStart = bodies.length
    await submit(id, [text('disabled')]); await complete(id)
    expect(JSON.stringify(bodies[disabledStart].tools)).not.toContain('mcp__mock__echo')
  }, 45_000)

  it('Resources与Prompts RPC可读，显式输入引用保留原用户文本', async () => {
    await engine.send('mcp.sync', { servers: [{ ...def, exposure: 'direct' }] })
    const resources = await engine.send<{ resources: McpResourceInfo[]; resourceTemplates: unknown[] }>('mcp.resources.list', { cwd: workspace })
    expect(resources.result?.resources).toContainEqual(expect.objectContaining({ server: 'mock', uri: 'fixture://readme' }))
    expect(resources.result?.resourceTemplates).toHaveLength(1)
    const read = await engine.send<{ contents: Array<{ text: string }> }>('mcp.resources.read', { cwd: workspace, server: 'mock', uri: 'fixture://readme' })
    expect(read.result?.contents[0].text).toContain('RESOURCE CONTENT')
    const prompts = await engine.send<{ prompts: McpPromptInfo[] }>('mcp.prompts.list', { cwd: workspace })
    expect(prompts.result?.prompts[0]).toMatchObject({ server: 'mock', name: 'review', arguments: [{ name: 'subject', required: true }] })
    const id = await session(); const start = bodies.length
    await submit(id, [text()], {
      text: '展示引用', mcpResources: [{ server: 'mock', uri: 'fixture://readme' }],
      mcpPrompts: [{ server: 'mock', name: 'review', arguments: { subject: 'upgrade' } }]
    })
    await complete(id)
    expect(JSON.stringify(bodies[start])).toContain('RESOURCE CONTENT')
    expect(JSON.stringify(bodies[start])).toContain('PROMPT CONTENT: review upgrade')
    const history = await engine.send('session.messages', { sessionId: id })
    expect(history.result?.messages?.find((message) => message.role === 'user')?.content).toBe('展示引用')
  }, 45_000)

  it('只读Annotations在ask询问、auto/plan放行，破坏工具在plan被拦', async () => {
    const askId = await session('ask')
    await submit(askId, [tool('mcp__mock__echo', { text: 'ask-read' }), text()])
    const approval = await engine.waitEvent('approval.request', (params) => params.sessionId === askId, 30_000)
    expect(approval.params.kind).toBe('read')
    expect(approval.params.mcpMeta).toMatchObject({ serverName: 'mock', originalToolName: 'echo', destructive: false })
    await engine.send('approval.respond', { requestId: approval.params.requestId, approved: true })
    await complete(askId)
    expect(engine.events.filter((event) => event.method === 'changes.updated' && event.params.sessionId === askId)).toEqual([])
    expect((await engine.send<unknown[]>('changes.get', { sessionId: askId })).result).toEqual([])
    for (const planEnabled of [false, true]) {
      const id = await session()
      if (planEnabled) await engine.send('session.setPlanMode', { sessionId: id, enabled: true })
      const start = engine.events.length
      await submit(id, [tool('mcp__mock__echo', { text: 'auto-read' }), text()]); await complete(id)
      expect(engine.events.slice(start).filter((event) => event.method === 'approval.request')).toEqual([])
      expect(engine.events.slice(start).find((event) => event.method === 'tool.started')?.params.kind).toBe('read')
      if (planEnabled) {
        const call = tool('mcp__mock__destructive_echo', { text: 'blocked' })
        await submit(id, [call, text()]); await complete(id)
        expect(engine.events.find((event) => event.method === 'tool.completed' && event.params.callId === ('callId' in call ? call.callId : ''))?.params.isError).toBe(true)
      }
    }
    const destructiveId = await session('ask')
    await submit(destructiveId, [tool('mcp__mock__destructive_echo', { text: 'risk' }), text()])
    const risk = await engine.waitEvent('approval.request', (params) => params.sessionId === destructiveId, 30_000)
    expect(risk.params.kind).toBe('exec')
    expect(risk.params.mcpMeta).toMatchObject({ destructive: true, openWorld: true })
    await engine.send('approval.respond', { requestId: risk.params.requestId, approved: false }); await complete(destructiveId)
    // 非只读 MCP 经 mcpAlways 放行后，后续直接放行回合仍须进入改动追踪（不能因 allowsMcp 短路漏追踪）
    await submit(destructiveId, [tool('mcp__mock__destructive_echo', { text: 'allow-always' }), text()])
    const riskAllow = await engine.waitEvent('approval.request', (params) => params.sessionId === destructiveId, 30_000)
    await engine.send('approval.respond', { requestId: riskAllow.params.requestId, approved: true, mcpAlways: 'tool' })
    await complete(destructiveId)
    const beforeAutoTurn = engine.events.length
    await submit(destructiveId, [tool('mcp__mock__destructive_echo', { text: 'auto-after-always' }), text()])
    await complete(destructiveId)
    expect(engine.events.slice(beforeAutoTurn).filter((event) => event.method === 'approval.request' && event.params.sessionId === destructiveId)).toEqual([])
    expect((await engine.send<unknown[]>('changes.get', { sessionId: destructiveId })).result).toHaveLength(2)
  }, 60_000)

  it('stdio宿主敏感env被剥离，环境变量仅显式注入声明键', async () => {
    await engine.send('mcp.sync', { servers: [{ ...def, exposure: 'direct', env: { EXPLICIT_API_KEY: '${env:COGENT_MCP_TEST_TOKEN}' } }] })
    const status = await engine.send<McpListResult>('mcp.list', { cwd: workspace })
    expect(JSON.stringify(status)).not.toContain('server-only-env-token')
    const id = await session(); const start = bodies.length
    await submit(id, [tool('mcp__mock__environment', { keys: ['COGENT_TEST_HOST_API_KEY', 'EXPLICIT_API_KEY'] }), text()]); await complete(id)
    expect(JSON.stringify(bodies[start + 1])).toContain('server-only-env-token')
    expect(JSON.stringify(bodies[start + 1])).not.toContain('host-must-not-inherit')
  }, 45_000)

  it('独立Host保存静态凭据和URL查询不依赖Electron，也不自动生成secret引用', async () => {
    const file = join(home, 'mcp.json')
    const literal = 'mcp-static-fixture-token'
    const remoteUrl = 'http://127.0.0.1:1/mcp?token=static-url-token'
    expect((await engine.send('mcp.sync', { servers: [
      { ...def, exposure: 'direct', env: { EXPLICIT_API_KEY: literal } },
      { name: 'url', type: 'http', enabled: false, url: remoteUrl }
    ] })).error).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toContain(literal)
    expect(readFileSync(file, 'utf8')).toContain(remoteUrl)
    expect(readFileSync(file, 'utf8')).not.toContain('${secret:')
    const id = await session(); const start = bodies.length
    await submit(id, [tool('mcp__mock__environment', { keys: ['EXPLICIT_API_KEY'] }), text()]); await complete(id)
    expect(JSON.stringify(bodies[start + 1])).toContain(literal)
  }, 45_000)

  it('未信任项目不spawn，摘要变化拒绝旧授权，项目身份隔离', async () => {
    const created = await engine.send<{ summary: { id: string } }>('project.create', { name: 'MCP project', cwds: [projectRoot] })
    const projectId = created.result!.summary.id
    const filePath = join(projectRoot, '.mcp.json'); const pidFile = join(projectRoot, 'server.pid')
    const projectDef = { command: process.execPath, args: [mock], env: { COGENT_TEST_PID_FILE: pidFile } }
    writeFileSync(filePath, JSON.stringify({ mcpServers: { projectmock: projectDef } }))
    const view = await engine.send<McpListResult>('mcp.list', { cwd: projectRoot, projectId })
    expect(view.result?.servers.find((server) => server.name === 'projectmock')?.runtime?.state).toBe('untrusted')
    expect(existsSync(pidFile)).toBe(false)
    const pending = view.result!.pendingTrustFiles![0]
    expect((await engine.send('mcp.probe', { cwd: projectRoot, projectId, def: { name: 'projectmock', type: 'stdio', ...projectDef } })).error).toBeDefined()
    expect((await engine.send('mcp.trust.decide', { cwd: projectRoot, projectId, filePath: pending.filePath, sha256: '0'.repeat(64), decision: 'trust' })).error).toBeDefined()
    expect(existsSync(pidFile)).toBe(false)
    expect((await engine.send('mcp.trust.decide', { cwd: projectRoot, projectId, filePath: pending.filePath, sha256: pending.sha256, decision: 'trust' })).error).toBeUndefined()
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const second = await engine.send<{ summary: { id: string } }>('project.create', { name: 'MCP same directory', cwds: [projectRoot] })
    const otherView = await engine.send<McpListResult>('mcp.list', { cwd: projectRoot, projectId: second.result!.summary.id })
    expect(otherView.result?.servers.find((server) => server.name === 'projectmock')?.runtime?.state).toBe('untrusted')
    writeFileSync(filePath, JSON.stringify({ mcpServers: { projectmock: { ...projectDef, description: 'changed' } } }))
    const changed = await engine.send<McpListResult>('mcp.list', { cwd: projectRoot, projectId })
    expect(changed.result?.servers.find((server) => server.name === 'projectmock')?.runtime?.state).toBe('untrusted')
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  }, 45_000)

  it('Elicitation Form/URL提交、非法字段拒绝、abort清理均能解除挂起', async () => {
    await engine.send('mcp.sync', { servers: [{ ...def, exposure: 'direct' }] })
    for (const mode of ['form', 'url'] as const) {
      const id = await session()
      await submit(id, [tool(`mcp__mock__ask_${mode}`), text()])
      const event = await engine.waitEvent('mcp.elicitation.request', (params) => params.sessionId === id, 30_000)
      const request = event.params as unknown as McpElicitationRequest
      expect(request).toMatchObject({ mode, server: 'mock' })
      if (mode === 'form') expect((await engine.send('mcp.elicitation.respond', { requestId: request.requestId, action: 'accept', content: { name: 'x' } })).error).toBeDefined()
      expect((await engine.send('mcp.elicitation.respond', { requestId: request.requestId, action: 'accept', ...(mode === 'form' ? { content: { name: 'valid project' } } : {}) })).error).toBeUndefined()
      await complete(id)
    }
    const abortId = await session()
    await submit(abortId, [tool('mcp__mock__ask_form')])
    const pending = await engine.waitEvent('mcp.elicitation.request', (params) => params.sessionId === abortId, 30_000)
    await engine.send('agent.abort', { sessionId: abortId })
    await engine.waitEvent('run.failed', (params) => params.sessionId === abortId, 30_000)
    expect((await engine.send('mcp.elicitation.respond', { requestId: pending.params.requestId, action: 'cancel' })).error).toBeDefined()
  }, 60_000)
})
