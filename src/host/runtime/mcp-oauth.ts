/** MCP OAuth 控制器：复用 pi 的 PKCE/发现/注册/刷新，回调、取消和凭据写入绑定操作身份。 */
import { createHash, randomUUID } from 'node:crypto'
import {
  completeMcpSignIn, createMcpAuthProvider, listenForLoopbackSignIn,
  McpSignInCancelledError, responseFromRedirectUrl, startMcpSignIn, waitForLoopbackSignIn,
  type McpAuthProvider, type McpAuthorizationResponse, type McpClientMetadataDocuments,
  type McpOAuthSettings, type McpSignInOptions, type McpSignInRedirect, type OAuthChallenge
} from '@earendil-works/pi-mcp/oauth'
import type { McpServerDef } from '../../protocol'
import type { McpSecretBridge } from './mcp-secrets'

export interface McpOAuthScope { cwd?: string; projectId?: string }
type RemoteDef = Extract<McpServerDef, { type: 'http' | 'sse' }>
interface PendingLogin {
  id: string
  key: string
  name: string
  controller: AbortController
  authorization?: McpSignInRedirect
  resolveManual?: (input: string | undefined) => void
  done?: Promise<void>
}

export type McpOAuthNotification =
  | { method: 'mcp.oauth.openUrl'; params: { loginId: string; url: string } }
  | { method: 'mcp.oauth.loginChanged'; params: { loginId: string; name: string; state: 'authorized' | 'failed' | 'cancelled'; error?: string } }

/** 发行方显式配置公开文档；采用 pi 已支持的 base/client.json 与逐 server 文档布局。 */
export function mcpMetadataDocumentsFromUrl(value: string | undefined): McpClientMetadataDocuments | undefined {
  if (value === undefined || value === '') return undefined
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') {
    throw new Error('COGENT_MCP_OAUTH_METADATA_BASE_URL 必须为无凭据、查询或片段的 HTTPS 地址')
  }
  return {
    baseUrl: url.href.replace(/\/$/, ''),
    listsRedirectUrl: input => {
      const redirect = new URL(input)
      return redirect.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) &&
        redirect.pathname === '/callback' && redirect.username === '' && redirect.password === ''
    }
  }
}

/** URL、名字和项目共同定位凭据；相同地址的不同作用域不会混用授权。 */
export function mcpOAuthStateKey(def: RemoteDef, scope: McpOAuthScope = {}): string {
  const url = new URL(def.url)
  url.hash = ''
  return createHash('sha256').update(JSON.stringify([def.name, url.href, scope.projectId ?? scope.cwd ?? 'global'])).digest('hex')
}

export class McpOAuthController {
  private readonly pending = new Map<string, PendingLogin>()
  private readonly providers = new Map<string, { provider: McpAuthProvider; definition: { value: RemoteDef } }>()
  private readonly challenges = new Map<string, OAuthChallenge>()
  private disposed = false
  private readonly metadataDocuments: McpClientMetadataDocuments | undefined

  constructor(private readonly options: {
    secrets: McpSecretBridge
    notify: (event: McpOAuthNotification) => void
    onAuthenticated: (def: McpServerDef, scope: McpOAuthScope) => Promise<void>
    clientMetadataDocuments?: McpClientMetadataDocuments
  }) {
    this.metadataDocuments = options.clientMetadataDocuments ?? mcpMetadataDocumentsFromUrl(process.env.COGENT_MCP_OAUTH_METADATA_BASE_URL)
  }

  private settings(def: RemoteDef): McpOAuthSettings {
    const { authServerMetadataUrl, ...settings } = def.oauth ?? {}
    if (settings.clientRegistration === 'cimd' && this.metadataDocuments === undefined) {
      throw new Error('CIMD 需要发行方公开 OAuth 客户端元数据文档，并设置 COGENT_MCP_OAUTH_METADATA_BASE_URL')
    }
    return { ...settings, ...(authServerMetadataUrl !== undefined && { authServerMetadataUrl: new URL(authServerMetadataUrl) }) }
  }

  isAuthorized(def: McpServerDef, scope: McpOAuthScope = {}): boolean {
    return def.type !== 'stdio' && this.options.secrets.isAuthorized(mcpOAuthStateKey(def, scope), def.url)
  }

  authProvider(def: McpServerDef, scope: McpOAuthScope = {}): McpAuthProvider | undefined {
    if (def.type === 'stdio') return undefined
    const key = mcpOAuthStateKey(def, scope)
    const existing = this.providers.get(key)
    if (existing !== undefined) { existing.definition.value = def; return existing.provider }
    const definition = { value: def }
    const provider = createMcpAuthProvider({
      serverUrl: def.url,
      store: this.options.secrets.stateStore(key, def.url),
      settings: () => this.settings(definition.value),
      clientName: 'Cogent',
      clientMetadataDocuments: this.metadataDocuments,
      onChallenge: challenge => this.challenges.set(key, challenge)
    })
    this.providers.set(key, { provider, definition })
    return provider
  }

  async login(def: McpServerDef, scope: McpOAuthScope = {}): Promise<{ loginId: string; authUrl: string }> {
    if (this.disposed) throw new Error('MCP OAuth 控制器已关闭')
    if (def.type === 'stdio') throw new Error('本地 stdio MCP 不使用远程 OAuth 登录')
    const key = mcpOAuthStateKey(def, scope)
    for (const login of [...this.pending.values()]) if (login.key === key) await this.cancel(login.id)
    const settings = this.settings(def)
    const store = this.options.secrets.stateStore(key, def.url)
    const controller = new AbortController()
    const login: PendingLogin = { id: randomUUID(), key, name: def.name, controller }
    this.pending.set(login.id, login)
    let loopback: Awaited<ReturnType<typeof listenForLoopbackSignIn>> | undefined
    try {
      loopback = await listenForLoopbackSignIn({
        serverUrl: def.url, store, settings, clientMetadataDocuments: this.metadataDocuments
      })
      const signInOptions: McpSignInOptions = {
        serverUrl: def.url, store, settings, clientName: 'Cogent',
        clientMetadataDocuments: this.metadataDocuments,
        redirectUrl: loopback.redirectUrl, signal: controller.signal,
        challenge: this.challenges.get(key)
      }
      const authorization = await startMcpSignIn(signInOptions)
      this.assertCurrent(login)
      if (authorization.kind === 'authorized') {
        this.pending.delete(login.id)
        await loopback.callback.close()
        await this.authenticated(login, def, scope)
        return { loginId: login.id, authUrl: '' }
      }
      login.authorization = authorization
      const callback = loopback.callback
      login.done = (async () => {
        try {
          const response: McpAuthorizationResponse = await waitForLoopbackSignIn({
            callback, authorization, signal: controller.signal,
            promptForRedirectUrl: signal => new Promise(resolve => {
              login.resolveManual = resolve
              signal.addEventListener('abort', () => resolve(undefined), { once: true })
            })
          })
          this.assertCurrent(login)
          await completeMcpSignIn({ ...signInOptions, authorization, response })
          this.assertCurrent(login)
          await this.authenticated(login, def, scope)
        } catch (error) {
          const cancelled = controller.signal.aborted || error instanceof McpSignInCancelledError
          this.options.notify({ method: 'mcp.oauth.loginChanged', params: {
            loginId: login.id, name: login.name, state: cancelled ? 'cancelled' : 'failed',
            ...(!cancelled && { error: error instanceof Error ? error.message : String(error) })
          } })
          if (!cancelled) throw error
        } finally {
          if (this.pending.get(login.id) === login) this.pending.delete(login.id)
          await callback.close()
        }
      })()
      // 浏览器交互跨越本次 RPC；终态通过事件反馈，避免后台 rejection 泄露。
      void login.done.catch(() => {})
      this.options.notify({ method: 'mcp.oauth.openUrl', params: { loginId: login.id, url: authorization.authorizationUrl } })
      return { loginId: login.id, authUrl: authorization.authorizationUrl }
    } catch (error) {
      controller.abort()
      this.pending.delete(login.id)
      await loopback?.callback.close()
      throw error
    }
  }

  private assertCurrent(login: PendingLogin): void {
    if (this.disposed || login.controller.signal.aborted || this.pending.get(login.id) !== login) throw new McpSignInCancelledError()
  }

  private async authenticated(login: PendingLogin, def: McpServerDef, scope: McpOAuthScope): Promise<void> {
    this.challenges.delete(login.key)
    await this.options.onAuthenticated(def, scope)
    this.options.notify({ method: 'mcp.oauth.loginChanged', params: { loginId: login.id, name: login.name, state: 'authorized' } })
  }

  async completeManual(loginId: string, redirectUrl: string): Promise<void> {
    const login = this.pending.get(loginId)
    if (login === undefined || login.authorization === undefined || login.resolveManual === undefined) throw new Error('MCP OAuth 登录已结束或尚未准备好')
    responseFromRedirectUrl(redirectUrl, login.authorization)
    login.resolveManual(redirectUrl)
    await login.done
  }

  async cancel(loginId: string): Promise<void> {
    const login = this.pending.get(loginId)
    if (login === undefined) return
    login.controller.abort()
    login.resolveManual?.(undefined)
    await login.done?.catch(() => {})
    if (this.pending.get(loginId) === login) this.pending.delete(loginId)
  }

  async logout(def: McpServerDef, scope: McpOAuthScope = {}): Promise<void> {
    if (def.type === 'stdio') throw new Error('本地 stdio MCP 不使用远程 OAuth 登录')
    const key = mcpOAuthStateKey(def, scope)
    for (const login of [...this.pending.values()]) if (login.key === key) await this.cancel(login.id)
    await this.providers.get(key)?.provider.settled()
    await this.options.secrets.removeState(key)
    this.providers.delete(key)
    this.challenges.delete(key)
    await this.options.onAuthenticated(def, scope)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.pending.values()].map(login => this.cancel(login.id)))
    await Promise.all([...this.providers.values()].map(({ provider }) => provider.settled()))
    this.providers.clear()
  }
}
