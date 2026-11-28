/** MCP 特权桥参数与提交顺序；页面身份校验复用 trusted.test.ts 的真实守卫合同。 */
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcEvent } from '../../../../src/protocol'
import type { HostManager } from '../../../../src/electron/main/host/manager'
import type { McpCredentialStore } from '../../../../src/electron/main/credentials/mcp-store'
import { MCP_IPC } from '../../../../src/shared/mcp-ipc'
import { IPC } from '../../../../src/shared/ipc'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  open: vi.fn(async () => {}), read: vi.fn(() => '{"mcpServers":{}}'), exists: new Set<string>()
}))
vi.mock('electron', () => ({ shell: { openExternal: mocks.open } }))
vi.mock('node:os', () => ({ homedir: () => '/test-user' }))
vi.mock('node:fs', () => ({ existsSync: (path: string) => mocks.exists.has(path), readFileSync: mocks.read }))
vi.mock('../../../../src/electron/main/ipc/trusted', () => ({
  handleTrusted: (channel: string, listener: (event: unknown, raw?: unknown) => unknown) => mocks.handlers.set(channel, listener)
}))
import { registerMcpIpc, validateMcpExternalUrl } from '../../../../src/electron/main/ipc/mcp'
import { registerApprovalIpc } from '../../../../src/electron/main/ipc/approval'

function setup() {
  let eventSink!: (event: RpcEvent, generation: number) => void
  const host = { applyMcpCredentials: vi.fn(async () => {}), getGeneration: () => 7,
    confirmMcpPersistence: vi.fn(async () => {}), request: vi.fn(() => Promise.resolve({ ok: true })),
    setMcpEventSink: (listener: typeof eventSink) => { eventSink = listener } }
  const store = { setOAuthState: vi.fn(), readAll: () => ({ oauthStates: {} }) }
  registerMcpIpc(host as unknown as HostManager, store as unknown as McpCredentialStore)
  return { host, store, event: (event: RpcEvent, generation = 7) => eventSink(event, generation) }
}
beforeEach(() => { vi.clearAllMocks(); mocks.handlers.clear(); mocks.exists.clear() })

it('壳桥不再注册手动secret管理渠道，OAuth凭据静默托管', () => {
  setup()
  expect([...mocks.handlers.keys()]).not.toContain('mcp:secretList')
  expect([...mocks.handlers.keys()]).not.toContain('mcp:secretSet')
  expect([...mocks.handlers.keys()]).not.toContain('mcp:secretRemove')
})

it('OAuth写盘失败明确回传原代，旧Host事件不落盘，危险URL不开浏览器', () => {
  const { host, store, event } = setup()
  const params = { requestId: 'save', key: 'a'.repeat(64), state: { serverUrl: 'https://mcp.example' } }
  event({ jsonrpc: '2.0', method: 'mcp.oauth.persistState', params }, 6)
  expect(store.setOAuthState).not.toHaveBeenCalled()
  store.setOAuthState.mockImplementationOnce(() => { throw new Error('加密失败') })
  event({ jsonrpc: '2.0', method: 'mcp.oauth.persistState', params })
  expect(host.confirmMcpPersistence).toHaveBeenCalledWith({ requestId: 'save', error: '加密失败' }, 7)
  event({ jsonrpc: '2.0', method: 'mcp.oauth.openUrl', params: { loginId: 'login', url: 'file:///secret.txt' } })
  expect(mocks.open).not.toHaveBeenCalled()
  expect(() => validateMcpExternalUrl('http://remote.example/login')).toThrow()
  expect(() => validateMcpExternalUrl('javascript:alert(1)')).toThrow()
  expect(validateMcpExternalUrl('http://[::1]:1234/login')).toBe('http://[::1]:1234/login')
})

it('外部配置探测只给候选，选择后才读取，拒绝任意文件路径', () => {
  setup()
  const candidate = join('/test-user', '.cursor', 'mcp.json')
  mocks.exists.add(candidate)
  const detect = mocks.handlers.get(MCP_IPC.detectExternalConfigs)!
  expect(detect({})).toEqual([{ label: 'Cursor', path: candidate }])
  expect(mocks.read).not.toHaveBeenCalled()
  expect(detect({}, [candidate])).toEqual([{ label: 'Cursor', path: candidate, content: '{"mcpServers":{}}' }])
  expect(() => detect({}, ['/private/arbitrary-file'])).toThrow('已检测到')
})

it('MCP会话级工具授权只经专属审批IPC，非法授权档拒绝转发', async () => {
  const { host } = setup()
  registerApprovalIpc({ host: host as unknown as HostManager, getWindow: () => null })
  const respond = mocks.handlers.get(IPC.approvalRespond)!
  await respond({}, { requestId: 'approval', approved: true, mcpAlways: 'tool' })
  expect(host.request).toHaveBeenCalledWith('approval.respond', { requestId: 'approval', approved: true, mcpAlways: 'tool' })
  await expect(respond({}, { requestId: 'approval', approved: true, mcpAlways: 'all' })).rejects.toThrow('mcpAlways')
  expect(host.request).toHaveBeenCalledOnce()
})

it('OAuth状态必须加密落盘成功后才确认，登出删除也走原代确认', () => {
  const { host, store, event } = setup()
  const params = { requestId: 'save-oauth', key: 'b'.repeat(64), state: { serverUrl: 'https://mcp.example', tokens: { access_token: 'synthetic-private' } } }
  event({ jsonrpc: '2.0', method: 'mcp.oauth.persistState', params })
  expect(store.setOAuthState).toHaveBeenCalledWith(params.key, params.state)
  expect(store.setOAuthState.mock.invocationCallOrder[0]).toBeLessThan(host.confirmMcpPersistence.mock.invocationCallOrder[0])
  expect(host.confirmMcpPersistence).toHaveBeenCalledWith({ requestId: 'save-oauth' }, 7)
  expect(host.applyMcpCredentials).not.toHaveBeenCalled()
  event({ jsonrpc: '2.0', method: 'mcp.oauth.persistState', params: { requestId: 'logout', key: params.key } })
  expect(store.setOAuthState).toHaveBeenLastCalledWith(params.key, undefined)
  expect(host.confirmMcpPersistence).toHaveBeenLastCalledWith({ requestId: 'logout' }, 7)
})
