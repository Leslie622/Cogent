/** 真实 Host 的 OAuth 闭环：DCR、PKCE、loopback 回调、壳侧提交确认及受保护 HTTP 工具。 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { McpListResult, McpServerDef } from '../../src/protocol'
import {
  chunk, closeLoopback, initEngine, listenLoopback, makeTempDir, removeDir, sse, startEngine
} from './harness'

const home = makeTempDir('cogent-mcp-oauth-home-')
const workspace = makeTempDir('cogent-mcp-oauth-workspace-')
const engine = startEngine(home)
const accessToken = 'oauth-integration-access-token'
const clientId = 'cogent-integration-client'
const authCode = 'one-use-authorization-code'
const fixtureErrors: unknown[] = []
const registrations: Array<Record<string, unknown>> = []
const tokenRequests: URLSearchParams[] = []
const protectedCalls: Array<Record<string, unknown>> = []
const llmBodies: Array<Record<string, unknown>> = []
const vault = new Map<string, unknown>()
let origin = ''
let challenge = ''
let authorizedRedirect = ''
let tokenWriteWaiting = false
let stopping = false
let persistenceFailure: unknown
let persistenceLoop: Promise<void> | undefined
let releaseTokenWrite: () => void = () => {}
const tokenWriteGate = new Promise<void>(resolve => { releaseTokenWrite = resolve })

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
}
async function body(request: IncomingMessage): Promise<string> {
  let result = ''
  for await (const value of request) result += String(value)
  return result
}

/** 仅此测试的授权服务器与 MCP 资源服务器，实际走 HTTP 和协议发现，未替换 OAuth 实现。 */
const remote = createServer((request, response) => {
  void handleRemote(request, response).catch(error => {
    fixtureErrors.push(error)
    if (!response.headersSent) response.writeHead(500)
    response.end('OAuth integration fixture failed')
  })
})
async function handleRemote(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url!, origin)
  if (url.pathname.includes('oauth-protected-resource')) {
    json(response, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['tools:read'] })
    return
  }
  if (url.pathname.includes('oauth-authorization-server') || url.pathname.includes('openid-configuration')) {
    json(response, {
      issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    })
    return
  }
  if (url.pathname === '/register') {
    expect(request.method).toBe('POST')
    const metadata = JSON.parse(await body(request)) as Record<string, unknown>
    expect(metadata).toMatchObject({ application_type: 'native', token_endpoint_auth_method: 'none' })
    expect(metadata.redirect_uris).toEqual([expect.stringMatching(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/callback$/)])
    registrations.push(metadata)
    json(response, { ...metadata, client_id: clientId }, 201)
    return
  }
  if (url.pathname === '/authorize') {
    expect(url.searchParams.get('client_id')).toBe(clientId)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('resource')).toBe(`${origin}/mcp`)
    challenge = url.searchParams.get('code_challenge')!
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    authorizedRedirect = url.searchParams.get('redirect_uri')!
    const redirect = new URL(authorizedRedirect)
    redirect.searchParams.set('code', authCode)
    redirect.searchParams.set('state', url.searchParams.get('state')!)
    response.writeHead(302, { Location: redirect.href }).end()
    return
  }
  if (url.pathname === '/token') {
    expect(request.method).toBe('POST')
    const form = new URLSearchParams(await body(request))
    tokenRequests.push(form)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('client_id')).toBe(clientId)
    expect(form.get('code')).toBe(authCode)
    expect(form.get('redirect_uri')).toBe(authorizedRedirect)
    expect(form.get('resource')).toBe(`${origin}/mcp`)
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(challenge)
    json(response, { access_token: accessToken, token_type: 'Bearer', refresh_token: 'oauth-integration-refresh', expires_in: 3600 })
    return
  }
  if (url.pathname !== '/mcp') { response.writeHead(404).end(); return }
  if (request.headers.authorization !== `Bearer ${accessToken}`) {
    response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end()
    return
  }
  if (request.method !== 'POST') { response.writeHead(405).end(); return }
  const frame = JSON.parse(await body(request)) as {
    id?: string | number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
  }
  if (frame.id === undefined) { response.writeHead(202).end(); return }
  let result: unknown
  if (frame.method === 'initialize') {
    result = { protocolVersion: frame.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'oauth-protected', version: '1.0' } }
  } else if (frame.method === 'tools/list') {
    result = { tools: [{ name: 'echo', description: 'Echo after OAuth authorization', inputSchema: {
      type: 'object', properties: { text: { type: 'string' } }, required: ['text']
    }, annotations: { readOnlyHint: true } }] }
  } else if (frame.method === 'tools/call') {
    expect(frame.params?.name).toBe('echo')
    protectedCalls.push(frame.params!.arguments!)
    result = { content: [{ type: 'text', text: `protected echo: ${String(frame.params?.arguments?.text)}` }] }
  } else if (frame.method === 'ping') result = {}
  else { json(response, { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } }); return }
  json(response, { jsonrpc: '2.0', id: frame.id, result })
}

const llm = createServer((request, response) => {
  void body(request).then(value => {
    llmBodies.push(JSON.parse(value) as Record<string, unknown>)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (llmBodies.length === 1) {
      response.write(sse(chunk({ tool_calls: [{ index: 0, id: 'oauth-tool-call', type: 'function', function: {
        name: 'mcp__protected__echo', arguments: JSON.stringify({ text: 'authenticated-tool-result' })
      } }] })))
      response.write(sse(chunk({}, 'tool_calls')))
    } else {
      response.write(sse(chunk({ content: 'OAuth tool succeeded' })))
      response.write(sse(chunk({}, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
    }
    response.end('data: [DONE]\n\n')
  }).catch(error => { fixtureErrors.push(error); response.writeHead(500).end() })
})

/** 模拟 main 的私有存储提交确认；加密调用与启动恢复另由 Electron 单测及实机探针验证。 */
async function persistOAuthStates(): Promise<void> {
  while (!stopping) {
    const event = await engine.waitEvent('mcp.oauth.persistState', undefined, 60_000)
    const { requestId, key, state } = event.params
    expect(typeof requestId).toBe('string')
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    if (state !== undefined && JSON.stringify(state).includes(accessToken)) {
      tokenWriteWaiting = true
      await tokenWriteGate
    }
    if (state === undefined) vault.delete(String(key))
    else vault.set(String(key), structuredClone(state))
    const confirmation = await engine.send('mcp.oauth.persistResult', { requestId })
    expect(confirmation.error).toBeUndefined()
  }
}

describe('MCP OAuth 2.1 端到端', () => {
  beforeAll(async () => {
    origin = `http://127.0.0.1:${await listenLoopback(remote)}`
    const port = await listenLoopback(llm)
    await initEngine(engine, { client: 'mcp-oauth-integration', providers: [{
      id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock']
    }] })
    persistenceLoop = persistOAuthStates().catch(error => { if (!stopping) persistenceFailure = error })
  }, 60_000)
  afterAll(async () => {
    releaseTokenWrite()
    stopping = true
    await engine.stop()
    await persistenceLoop
    await Promise.all([closeLoopback(remote), closeLoopback(llm)])
    for (const directory of [home, workspace]) removeDir(directory)
  })

  it('未登录提示授权，DCR+PKCE回调先提交凭据再自动重连，工具成功且登出清除授权', async () => {
    const definition: McpServerDef = { name: 'protected', type: 'http', url: `${origin}/mcp`, exposure: 'direct', oauth: { clientRegistration: 'dcr' } }
    expect((await engine.send('mcp.sync', { servers: [definition] })).error).toBeUndefined()
    const initial = await engine.send<McpListResult>('mcp.list', {})
    expect(initial.result?.servers[0].runtime).toMatchObject({ state: 'needs-auth' })
    expect(protectedCalls).toEqual([])

    const started = await engine.send<{ loginId: string; authUrl: string }>('mcp.oauth.login', { name: 'protected' })
    expect(started.error).toBeUndefined()
    const login = started.result!
    const browser = await engine.waitEvent('mcp.oauth.openUrl', params => params.loginId === login.loginId)
    expect(browser.params.url).toBe(login.authUrl)
    const authorization = await fetch(login.authUrl, { redirect: 'manual' })
    expect(authorization.status).toBe(302)
    const callback = await fetch(authorization.headers.get('location')!)
    expect(callback.ok).toBe(true)

    await vi.waitFor(() => {
      expect(persistenceFailure).toBeUndefined()
      expect(fixtureErrors).toEqual([])
      expect(tokenWriteWaiting).toBe(true)
    }, { timeout: 10_000 })
    expect(tokenRequests).toHaveLength(1)
    expect(registrations).toHaveLength(1)
    expect(JSON.stringify([...vault.values()])).not.toContain(accessToken)
    expect(engine.events.some(event => event.method === 'mcp.oauth.loginChanged' && event.params.loginId === login.loginId && event.params.state === 'authorized')).toBe(false)
    releaseTokenWrite()
    const completed = await engine.waitEvent('mcp.oauth.loginChanged', params => params.loginId === login.loginId)
    expect(completed.params).toMatchObject({ state: 'authorized' })
    expect(JSON.stringify([...vault.values()])).toContain(accessToken)
    const connected = await engine.send<McpListResult>('mcp.list', {})
    expect(connected.result?.servers[0].runtime).toMatchObject({ state: 'connected', oauthAuthorized: true })

    const session = await engine.send('session.create', { cwd: workspace, permissionMode: 'auto' })
    expect(session.error).toBeUndefined()
    expect((await engine.send('agent.submit', { sessionId: session.result!.id!, text: '调用受保护工具', model: 'mock' })).error).toBeUndefined()
    const tool = await engine.waitEvent('tool.completed', params => params.callId === 'oauth-tool-call')
    expect(tool.params.isError).toBe(false)
    expect(tool.params.summary).toContain('protected echo: authenticated-tool-result')
    await engine.waitEvent('run.completed', params => params.sessionId === session.result!.id)
    expect(protectedCalls).toEqual([{ text: 'authenticated-tool-result' }])
    expect(JSON.stringify(llmBodies[1])).toContain('protected echo: authenticated-tool-result')

    expect((await engine.send('mcp.oauth.logout', { name: 'protected' })).error).toBeUndefined()
    expect(vault.size).toBe(0)
    const loggedOut = await engine.send<McpListResult>('mcp.list', {})
    expect(loggedOut.result?.servers[0].runtime).toMatchObject({ state: 'needs-auth', oauthAuthorized: false })
    expect(JSON.stringify(loggedOut)).not.toContain(accessToken)
    expect(fixtureErrors).toEqual([])
    expect(persistenceFailure).toBeUndefined()
  }, 45_000)
})
