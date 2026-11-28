/** MCP 设置回归：作用域事件、单工具治理、无损高级表单和 OAuth 交互。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '@/env.d'
import type { McpServerDef, McpServerRuntimeStatus, McpServerSummary } from '@shared/mcp'
import { McpSection } from '@/features/settings/McpSection'
import { McpServerDialog } from '@/features/settings/McpServerDialog'
import { McpImportDialog, McpOAuthDialog } from '@/features/settings/McpManagementDialogs'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'

const chat = useChatStore.getState()
const projects = useProjectStore.getState()
beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: [] })
  useProjectStore.setState({ projects: [] })
})
afterEach(() => { cleanup(); useChatStore.setState(chat, true); useProjectStore.setState(projects, true); vi.unstubAllGlobals() })

function runtime(state: McpServerRuntimeStatus['state'] = 'connected'): McpServerRuntimeStatus {
  return { name: 'demo', poolKey: 'global:demo', state, tools: [{ name: 'query', qualifiedName: 'mcp__demo__query', description: '查找项目记录', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true }, effectiveExposure: 'deferred' }], resourcesCount: 0, promptsCount: 0, updatedAt: '2026-11-28T00:00:00Z' }
}

describe('MCP settings', () => {
  it('连接事件更新状态，工具级关闭写回用户定义并保留扩展字段', async () => {
    const definition: McpServerDef = { name: 'demo', type: 'stdio', command: 'node', extraFields: { vendor: true } }
    const server: McpServerSummary = { name: 'demo', type: 'stdio', detail: 'node', enabled: true, exposure: 'deferred', def: definition, runtime: runtime('connecting') }
    let listener: ((event: EngineEvent) => void) | undefined
    const request = vi.fn((method: string) => {
      if (method === 'mcp.list') return Promise.resolve({ servers: [server], errors: [] })
      if (method === 'mcp.resources.list') return Promise.resolve({ resources: [], resourceTemplates: [] })
      if (method === 'mcp.prompts.list') return Promise.resolve({ prompts: [] })
      if (method === 'mcp.sync') return Promise.resolve({ synced: 1 })
      throw new Error(`unexpected ${method}`)
    })
    vi.stubGlobal('cogent', { engineRequest: request, onEngineEvent: (callback: (event: EngineEvent) => void) => { listener = callback; return () => { listener = undefined } } })
    render(<McpSection />)
    await screen.findByLabelText('demo 状态：connecting')
    act(() => listener?.({ method: 'mcp.statusChanged', params: { servers: [runtime()] } }))
    expect(screen.getByLabelText('demo 状态：connected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '详情 demo' }))
    expect(await screen.findByText('只读')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'query 工具启用' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('mcp.sync', { servers: [{ ...definition, toolExposure: { query: 'hidden' } }] }))
    expect(screen.queryByRole('button', { name: '高级 · 附件分析工具' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '密钥管理' })).not.toBeInTheDocument()
    expect(screen.queryByText('图片分析')).not.toBeInTheDocument()
  })

  it.each(['user', 'project'] as const)('%s 视图只接收当前完整作用域的状态广播，同名无 runtime 项不能串入', async (scope) => {
    if (scope === 'project') {
      useProjectStore.setState({ projects: [{ id: 'scope-project', name: '当前项目', cwds: ['C:/scope-work'], createdAt: 1 }] })
      useChatStore.setState({ activeSessionId: 'scope-session', sessions: [{ id: 'scope-session', title: '会话', projectId: 'scope-project', createdAt: 1, updatedAt: 1 }] })
    }
    const server: McpServerSummary = { name: 'demo', type: 'stdio', detail: 'node', enabled: true, exposure: 'deferred', def: { name: 'demo', type: 'stdio', command: 'node' } }
    let listener: ((event: EngineEvent) => void) | undefined
    const request = vi.fn().mockResolvedValue({ servers: [server], errors: [] })
    vi.stubGlobal('cogent', { engineRequest: request, onEngineEvent: (callback: (event: EngineEvent) => void) => { listener = callback; return () => { listener = undefined } } })
    render(<McpSection />)
    await screen.findByLabelText('demo 状态：disconnected')
    const matching = scope === 'user' ? {} : { projectId: 'scope-project', cwd: 'C:/scope-work' }
    const otherScopes = scope === 'user'
      ? [{ projectId: 'scope-project', cwd: 'C:/scope-work' }, { projectId: 'scope-project' }, { cwd: 'C:/scope-work' }]
      : [{}, { projectId: 'other-project', cwd: 'C:/scope-work' }, { projectId: 'scope-project', cwd: 'C:/other-work' }, { projectId: 'scope-project' }, { cwd: 'C:/scope-work' }]
    for (const other of otherScopes) {
      act(() => listener?.({ method: 'mcp.statusChanged', params: { ...other, servers: [runtime()] } }))
      expect(screen.getByLabelText('demo 状态：disconnected')).toBeInTheDocument()
    }
    act(() => listener?.({ method: 'mcp.statusChanged', params: { ...matching, servers: [runtime('connecting')] } }))
    expect(screen.getByLabelText('demo 状态：connecting')).toBeInTheDocument()
    // 作用域相同仍不认领另一条物理连接的同名状态。
    act(() => listener?.({ method: 'mcp.statusChanged', params: { ...matching, servers: [{ ...runtime(), poolKey: 'another:demo' }] } }))
    expect(screen.getByLabelText('demo 状态：connecting')).toBeInTheDocument()
    act(() => listener?.({ method: 'mcp.statusChanged', params: { ...matching, servers: [runtime()] } }))
    expect(screen.getByLabelText('demo 状态：connected')).toBeInTheDocument()
  })

  it('公开与静态 Header 远程服务器不显示登出，只有已授权 OAuth 连接提供登出', async () => {
    const servers: McpServerSummary[] = [
      { name: 'public', type: 'http', detail: 'https://public.example/mcp', enabled: true, exposure: 'deferred', def: { name: 'public', type: 'http', url: 'https://public.example/mcp' }, runtime: { ...runtime(), name: 'public' } },
      { name: 'static-header', type: 'sse', detail: 'https://header.example/sse', enabled: true, exposure: 'deferred', def: { name: 'static-header', type: 'sse', url: 'https://header.example/sse', headers: { Authorization: 'Bearer ${env:TOKEN}' } }, runtime: { ...runtime(), name: 'static-header', oauthAuthorized: false } },
      { name: 'oauth', type: 'http', detail: 'https://oauth.example/mcp', enabled: true, exposure: 'deferred', def: { name: 'oauth', type: 'http', url: 'https://oauth.example/mcp' }, runtime: { ...runtime(), name: 'oauth', oauthAuthorized: true } }
    ]
    const request = vi.fn((method: string) => Promise.resolve(method === 'mcp.list' ? { servers, errors: [] } : { ok: true }))
    vi.stubGlobal('cogent', { engineRequest: request, onEngineEvent: () => () => {} })
    render(<McpSection />)
    await screen.findByLabelText('oauth 状态：connected')
    expect(screen.getAllByRole('button', { name: '登出' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '登出' }))
    expect(request).toHaveBeenCalledWith('mcp.oauth.logout', { name: 'oauth' })
  })

  it('项目信任操作携带稳定项目ID、主根与原审阅摘要', async () => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: '项目', cwds: ['C:/work'], createdAt: 1 }] })
    useChatStore.setState({ activeSessionId: 's1', sessions: [{ id: 's1', title: '会话', projectId: 'p1', createdAt: 1, updatedAt: 1 }] })
    const pending = { projectId: 'p1', filePath: 'C:/work/.mcp.json', sha256: 'a'.repeat(64), servers: [{ name: 'local', type: 'stdio' as const, command: 'node', envKeys: ['TOKEN'], headerKeys: [] }] }
    const request = vi.fn((method: string) => method === 'mcp.list' ? Promise.resolve({ servers: [], errors: [], pendingTrustFiles: [pending] }) : Promise.resolve({ ok: true }))
    vi.stubGlobal('cogent', { engineRequest: request, onEngineEvent: () => () => {} })
    render(<McpSection />)
    fireEvent.click(await screen.findByRole('button', { name: '信任并启用' }))
    expect(request).toHaveBeenCalledWith('mcp.trust.decide', { projectId: 'p1', cwd: 'C:/work', filePath: pending.filePath, sha256: pending.sha256, decision: 'trust' })
  })

  it('SSE 高级表单编辑保留 OAuth、单工具策略、超时和未知字段', async () => {
    const save = vi.fn()
    const initial: McpServerDef = { name: 'remote', type: 'sse', url: 'https://example.com/sse', timeout: 90, oauth: { clientId: 'public', clientSecret: '${env:MCP_CLIENT_SECRET}' }, toolExposure: { query: 'direct' }, extraFields: { vendor: 'retained' } }
    render(<McpServerDialog open initial={initial} onClose={() => {}} onSave={save} />)
    fireEvent.click(screen.getByRole('button', { name: '高级选项' }))
    expect(await screen.findByLabelText('请求超时（秒）')).toHaveValue('90')
    expect(screen.getByLabelText('OAuth 配置')).toHaveValue(JSON.stringify(initial.oauth, null, 2))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ ...initial, exposure: 'deferred' }, 'remote'))
  })

  it('测试连接不会保存配置，失败结果保留正在编辑的表单', async () => {
    const save = vi.fn()
    const request = vi.fn().mockRejectedValue(new Error('连接被拒绝'))
    vi.stubGlobal('cogent', { engineRequest: request })
    render(<McpServerDialog open initial={{ name: 'local', type: 'stdio', command: 'node' }} onClose={() => {}} onSave={save} />)
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText('连接被拒绝')).toBeVisible()
    expect(screen.getByDisplayValue('node')).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
    expect(request.mock.calls[0][0]).toBe('mcp.probe')
  })

  it('本机配置检测只列路径，用户选择后才读取并预览正文', async () => {
    const detect = vi.fn((paths?: string[]) => Promise.resolve(paths === undefined ? [{ label: 'Cursor', path: 'C:/cursor.json' }] : [{ label: 'Cursor', path: 'C:/cursor.json', content: '{"mcpServers":{"demo":{"command":"node"}}}' }]))
    const onImport = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('cogent', { mcp: { detectExternalConfigs: detect } })
    render(<McpImportDialog open onClose={() => {}} onImport={onImport} />)
    fireEvent.click(screen.getByRole('button', { name: '检测本机客户端配置' }))
    expect(detect).toHaveBeenCalledExactlyOnceWith()
    fireEvent.click(await screen.findByRole('button', { name: 'Cursor · 读取配置' }))
    expect(detect).toHaveBeenCalledWith(['C:/cursor.json'])
    await waitFor(() => expect(screen.getByLabelText('导入配置 JSON')).toHaveValue('{"mcpServers":{"demo":{"command":"node"}}}'))
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    await waitFor(() => expect(onImport).toHaveBeenCalledWith([{ name: 'demo', type: 'stdio', command: 'node' }]))
  })

  it('OAuth 手动回调走对应登录事务，成功后不再取消已完成事务', async () => {
    const request = vi.fn((method: string) => Promise.resolve(method === 'mcp.oauth.login' ? { loginId: 'login-1', authUrl: 'https://example.com/authorize' } : { ok: true }))
    const completed = vi.fn()
    const closed = vi.fn()
    vi.stubGlobal('cogent', { engineRequest: request })
    const view = render(<McpOAuthDialog server="remote" scope={{ cwd: 'C:/workspace', projectId: 'p1' }} onClose={closed} onComplete={completed} />)
    await screen.findByLabelText('授权链接')
    fireEvent.change(screen.getByLabelText('手动回调 URL'), { target: { value: 'http://127.0.0.1:1234/callback?code=code&state=state' } })
    fireEvent.click(screen.getByRole('button', { name: '完成授权' }))
    await waitFor(() => expect(completed).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledWith('mcp.oauth.completeManual', { loginId: 'login-1', redirectUrl: 'http://127.0.0.1:1234/callback?code=code&state=state' })
    view.unmount()
    expect(request).not.toHaveBeenCalledWith('mcp.oauth.cancel', expect.anything())
    expect(closed).toHaveBeenCalledOnce()
  })

  it('旧表单探测迟到结果不能污染重新打开的另一个服务器', async () => {
    let complete!: (value: McpServerRuntimeStatus) => void
    const pending = new Promise<McpServerRuntimeStatus>((resolve) => { complete = resolve })
    vi.stubGlobal('cogent', { engineRequest: vi.fn(() => pending) })
    const first: McpServerDef = { name: 'first', type: 'stdio', command: 'first-command' }
    const next: McpServerDef = { name: 'next', type: 'stdio', command: 'next-command' }
    const view = render(<McpServerDialog open initial={first} onSave={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    view.rerender(<McpServerDialog open={false} initial={first} onSave={() => {}} onClose={() => {}} />)
    view.rerender(<McpServerDialog open initial={next} onSave={() => {}} onClose={() => {}} />)
    await act(async () => { complete({ ...runtime('failed'), error: 'first-probe-error' }); await pending })
    expect(screen.getByDisplayValue('next-command')).toBeInTheDocument()
    expect(screen.queryByText('first-probe-error')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled()
  })
})
