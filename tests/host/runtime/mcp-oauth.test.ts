/** 用真实 loopback OAuth 服务验证 PKCE、手动回调、刷新、登出与作用域隔离。 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import type { McpServerDef } from '../../../src/protocol'
import { McpOAuthController, mcpMetadataDocumentsFromUrl, mcpOAuthStateKey, type McpOAuthNotification } from '../../../src/host/runtime/mcp-oauth'
import { McpSecretBridge } from '../../../src/host/runtime/mcp-secrets'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function bridge(): McpSecretBridge {
  const result = new McpSecretBridge({ persist: request => queueMicrotask(() => result.completePersistence({ requestId: request.requestId })) })
  cleanups.push(() => result.dispose())
  return result
}

async function oauthServer() {
  let origin = ''
  let pkce = ''
  const grants: string[] = []
  const server = createServer((request, response) => { void handle(request, response).catch(error => { response.writeHead(500).end(String(error)) }) })
  const json = (response: ServerResponse, value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url!, origin).pathname
    if (path.includes('oauth-protected-resource')) return json(response, { resource: `${origin}/mcp`, authorization_servers: [origin] })
    if (path.includes('oauth-authorization-server') || path.includes('openid-configuration')) return json(response, {
      issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
    })
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (path === '/register') return json(response, { ...JSON.parse(body), client_id: 'cogent-test-client' })
    if (path === '/token') {
      const form = new URLSearchParams(body)
      const grant = form.get('grant_type')!
      grants.push(grant)
      if (grant === 'authorization_code') {
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(pkce)
        expect(form.get('code')).toBe('synthetic-code')
      }
      return json(response, { access_token: grant === 'refresh_token' ? 'refreshed-token' : 'signed-in-token', token_type: 'Bearer', refresh_token: 'rotated-refresh', expires_in: 3600 })
    }
    response.writeHead(404).end()
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务未监听')
  origin = `http://127.0.0.1:${address.port}`
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return { origin, grants, setChallenge: (value: string) => { pkce = value } }
}

it('真实DCR+PKCE手动回调，刷新仅一次并持久化后重连，登出清除凭据', async () => {
  const fixture = await oauthServer()
  const secrets = bridge()
  const events: McpOAuthNotification[] = []
  const onAuthenticated = vi.fn(async () => {})
  const oauth = new McpOAuthController({ secrets, notify: event => events.push(event), onAuthenticated })
  cleanups.push(() => oauth.dispose())
  const def: McpServerDef = { name: 'remote', type: 'http', url: `${fixture.origin}/mcp`, oauth: { clientRegistration: 'dcr' } }
  const login = await oauth.login(def)
  const authorization = new URL(login.authUrl)
  fixture.setChallenge(authorization.searchParams.get('code_challenge')!)
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
  const redirect = new URL(authorization.searchParams.get('redirect_uri')!)
  redirect.searchParams.set('code', 'synthetic-code')
  redirect.searchParams.set('state', 'other-login')
  await expect(oauth.completeManual(login.loginId, redirect.href)).rejects.toThrow('different sign-in')
  redirect.searchParams.set('state', authorization.searchParams.get('state')!)
  await oauth.completeManual(login.loginId, redirect.href)
  expect(onAuthenticated).toHaveBeenCalledOnce()
  expect(events.at(-1)).toMatchObject({ method: 'mcp.oauth.loginChanged', params: { state: 'authorized' } })
  const provider = oauth.authProvider(def)!
  expect(await provider.token()).toBe('signed-in-token')
  await Promise.all([1, 2].map(() => provider.onUnauthorized!({
    response: new Response('', { status: 401 }), serverUrl: new URL(def.url), fetch, token: 'signed-in-token'
  })))
  expect(await provider.token()).toBe('refreshed-token')
  expect(fixture.grants).toEqual(['authorization_code', 'refresh_token'])
  await oauth.logout(def)
  expect(await secrets.stateStore(mcpOAuthStateKey(def), def.url).load()).toBeUndefined()
})

it('取消登录关闭回调，其他项目无法复用授权状态；CIMD缺发布配置显式失败', async () => {
  const fixture = await oauthServer()
  const secrets = bridge()
  const events: McpOAuthNotification[] = []
  const oauth = new McpOAuthController({ secrets, notify: event => events.push(event), onAuthenticated: async () => {} })
  cleanups.push(() => oauth.dispose())
  const def: McpServerDef = { name: 'remote', type: 'http', url: `${fixture.origin}/mcp` }
  const login = await oauth.login(def, { projectId: 'one' })
  await oauth.cancel(login.loginId)
  expect(events.at(-1)).toMatchObject({ params: { state: 'cancelled' } })
  expect(mcpOAuthStateKey(def, { projectId: 'one' })).not.toBe(mcpOAuthStateKey(def, { projectId: 'two' }))
  await expect(oauth.login({ ...def, oauth: { clientRegistration: 'cimd' } })).rejects.toThrow('COGENT_MCP_OAUTH_METADATA_BASE_URL')
})

it('CIMD发布配置校验协议与身份，文档只声明发行方支持的loopback回调', () => {
  const metadata = mcpMetadataDocumentsFromUrl('https://metadata.example/cogent/')!
  expect(metadata.baseUrl).toBe('https://metadata.example/cogent')
  expect(metadata.listsRedirectUrl('http://127.0.0.1:12432/callback')).toBe(true)
  expect(metadata.listsRedirectUrl('https://attacker.example/callback')).toBe(false)
  expect(metadata.listsRedirectUrl('http://127.0.0.1:12432/other')).toBe(false)
  expect(() => mcpMetadataDocumentsFromUrl('http://metadata.example')).toThrow('HTTPS')
  expect(() => mcpMetadataDocumentsFromUrl('https://user:password@metadata.example/#fragment')).toThrow('HTTPS')
})
