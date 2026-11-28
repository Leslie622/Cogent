/** MCP RPC边界校验项目身份，并且OAuth快照必须完整校验后交接。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpHandlers } from '../../../src/host/runtime/mcp-handlers'
import { McpSecretBridge } from '../../../src/host/runtime/mcp-secrets'

let root: string, otherRoot: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cogent-mcp-handler-')); otherRoot = mkdtempSync(join(tmpdir(), 'cogent-mcp-other-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(otherRoot, { recursive: true, force: true }) })

function fixture() {
  const override = vi.fn()
  const refresh = vi.fn(() => Promise.resolve())
  const secrets = new McpSecretBridge()
  const deps = { config: { override }, runtime: { refresh }, trust: {}, oauth: {}, elicitation: {}, secrets,
    projects: { get: (id: string) => id === 'project' ? { id, cwds: [root] } : undefined } }
  const handlers = new Map(mcpHandlers(deps as unknown as Parameters<typeof mcpHandlers>[0]))
  return { override, refresh, secrets, invoke: (method: string, params: unknown) => handlers.get(method)!(params) }
}

it('带projectId的override必须核真实cwd，错配和不存在的项目均不写文件', async () => {
  const { invoke, override, refresh } = fixture()
  await expect(invoke('mcp.override', { projectId: 'project', cwd: otherRoot, name: 'server', enabled: false })).rejects.toThrow('主根不一致')
  await expect(invoke('mcp.override', { projectId: 'missing', cwd: root, name: 'server', enabled: false })).rejects.toThrow('项目不存在')
  expect(override).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  await invoke('mcp.override', { projectId: 'project', cwd: root, name: 'server', enabled: false })
  expect(override).toHaveBeenCalledWith(root, 'server', { enabled: false })
})

it('只接受完整OAuth快照，拒绝旧secret负载且不清空已有授权', async () => {
  const { invoke, secrets, refresh } = fixture()
  const serverUrl = 'https://mcp.example'
  secrets.sync({ oauthStates: { server: { serverUrl, tokens: { access_token: 'rotated-token', token_type: 'Bearer' } } } })
  await expect(invoke('mcp.secrets.sync', { secrets: { KEY: 'removed' } })).rejects.toThrow()
  expect(refresh).not.toHaveBeenCalled()
  expect((await secrets.stateStore('server', serverUrl).load())?.tokens?.access_token).toBe('rotated-token')
  await invoke('mcp.secrets.sync', { oauthStates: {} })
  expect(await secrets.stateStore('server', serverUrl).load()).toBeUndefined()
  secrets.dispose()
})
