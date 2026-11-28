/** 隔离的真实组件验收页：所有服务和项目为页面内存夹具，不访问用户数据。 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { McpSection } from '@/features/settings/McpSection'
import { ElicitationPanel } from '@/features/home/ElicitationPanel'
import { ToolCard } from '@/components/ui/tool'
import { Button } from '@/components/ui/button'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import type { McpListResult } from '@shared/mcp'
import '@/globals.css'

const snapshot: McpListResult = { errors: [], servers: [
  { name: 'filesystem', type: 'stdio', detail: 'npx -y @modelcontextprotocol/server-filesystem D:/Workspace', enabled: true, exposure: 'deferred', origin: 'user', trusted: true,
    def: { name: 'filesystem', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/Workspace'] },
    runtime: { name: 'filesystem', poolKey: 'global:filesystem', state: 'connected', latencyMs: 16, updatedAt: new Date().toISOString(), resourcesCount: 1, promptsCount: 1,
      serverInfo: { name: 'Filesystem', version: '1.0' }, protocolVersion: '2025-11-25', tools: [
        { name: 'read_file', qualifiedName: 'mcp__filesystem__read_file', description: '读取工作区中指定文件的内容。', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, annotations: { readOnlyHint: true }, effectiveExposure: 'deferred' },
        { name: 'delete_file', qualifiedName: 'mcp__filesystem__delete_file', description: '删除指定文件，需要用户确认。', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { destructiveHint: true }, effectiveExposure: 'hidden' }
      ] } },
  { name: 'Remote Knowledge', type: 'http', detail: 'https://mcp.example.com', enabled: true, exposure: 'deferred', origin: 'user', trusted: true,
    def: { name: 'Remote Knowledge', type: 'http', url: 'https://mcp.example.com' },
    runtime: { name: 'Remote Knowledge', poolKey: 'global:remote', state: 'needs-auth', updatedAt: new Date().toISOString(), tools: [], resourcesCount: 0, promptsCount: 0 } }
] }
const listeners = new Set<(event: unknown) => void>()
Object.defineProperty(window, 'cogent', { value: {
  engineRequest: (method: string) => Promise.resolve().then(() => {
    if (method === 'mcp.list') return structuredClone(snapshot)
    if (method === 'mcp.resources.list') return { resources: [{ server: 'filesystem', name: '项目指南', uri: 'docs://guide' }], resourceTemplates: [] }
    if (method === 'mcp.prompts.list') return { prompts: [{ server: 'filesystem', name: 'review', description: '审阅指定文件' }] }
    if (method === 'mcp.oauth.login') return { loginId: 'fixture', authUrl: 'https://example.com/auth' }
    return { ok: true }
  }),
  onEngineEvent: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  mcp: { openUrl: () => Promise.resolve(),
    detectExternalConfigs: () => Promise.resolve([]), elicitationRespond: () => {
      const bucket = useChatStore.getState().bySession.fixture
      useChatStore.setState({ bySession: { fixture: { ...bucket!, pendingElicitations: [] } } })
      return Promise.resolve({ ok: true })
    } }
} })
useProjectStore.setState({ projects: [{ id: 'p', name: '演示项目', cwds: ['D:/Workspace'], createdAt: Date.now() }] })
useChatStore.setState({ activeSessionId: 'fixture', sessions: [{ id: 'fixture', title: 'MCP 验收', createdAt: Date.now(), updatedAt: Date.now() }], bySession: { fixture: emptyBucket() } })

function Harness() {
  const [tab, setTab] = useState('servers')
  const form = () => {
    useChatStore.setState({ bySession: { fixture: { ...emptyBucket(), pendingElicitations: [{ requestId: 'form', sessionId: 'fixture', server: 'Knowledge', message: '请选择要生成报告的区域，并确认是否包含归档资料。', mode: 'form', requestedSchema: { type: 'object', properties: { region: { type: 'string', title: '报告区域', enum: ['Asia', 'Europe'] }, includeArchive: { type: 'boolean', title: '包含归档资料' } }, required: ['region', 'includeArchive'] } }] } } })
    setTab('form')
  }
  return <main className="min-h-screen bg-background text-foreground">
    <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3"><span className="mr-auto text-sm">MCP 界面验收</span>
      <Button variant="outline" size="sm" onClick={() => setTab('servers')}>服务器</Button><Button variant="outline" size="sm" onClick={form}>交互表单</Button><Button variant="outline" size="sm" onClick={() => setTab('result')}>工具结果</Button>
    </div>
    {tab === 'servers' ? <McpSection /> : tab === 'form' ? <div className="mx-auto max-w-3xl py-12"><ElicitationPanel /></div> : <div className="mx-auto max-w-3xl p-5"><ToolCard name="mcp__knowledge__search" summary="mcp__knowledge__search(MCP 文档)" status="ok" result="找到两条资料" mcpResult={{ structuredContent: { total: 2, results: [{ title: '协议指南', score: 0.98 }] }, resourceLinks: [{ name: '协议指南', uri: 'docs://mcp/guide', description: '本次查询返回的资源' }] }} /></div>}
  </main>
}
createRoot(document.getElementById('root')!).render(<Harness />)
