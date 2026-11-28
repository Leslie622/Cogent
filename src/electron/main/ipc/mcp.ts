/** MCP 壳桥：主窗口专属交互 IPC，以及只在同代 stdio 消费的 OAuth 事件。 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { shell } from 'electron'
import { MCP_IPC, type McpExternalConfig } from '../../../shared/mcp-ipc'
import type { McpCredentialStore } from '../credentials/mcp-store'
import type { HostManager } from '../host/manager'
import { handleTrusted } from './trusted'

export function validateMcpExternalUrl(raw: string): string {
  const url = new URL(raw)
  if (url.username !== '' || url.password !== '' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('MCP 浏览器跳转仅允许 HTTPS 或本机回环 HTTP 地址')
  }
  return url.href
}

function externalConfigs(): McpExternalConfig[] {
  const home = homedir()
  const desktopRoot = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') :
    process.env.APPDATA ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  return [
    { label: 'Claude Code', path: join(home, '.claude.json') },
    { label: 'Cursor', path: join(home, '.cursor', 'mcp.json') },
    { label: 'Claude Desktop', path: join(desktopRoot, 'Claude', 'claude_desktop_config.json') },
    { label: 'VS Code', path: join(desktopRoot, 'Code', 'User', 'mcp.json') }
  ].filter(candidate => existsSync(candidate.path))
}

export function registerMcpIpc(host: HostManager, store: McpCredentialStore): void {
  handleTrusted(MCP_IPC.elicitationRespond, async (_event, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null || !('requestId' in raw) || typeof raw.requestId !== 'string' || raw.requestId === '' ||
        !('action' in raw) || (raw.action !== 'accept' && raw.action !== 'decline' && raw.action !== 'cancel') ||
        ('content' in raw && (typeof raw.content !== 'object' || raw.content === null || Array.isArray(raw.content)))) {
      throw new Error('mcp:elicitationRespond 需要合法的 requestId、action 和可选表单内容')
    }
    return host.request('mcp.elicitation.respond', {
      requestId: raw.requestId, action: raw.action,
      ...('content' in raw && { content: raw.content as Record<string, unknown> })
    })
  })
  handleTrusted(MCP_IPC.openUrl, async (_event, raw: unknown) => {
    if (typeof raw !== 'string') throw new Error('mcp:openUrl 需要地址字符串')
    await shell.openExternal(validateMcpExternalUrl(raw))
  })
  handleTrusted(MCP_IPC.detectExternalConfigs, (_event, raw: unknown) => {
    const candidates = externalConfigs()
    if (raw === undefined) return candidates
    if (!Array.isArray(raw) || !raw.every(value => typeof value === 'string')) throw new Error('请选择已检测到的配置文件')
    const selected = new Set(raw.map(path => resolve(path)))
    if ([...selected].some(path => !candidates.some(candidate => resolve(candidate.path) === path))) throw new Error('只能导入已检测到的客户端配置文件')
    return candidates.filter(candidate => selected.has(resolve(candidate.path))).map(candidate => {
      try { return { ...candidate, content: readFileSync(candidate.path, 'utf8') } }
      catch (error) { return { ...candidate, error: error instanceof Error ? error.message : String(error) } }
    })
  })

  host.setMcpEventSink((event, generation) => {
    if (generation !== host.getGeneration()) return
    const params = event.params
    if (typeof params !== 'object' || params === null) {
      console.error('[main] 已拒绝形状不合法的 MCP 壳事件')
      return
    }
    if (event.method === 'mcp.oauth.openUrl') {
      try {
        if (!('url' in params) || typeof params.url !== 'string') throw new Error('授权地址缺失')
        const url = validateMcpExternalUrl(params.url)
        void shell.openExternal(url).catch(() => console.error('[main] MCP OAuth 浏览器打开失败，可在设置中复制授权地址'))
      } catch { console.error('[main] 已拒绝不安全的 MCP OAuth 浏览器地址') }
    } else if (event.method === 'mcp.oauth.persistState') {
      if (!('requestId' in params) || typeof params.requestId !== 'string' || params.requestId === '') {
        console.error('[main] 已拒绝缺少操作身份的 MCP OAuth 保存请求')
        return
      }
      let failure: string | undefined
      try {
        if (!('key' in params) || typeof params.key !== 'string' || !/^[a-f0-9]{64}$/.test(params.key)) throw new Error('MCP OAuth 保存请求身份不合法')
        const state = 'state' in params ? params.state : undefined
        if (state !== undefined && (typeof state !== 'object' || state === null ||
            !('serverUrl' in state) || typeof state.serverUrl !== 'string')) throw new Error('MCP OAuth 状态形状不合法')
        store.setOAuthState(params.key, state)
      } catch (error) { failure = error instanceof Error ? error.message : String(error) }
      void host.confirmMcpPersistence({ requestId: params.requestId, ...(failure !== undefined && { error: failure }) }, generation)
        .catch(() => console.error('[main] MCP OAuth 保存确认未送达原 Host'))
    }
  })
}
