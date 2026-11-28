/** MCP Host 池回归：真实协议消息、作用域隔离、热刷新与资源/提示词分页。 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpClient, type McpTransport, type JsonRpcMessage } from '@earendil-works/pi-mcp'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing'
import type { McpServerDef } from '../../../src/protocol'
import { McpConfigStore } from '../../../src/host/runtime/mcp-config'
import { McpRuntimeManager } from '../../../src/host/runtime/mcp-runtime'
import { McpTrustStore } from '../../../src/host/runtime/mcp-trust'
import { SseTransport } from '../../../src/host/runtime/mcp-transports'
import { createPiSession } from '../../../src/host/kernel/pi-session-factory'

const roots: string[] = []
const runtimes: McpRuntimeManager[] = []
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'cogent-mcp-runtime-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.disposeAll())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(config: McpConfigStore, root: string, options: {
  firstStart?: Promise<void>
  firstClose?: Promise<void>
  oauthAuthorized?: (def: McpServerDef, scope: { cwd?: string; projectId?: string }) => boolean
  holdCall?: { server: string; until: Promise<void> }
} = {}): {
  runtime: McpRuntimeManager
  starts: string[]
  servers: McpTransport[]
  toolNames: string[]
  requests: Array<{ method: string; params: Record<string, unknown> }>
  definitions: McpServerDef[]
} {
  const starts: string[] = []
  const servers: McpTransport[] = []
  const toolNames = ['echo']
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const definitions: McpServerDef[] = []
  const runtime = new McpRuntimeManager({ config, hostRoot: root, oauthAuthorized: options.oauthAuthorized, transportFactory: (def) => {
    starts.push(def.name)
    definitions.push(def)
    const pair = createInMemoryTransportPair()
    const [client, server] = [pair.client, pair.server]
    if (starts.length === 1 && options.firstStart !== undefined) {
      const start = client.start.bind(client)
      client.start = async () => { await options.firstStart; await start() }
    }
    if (starts.length === 1 && options.firstClose !== undefined) {
      const close = client.close.bind(client)
      client.close = async () => { await options.firstClose; await close() }
    }
    servers.push(server)
    server.onMessage((message: JsonRpcMessage) => {
      if (!('method' in message) || !('id' in message)) return
      const params = (message.params ?? {}) as Record<string, unknown>
      requests.push({ method: message.method, params })
      let result: unknown
      if (message.method === 'initialize') result = { protocolVersion: params.protocolVersion, serverInfo: { name: def.name, version: '1' }, capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } }
      else if (message.method === 'tools/list') result = { tools: toolNames.map((name) => ({ name, description: `${name} test`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } })) }
      else if (message.method === 'tools/call') result = (params.arguments as Record<string, unknown>).text === 'empty-error'
        ? { content: [], isError: true } : { content: [{ type: 'text', text: `echo:${JSON.stringify(params.arguments)}` }], structuredContent: { ok: true } }
      else if (message.method === 'resources/list') result = { resources: [{ uri: 'memory://test', name: 'test' }] }
      else if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'memory://{name}', name: 'template' }] }
      else if (message.method === 'resources/read') result = { contents: [{ uri: params.uri, text: 'resource text' }] }
      else if (message.method === 'prompts/list') result = params.cursor === undefined ? { prompts: [{ name: 'one' }], nextCursor: 'next' } : { prompts: [{ name: 'two' }] }
      else if (message.method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: `prompt:${String(params.name)}` } }] }
      else result = {}
      if (message.method === 'tools/call' && options.holdCall?.server === def.name) {
        void options.holdCall.until.then(() => server.send({ jsonrpc: '2.0', id: message.id, result })).catch(() => undefined)
      } else void server.send({ jsonrpc: '2.0', id: message.id, result })
    })
    void server.start()
    return client
  } })
  runtimes.push(runtime)
  return { runtime, starts, servers, toolNames, requests, definitions }
}

describe('MCP runtime pool', () => {
  it('全局连接跨项目复用，工具默认deferred，资源/提示词完整读取', async () => {
    const root = temp(); const a = temp(); const b = temp()
    const config = new McpConfigStore(root)
    config.sync([{ name: 'echo', type: 'stdio', command: process.execPath }])
    const { runtime, starts, requests } = fixture(config, root)
    await Promise.all([runtime.ensureScope({ cwd: a, projectId: 'a' }), runtime.ensureScope({ cwd: b, projectId: 'b' })])
    expect(starts).toEqual(['echo'])
    expect(runtime.getTools({ cwd: a, projectId: 'a' })[0]).toMatchObject({ qualifiedName: 'mcp__echo__echo', effectiveExposure: 'deferred', annotations: { readOnlyHint: true } })
    const result = await runtime.callTool({ cwd: a, projectId: 'a' }, 'mcp__echo__echo', { text: 'hello' }, { sessionId: 's1' })
    expect(result.structuredContent).toEqual({ ok: true })
    expect((await runtime.resourcesList({ cwd: a, projectId: 'a' })).resources[0]).toMatchObject({ server: 'echo', uri: 'memory://test' })
    expect((await runtime.resourcesRead({ cwd: a, projectId: 'a' }, 'echo', 'memory://test')).contents[0]).toHaveProperty('text', 'resource text')
    expect((await runtime.promptsList({ cwd: a, projectId: 'a' })).prompts.map((prompt) => prompt.name)).toEqual(['one', 'two'])
    expect(requests.filter((request) => request.method === 'initialize')).toHaveLength(1)
    expect(JSON.stringify(requests.find((request) => request.method === 'initialize'))).not.toContain(a)
  })

  it('主目录会话（工作目录就是配置目录的上一级）复用全局连接，不降级成未受信的项目定义', async () => {
    const ws = temp(); const root = join(ws, '.cogent')
    mkdirSync(root)
    const config = new McpConfigStore(root)
    config.sync([{ name: 'echo', type: 'stdio', command: process.execPath }])
    const { runtime, starts } = fixture(config, root)
    const home = { cwd: ws, projectId: 'home' }
    await Promise.all([runtime.ensureScope({}), runtime.ensureScope(home)])
    expect(starts).toEqual(['echo'])
    expect(runtime.getStatuses(home)).toMatchObject([{ name: 'echo', poolKey: 'global:echo', state: 'connected' }])
    expect(runtime.getTools(home)).toHaveLength(1)
  })

  it('OAuth授权按真实连接身份投影，用户授权不混入项目同名定义', async () => {
    const root = temp(); const a = temp(); const b = temp()
    const trust = new McpTrustStore(root)
    const config = new McpConfigStore(root, trust)
    config.sync([
      { name: 'remote', type: 'http', url: 'https://user.example/mcp' },
      { name: 'public', type: 'sse', url: 'https://public.example/sse' }
    ])
    writeFileSync(join(a, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://project.example/mcp' } } }))
    trust.decide({ projectId: 'a', cwd: a, ...trust.inspect(join(a, '.mcp.json')), decision: 'trust' })
    let authorized = true
    const auth = vi.fn((def: McpServerDef, scope: { projectId?: string }) => authorized && def.name === 'remote' && scope.projectId === undefined)
    const { runtime } = fixture(config, root, { oauthAuthorized: auth })
    await runtime.ensureScope()
    await runtime.ensureScope({ projectId: 'a', cwd: a })
    await runtime.ensureScope({ projectId: 'b', cwd: b })
    expect(runtime.getStatuses().find((s) => s.name === 'remote')?.oauthAuthorized).toBe(true)
    expect(runtime.getStatuses().find((s) => s.name === 'public')?.oauthAuthorized).toBe(false)
    expect(runtime.getStatuses({ projectId: 'a', cwd: a }).find((s) => s.name === 'remote')?.oauthAuthorized).toBe(false)
    expect(runtime.getStatuses({ projectId: 'b', cwd: b }).find((s) => s.name === 'remote')?.oauthAuthorized).toBe(true)
    expect(auth).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://project.example/mcp' }), { projectId: 'a', cwd: a })
    authorized = false
    expect(runtime.getStatuses().find((s) => s.name === 'remote')?.oauthAuthorized).toBe(false)
  })

  it('list_changed替换缓存，配置禁用使旧工具不可调用', async () => {
    const root = temp(); const cwd = temp()
    const config = new McpConfigStore(root)
    const def: McpServerDef = { name: 'echo', type: 'stdio', command: process.execPath }
    config.sync([def])
    const { runtime, toolNames, servers } = fixture(config, root)
    await runtime.ensureScope({ cwd })
    toolNames.splice(0, 1, 'new_tool')
    await servers[0].send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    await vi.waitFor(() => expect(runtime.getTools({ cwd }).map((tool) => tool.name)).toEqual(['new_tool']))
    config.sync([{ ...def, enabled: false }])
    await runtime.refresh()
    expect(runtime.getStatuses({ cwd })[0].state).toBe('disabled')
    await expect(runtime.callTool({ cwd }, 'mcp__echo__new_tool', {})).rejects.toThrow('unavailable')
  })

  it.each(['disabled', 'hidden'] as const)('项目A的%s覆盖不会关闭或改变项目B的共享连接', async (policy) => {
    const root = temp(); const a = temp(); const b = temp()
    const config = new McpConfigStore(root)
    config.sync([{ name: 'echo', type: 'stdio', command: process.execPath }])
    const { runtime, starts } = fixture(config, root)
    const scopeA = { cwd: a, projectId: 'a' }; const scopeB = { cwd: b, projectId: 'b' }
    await runtime.ensureScope(scopeB)
    config.override(a, 'echo', policy === 'disabled' ? { enabled: false } : { toolExposure: { echo: 'hidden' } })
    await runtime.ensureScope(scopeA)
    expect(starts).toEqual(['echo'])
    if (policy === 'disabled') expect(runtime.getStatuses(scopeA)[0].state).toBe('disabled')
    else expect(runtime.getTools(scopeA)[0].effectiveExposure).toBe('hidden')
    await expect(runtime.callTool(scopeA, 'mcp__echo__echo', {})).rejects.toThrow('unavailable')
    await expect(runtime.callTool(scopeB, 'mcp__echo__echo', { text: 'project-b' })).resolves.toHaveProperty('structuredContent', { ok: true })
    expect(runtime.getTools(scopeB)[0].effectiveExposure).toBe('deferred')
    expect(starts).toEqual(['echo'])
    config.override(a, 'echo', { exposure: 'direct' })
    await runtime.refresh()
    expect(runtime.getTools(scopeA)[0].effectiveExposure).toBe('direct')
    expect(runtime.getTools(scopeB)[0].effectiveExposure).toBe('deferred')
    expect(starts).toEqual(['echo'])
  })

  it('保存发生在连接启动期间，refresh完成前交接到已提交的新配置', async () => {
    const root = temp(); const config = new McpConfigStore(root)
    const def: McpServerDef = { name: 'echo', type: 'stdio', command: process.execPath }
    config.sync([def])
    let release!: () => void
    const firstStart = new Promise<void>((resolve) => { release = resolve })
    const { runtime, definitions } = fixture(config, root, { firstStart })
    const starting = runtime.ensureScope()
    config.sync([{ ...def, args: ['new-config'] }])
    const refreshing = runtime.refresh()
    release()
    await Promise.all([starting, refreshing])
    expect(definitions).toHaveLength(2)
    expect(definitions[1]).toHaveProperty('args', ['new-config'])
    expect(runtime.getStatuses()[0].state).toBe('connected')
  })

  it('默认值中的嵌套占位符在诊断脱敏阶段也不递归展开', async () => {
    const root = temp(); const config = new McpConfigStore(root)
    config.sync([{ name: 'literal', type: 'stdio', command: process.execPath, args: ['${COGENT_TEST_UNDEFINED_7D91:-${LEAVE_LITERAL}}'] }])
    const { runtime, definitions } = fixture(config, root)
    await runtime.ensureScope()
    expect(runtime.getStatuses()[0].state).toBe('connected')
    expect(definitions[0]).toHaveProperty('args', ['${LEAVE_LITERAL}'])
  })

  it('两个作用域并发重连时，晚结束的旧关闭不能删除新代共享连接', async () => {
    const root = temp(); const a = temp(); const b = temp()
    const config = new McpConfigStore(root)
    config.sync([{ name: 'echo', type: 'stdio', command: process.execPath }])
    let release!: () => void
    const firstClose = new Promise<void>((resolve) => { release = resolve })
    const { runtime, starts } = fixture(config, root, { firstClose })
    const scopeA = { cwd: a, projectId: 'a' }; const scopeB = { cwd: b, projectId: 'b' }
    await Promise.all([runtime.ensureScope(scopeA), runtime.ensureScope(scopeB)])
    const slow = runtime.reconnect('echo', scopeA)
    try {
      await runtime.reconnect('echo', scopeB)
      expect(starts).toHaveLength(2)
    } finally { release() }
    await slow
    expect(starts).toHaveLength(2)
    expect(runtime.getStatuses(scopeA)[0].state).toBe('connected')
    expect(runtime.getStatuses(scopeB)[0].state).toBe('connected')
    await expect(runtime.callTool(scopeA, 'mcp__echo__echo', {})).resolves.toHaveProperty('structuredContent', { ok: true })
  })

  it('静态凭据修改只重建对应server，无关描述不会打断其他server的在途调用', async () => {
    const root = temp(); const config = new McpConfigStore(root)
    config.sync([
      { name: 'a', type: 'stdio', command: process.execPath, env: { ACCESS_TOKEN: 'a-old' },
        args: ['${COGENT_TEST_UNDEFINED_B572:-${UNRELATED}}'], description: 'original' },
      { name: 'b', type: 'stdio', command: process.execPath, env: { ACCESS_TOKEN: 'b-stable' } }
    ])
    let release!: () => void
    const until = new Promise<void>((resolve) => { release = resolve })
    const { runtime, starts, requests, definitions } = fixture(config, root, { holdCall: { server: 'b', until } })
    await runtime.ensureScope()
    expect(starts).toEqual(['a', 'b'])
    let settled = false
    const pending = runtime.callTool({}, 'mcp__b__echo', { text: 'kept-in-flight' }).then(
      (result) => { settled = true; return { result } },
      (error: unknown) => { settled = true; return { error } }
    )
    try {
      await vi.waitFor(() => expect(requests.some((request) => request.method === 'tools/call')).toBe(true))
      config.sync(config.list().servers.map(({ def }) => def.name === 'a' && def.type === 'stdio' ? { ...def, env: { ACCESS_TOKEN: 'a-new' } } : def))
      await runtime.refresh()
      expect(starts).toEqual(['a', 'b', 'a'])
      expect(definitions[2]).toHaveProperty('env.ACCESS_TOKEN', 'a-new')
      expect(settled).toBe(false)
      config.sync(config.list().servers.map(({ def }) => ({ ...def, description: 'unrelated' })))
      await runtime.refresh()
      expect(starts).toEqual(['a', 'b', 'a'])
      expect(settled).toBe(false)
    } finally { release() }
    expect(await pending).toHaveProperty('result.structuredContent', { ok: true })
    expect(runtime.getStatuses().every((status) => status.state === 'connected')).toBe(true)
  })

  it('项目路径依赖按项目隔离，未信任定义不启动', async () => {
    const root = temp(); const a = temp(); const b = temp()
    const config = new McpConfigStore(root, new McpTrustStore(root))
    config.sync([{ name: 'project', type: 'stdio', command: process.execPath, args: ['${workspaceFolder}'] }])
    mkdirSync(join(a, '.cogent'))
    writeFileSync(join(a, '.mcp.json'), JSON.stringify({ mcpServers: { danger: { command: 'never-run' } } }))
    const { runtime, starts } = fixture(config, root)
    await Promise.all([runtime.ensureScope({ cwd: a, projectId: 'a' }), runtime.ensureScope({ cwd: b, projectId: 'b' })])
    expect(starts).toEqual(['project', 'project'])
    expect(runtime.getStatuses({ cwd: a, projectId: 'a' }).find((status) => status.name === 'danger')?.state).toBe('untrusted')
    expect(runtime.getStatuses({ cwd: a, projectId: 'a' })[0].poolKey).not.toBe(runtime.getStatuses({ cwd: b, projectId: 'b' })[0].poolKey)
  })

  it('真实stdio进程随dispose退出并脱敏stderr', async () => {
    const root = temp(); const pidFile = join(root, 'pid.txt')
    const script = join(root, 'server.mjs')
    writeFileSync(script, `import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';writeFileSync(process.env.PID_FILE,String(process.pid));process.stderr.write('token='+process.env.TEST_API_KEY+'\\nawsvalue='+process.env.AWS_SECRET_ACCESS_KEY+'\\n');const r=createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{},serverInfo:{name:'test',version:'1'}}:{}})+'\\n')});`)
    const config = new McpConfigStore(root)
    config.sync([{ name: 'child', type: 'stdio', command: process.execPath, args: [script], env: { PID_FILE: pidFile, TEST_API_KEY: 'private-secret-value', AWS_SECRET_ACCESS_KEY: 'private-aws-fixture' } }])
    const runtime = new McpRuntimeManager({ config, hostRoot: root })
    runtimes.push(runtime)
    await runtime.ensureScope()
    expect(runtime.getStatuses()[0].state).toBe('connected')
    expect(JSON.stringify(runtime.getStatuses())).not.toContain('private-secret-value')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await runtime.disposeAll()
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
    expect(readFileSync(join(root, 'pi', 'mcp.log'), 'utf8')).not.toContain('private-secret-value')
    expect(readFileSync(join(root, 'pi', 'mcp.log'), 'utf8')).not.toContain('private-aws-fixture')
  })

  it('关闭真实stdio回收继承管道且忽略stdin的孙进程', async () => {
    const root = temp(); const pidFile = join(root, 'tree.json'); const script = join(root, 'tree.mjs')
    writeFileSync(script, `import{spawn}from'node:child_process';import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});child.unref();writeFileSync(process.env.PID_FILE,JSON.stringify([process.pid,child.pid]));createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{},serverInfo:{name:'tree',version:'1'}}:{}})+'\\n')});`)
    const config = new McpConfigStore(root)
    config.sync([{ name: 'tree', type: 'stdio', command: process.execPath, args: [script], env: { PID_FILE: pidFile } }])
    const runtime = new McpRuntimeManager({ config, hostRoot: root }); runtimes.push(runtime)
    await runtime.ensureScope()
    expect(runtime.getStatuses()[0].state).toBe('connected')
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[]
    try {
      await runtime.disposeAll()
      for (const pid of pids) await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
    } finally {
      // 断言失败也只能清理本测试明确记录的子进程，绝不按进程名扫杀。
      for (const pid of pids) { try { process.kill(pid) } catch { /* 已回收。 */ } }
    }
  })

  it('真实pi会话通过tool_search激活deferred工具，下一回合隐藏禁用工具', async () => {
    const root = temp(); const cwd = temp()
    const config = new McpConfigStore(root)
    const def: McpServerDef = { name: 'echo', type: 'stdio', command: process.execPath }
    config.sync([def])
    const { runtime } = fixture(config, root)
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null, modelsStorePath: join(root, 'models-cache.json'), refreshOnCreate: false,
      credentials: { read: () => Promise.resolve(undefined), list: () => Promise.resolve([]), modify: () => Promise.resolve(undefined), delete: () => Promise.resolve() }
    })
    const { session } = await createPiSession({
      cwd, hostRoot: root, sessionId: randomUUID(), modelRuntime, systemPrompt: 'MCP integration test',
      mcpRuntime: runtime, approval: { decide: () => Promise.resolve({ block: false }) }, onEvent: () => undefined, observe: () => undefined
    })
    try {
      expect(session.getActiveToolNames()).toContain('tool_search')
      expect(session.getActiveToolNames()).not.toContain('mcp__echo__echo')
      const search = session.agent.state.tools.find((tool) => tool.name === 'tool_search')!
      const result = await search.execute('search', { query: 'echo test' }, new AbortController().signal)
      expect(JSON.stringify(result)).toContain('mcp__echo__echo')
      expect(session.getActiveToolNames()).toContain('mcp__echo__echo')
      const echo = session.agent.state.tools.find((tool) => tool.name === 'mcp__echo__echo')!
      const failure = await echo.execute('empty-error', { text: 'empty-error' }, new AbortController().signal)
      expect(failure.isError).toBe(true)
      expect(JSON.stringify(failure.content)).toContain('returned an error')
      config.sync([{ ...def, enabled: false }])
      await runtime.refresh()
      await session.extensionRunner.emitBeforeAgentStart({ messageType: 'user', prompt: 'next' }, { cwd, customPrompt: 'MCP integration test' })
      expect(session.getActiveToolNames()).not.toContain('mcp__echo__echo')
      expect(session.getAllTools().find((tool) => tool.name === 'mcp__echo__echo')?.exposure).toBe('hidden')
    } finally { session.dispose() }
  })

  it('共享连接按调用串行路由elicitation，不将管理请求归给其他会话', async () => {
    const root = temp(); const config = new McpConfigStore(root)
    config.sync([{ name: 'ask', type: 'stdio', command: process.execPath }])
    const pair = createInMemoryTransportPair()
    await pair.server.start()
    const pending = new Map<string, { id: string | number; method: string }>()
    const replies: unknown[] = []
    pair.server.onMessage((message) => {
      if (!('method' in message)) {
        if (!('result' in message)) return
        const original = pending.get(String(message.id))
        if (original === undefined) replies.push(message.result)
        else {
          const text = JSON.stringify(message.result)
          const result = original.method === 'resources/read' ? { contents: [{ uri: 'memory://test', text }] }
            : original.method === 'prompts/get' ? { messages: [{ role: 'user', content: { type: 'text', text } }] }
              : { content: [{ type: 'text', text }] }
          void pair.server.send({ jsonrpc: '2.0', id: original.id, result })
        }
        return
      }
      if (!('id' in message)) return
      const params = message.params as Record<string, unknown>
      if (message.method === 'initialize') void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: params.protocolVersion, serverInfo: { name: 'ask', version: '1' }, capabilities: { tools: {}, resources: {}, prompts: {} } } })
      if (message.method === 'tools/list') void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ask', inputSchema: { type: 'object', properties: {} } }] } })
      if (message.method === 'resources/list') void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { resources: [] } })
      if (message.method === 'resources/templates/list') void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { resourceTemplates: [] } })
      if (message.method === 'prompts/list') void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } })
      if (['tools/call', 'resources/read', 'prompts/get'].includes(message.method)) {
        const id = `ask-${message.id}`
        pending.set(id, { id: message.id, method: message.method })
        void pair.server.send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message: 'continue?', requestedSchema: { type: 'object' } } })
      }
    })
    const sessions: string[] = []
    let release!: () => void
    const first = new Promise<void>((resolve) => { release = resolve })
    const runtime = new McpRuntimeManager({
      config, hostRoot: root, transportFactory: () => pair.client,
      onElicitation: async (_params, context) => {
        sessions.push(context.sessionId!)
        if (context.sessionId === 'one') await first
        if (context.sessionId === 'resource-stop') await new Promise<void>((resolve) => context.signal!.addEventListener('abort', () => resolve(), { once: true }))
        return { action: 'accept' }
      }
    })
    runtimes.push(runtime)
    await runtime.ensureScope()
    await pair.server.send({ jsonrpc: '2.0', id: 'management', method: 'elicitation/create', params: { message: 'not a tool' } })
    await vi.waitFor(() => expect(replies).toEqual([{ action: 'cancel' }]))
    const one = runtime.callTool({}, 'mcp__ask__ask', {}, { sessionId: 'one' })
    const controller = new AbortController()
    const stopped = runtime.callTool({}, 'mcp__ask__ask', {}, { sessionId: 'stopped', signal: controller.signal })
    const stoppedCheck = expect(stopped).rejects.toThrow('queued stop')
    const two = runtime.callTool({}, 'mcp__ask__ask', {}, { sessionId: 'two' })
    await vi.waitFor(() => expect(sessions).toEqual(['one']))
    controller.abort(new Error('queued stop'))
    await stoppedCheck
    release()
    await Promise.all([one, two])
    expect(sessions).toEqual(['one', 'two'])
    await runtime.resourcesRead({}, 'ask', 'memory://test', { sessionId: 'resource' })
    await runtime.promptsGet({}, 'ask', 'test', {}, { sessionId: 'prompt' })
    expect(sessions).toEqual(['one', 'two', 'resource', 'prompt'])
    const resourceStop = new AbortController()
    const stopping = runtime.resourcesRead({}, 'ask', 'memory://test', { sessionId: 'resource-stop', signal: resourceStop.signal })
    const rejectStop = expect(stopping).rejects.toThrow()
    await vi.waitFor(() => expect(sessions.at(-1)).toBe('resource-stop'))
    resourceStop.abort()
    await rejectStop
  })

  it.each(['success', 'error', 'timeout'] as const)('调用%s结束即取消仍挂起的反向elicitation', async (outcome) => {
    const root = temp(); const config = new McpConfigStore(root)
    config.sync([{ name: 'lifetime', type: 'stdio', command: process.execPath, timeout: 0.05 }])
    const pair = createInMemoryTransportPair()
    await pair.server.start()
    pair.server.onMessage((message) => {
      if (!('method' in message) || !('id' in message)) return
      const params = message.params as Record<string, unknown>
      if (message.method === 'initialize') void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: params.protocolVersion, serverInfo: { name: 'lifetime', version: '1' }, capabilities: { tools: {} } } })
      if (message.method === 'tools/list') void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ask', inputSchema: { type: 'object', properties: {} } }] } })
      if (message.method === 'tools/call') {
        void pair.server.send({ jsonrpc: '2.0', id: 'unfinished-form', method: 'elicitation/create', params: { message: 'still pending', requestedSchema: { type: 'object' } } })
        if (outcome === 'success') void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { content: [] } })
        if (outcome === 'error') void pair.server.send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'tool ended early' } })
      }
    })
    let incomingSignal: AbortSignal | undefined
    let cancelled = false
    const external = new AbortController()
    const runtime = new McpRuntimeManager({
      config, hostRoot: root, transportFactory: () => pair.client,
      onElicitation: (_params, context) => {
        incomingSignal = context.signal
        return new Promise((resolve) => {
          const cancel = (): void => { cancelled = true; resolve({ action: 'cancel' }) }
          context.signal!.addEventListener('abort', cancel, { once: true })
          if (context.signal!.aborted) cancel()
        })
      }
    })
    runtimes.push(runtime)
    await runtime.ensureScope()
    const call = runtime.callTool({}, 'mcp__lifetime__ask', {}, { sessionId: 'lifetime-session', signal: external.signal })
    if (outcome === 'success') await expect(call).resolves.toHaveProperty('content', [])
    else await expect(call).rejects.toThrow()
    expect(incomingSignal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
    expect(external.signal.aborted).toBe(false)
  })
})

describe('Legacy SSE transport', () => {
  it('使用endpoint双通道完成真实握手与工具调用', async () => {
    let stream: import('node:http').ServerResponse | undefined
    const server = createServer((req, res) => {
      if (req.method === 'GET') {
        stream = res
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: endpoint\r\ndata: /messages\r\n\r\n')
        return
      }
      let body = ''; req.on('data', (chunk) => { body += chunk }); req.on('end', () => {
        const message = JSON.parse(body) as JsonRpcMessage
        if ('method' in message && 'id' in message) {
          const params = message.params as Record<string, unknown>
          const result = message.method === 'initialize'
            ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'sse', version: '1' } }
            : message.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: '你好' }] }
          stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
        }
        res.writeHead(202); res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as import('node:net').AddressInfo).port
    const client = new McpClient({ name: 'test', version: '1' })
    try {
      await client.connect(new SseTransport({ url: `http://127.0.0.1:${port}/sse` }))
      expect(await client.listTools()).toEqual([])
      expect((await client.callTool('hello')).content).toEqual([{ type: 'text', text: '你好' }])
    } finally {
      await client.close()
      stream?.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('拒绝跨源endpoint，避免泄漏认证头', async () => {
    const transport = new SseTransport({ url: 'https://trusted.example/sse', headers: { Authorization: 'Bearer secret' }, fetch: () => Promise.resolve(new Response('event: endpoint\ndata: https://evil.example/messages\n\n', { headers: { 'Content-Type': 'text/event-stream' } })) })
    await expect(transport.start()).rejects.toThrow('configured origin')
    await transport.close()
  })
})
