/** OAuth 状态只有在壳确认加密提交后才可见，取消和并发刷新不能挂死。 */
import { describe, expect, it } from 'vitest'
import { McpSecretBridge, type McpOAuthPersistRequest } from '../../../src/host/runtime/mcp-secrets'

describe('McpSecretBridge', () => {
  it('仅已保存Token算授权，注册元数据、别的服务器与已清空快照不算', () => {
    const bridge = new McpSecretBridge()
    const serverUrl = 'https://mcp.example'
    bridge.sync({ oauthStates: {
      token: { serverUrl, tokens: { access_token: 'saved', token_type: 'Bearer' } },
      refresh: { serverUrl, tokens: { refresh_token: 'refresh', token_type: 'Bearer' } },
      registered: { serverUrl, clientId: 'registered-only' }
    } })
    expect(bridge.isAuthorized('token', serverUrl)).toBe(true)
    expect(bridge.isAuthorized('refresh', serverUrl)).toBe(true)
    expect(bridge.isAuthorized('registered', serverUrl)).toBe(false)
    expect(bridge.isAuthorized('missing', serverUrl)).toBe(false)
    expect(bridge.isAuthorized('token', 'https://other.example')).toBe(false)
    bridge.sync({ oauthStates: {} })
    expect(bridge.isAuthorized('token', serverUrl)).toBe(false)
    bridge.dispose()
  })
  it('等待持久化确认，失败保留旧状态；无壳存储时拒绝保存', async () => {
    const requests: McpOAuthPersistRequest[] = []
    const bridge = new McpSecretBridge({ persist: request => requests.push(request) })
    const url = 'https://mcp.example/server'
    bridge.sync({ oauthStates: { server: { serverUrl: url, oauthState: 'old' } } })
    const store = bridge.stateStore('server', url)
    const pending = store.save({ serverUrl: url, oauthState: 'new' })
    expect(await store.load()).toEqual({ serverUrl: url, oauthState: 'old' })
    bridge.completePersistence({ requestId: requests[0].requestId })
    await pending
    expect(await store.load()).toEqual({ serverUrl: url, oauthState: 'new' })
    const failed = Promise.resolve(store.save({ serverUrl: url, oauthState: 'lost' })).catch((error: unknown) => error)
    bridge.completePersistence({ requestId: requests[1].requestId, error: '磁盘已满' })
    expect(await failed).toEqual(new Error('MCP OAuth 凭据保存失败：磁盘已满'))
    expect((await store.load())?.oauthState).toBe('new')
    await expect(new McpSecretBridge().stateStore('server', url).save({ serverUrl: url })).rejects.toThrow('安全凭据存储')
    bridge.dispose()
  })

  it('同服务器刷新串行且失败释放锁，关闭拒绝在途写入', async () => {
    const bridge = new McpSecretBridge({ persist: () => {} })
    const store = bridge.stateStore('server', 'https://mcp.example')
    const order: number[] = []
    let release!: () => void
    const first = store.withRefreshLock(async () => {
      order.push(1)
      await new Promise<void>(resolve => { release = resolve })
      order.push(2)
      throw new Error('刷新失败')
    }).catch((error: unknown) => error)
    const second = store.withRefreshLock(() => { order.push(3); return Promise.resolve() })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([1])
    release()
    await first
    await second
    expect(order).toEqual([1, 2, 3])
    const pending = Promise.resolve(store.save({ serverUrl: 'https://mcp.example' })).catch((error: unknown) => error)
    bridge.dispose()
    expect(await pending).toEqual(new Error('MCP OAuth 凭据保存失败：Host 已关闭'))
    expect(await store.load()).toBeUndefined()
  })
})
