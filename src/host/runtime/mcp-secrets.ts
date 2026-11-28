/** 壳侧加密凭据的 Host 内存桥；OAuth 写入等待同代 main 落盘确认，不创建明文文件。 */
import { randomUUID } from 'node:crypto'
import type { McpOAuthState, McpOAuthServerStore } from '@earendil-works/pi-mcp/oauth'

export interface McpSecretSnapshot {
  oauthStates: Record<string, unknown>
}
export interface McpOAuthPersistRequest { requestId: string; key: string; state?: unknown }
interface PendingWrite {
  label: string
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function isOAuthState(value: unknown, serverUrl: string): value is McpOAuthState {
  return typeof value === 'object' && value !== null && 'serverUrl' in value && value.serverUrl === serverUrl
}

export class McpSecretBridge {
  private states = new Map<string, unknown>()
  private locks = new Map<string, Promise<unknown>>()
  private writes = new Map<string, PendingWrite>()
  private disposed = false

  constructor(private readonly options: {
    persist?: (params: McpOAuthPersistRequest) => void
    timeoutMs?: number
  } = {}) {}

  sync(snapshot: McpSecretSnapshot): void {
    if (this.disposed) throw new Error('MCP 凭据桥已关闭')
    this.states = new Map(Object.entries(structuredClone(snapshot.oauthStates)))
  }

  /** 注册元数据也会持久化；只有 Token 存在才表示用户已授权。 */
  isAuthorized(key: string, serverUrl: string): boolean {
    const state = this.states.get(key)
    return isOAuthState(state, serverUrl) && Boolean(state.tokens?.access_token || state.tokens?.refresh_token)
  }

  stateStore(key: string, serverUrl: string): McpOAuthServerStore {
    return {
      load: () => {
        const state = this.states.get(key)
        if (state === undefined) return undefined
        if (!isOAuthState(state, serverUrl)) throw new Error('MCP OAuth 状态与服务器地址不匹配')
        return structuredClone(state)
      },
      save: async state => {
        if (state.serverUrl !== serverUrl) throw new Error('拒绝保存其他服务器的 OAuth 状态')
        await this.persist(key, state)
        this.states.set(key, structuredClone(state))
      },
      withRefreshLock: <T>(fn: () => Promise<T>): Promise<T> => {
        const operation = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
        this.locks.set(key, operation)
        void operation.finally(() => { if (this.locks.get(key) === operation) this.locks.delete(key) }).catch(() => {})
        return operation
      }
    }
  }

  async removeState(key: string): Promise<void> {
    const operation = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.persist(key)
      this.states.delete(key)
    })
    this.locks.set(key, operation)
    try { await operation }
    finally { if (this.locks.get(key) === operation) this.locks.delete(key) }
  }

  completePersistence({ requestId, error }: { requestId: string; error?: string }): void {
    const pending = this.writes.get(requestId)
    if (pending === undefined) return
    this.writes.delete(requestId)
    clearTimeout(pending.timer)
    if (error !== undefined) pending.reject(new Error(`${pending.label}保存失败：${error}`))
    else pending.resolve()
  }

  private persist(key: string, state?: McpOAuthState): Promise<void> {
    const persist = this.options.persist
    if (persist === undefined) return Promise.reject(new Error('此宿主未提供 MCP 安全凭据存储'))
    return this.persistenceOperation(requestId => persist({ requestId, key, ...(state !== undefined && { state }) }))
  }

  private persistenceOperation(send: (requestId: string) => void, label = 'MCP OAuth 凭据'): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('MCP 凭据桥已关闭'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.writes.delete(requestId)
        reject(new Error(`${label}保存确认超时`))
      }, this.options.timeoutMs ?? 15_000)
      timer.unref()
      this.writes.set(requestId, { resolve, reject, timer, label })
      try { send(requestId) }
      catch (error) { this.completePersistence({ requestId, error: error instanceof Error ? error.message : String(error) }) }
    })
  }

  dispose(): void {
    this.disposed = true
    for (const [requestId] of this.writes) this.completePersistence({ requestId, error: 'Host 已关闭' })
    this.states.clear()
  }
}
