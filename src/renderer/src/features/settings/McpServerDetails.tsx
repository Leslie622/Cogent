/** MCP 连接诊断与工具治理；所有切换由父级按原作用域持久化。 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { unwrapIpcError } from '@/lib/ipc'
import type { McpExposure, McpPromptInfo, McpResourceInfo, McpResourceTemplateInfo, McpScope, McpServerSummary } from '@shared/mcp'
import { BADGE } from './models-recipes'

export function McpServerDetails({ server, scope, busy, onExposure }: {
  server: McpServerSummary; scope: McpScope; busy: boolean
  onExposure: (tool: string | undefined, exposure: McpExposure) => void
}) {
  const [resources, setResources] = useState<McpResourceInfo[]>([])
  const [templates, setTemplates] = useState<McpResourceTemplateInfo[]>([])
  const [prompts, setPrompts] = useState<McpPromptInfo[]>([])
  const [error, setError] = useState<string>()
  const { cwd, projectId } = scope
  useEffect(() => {
    if (server.runtime?.state !== 'connected') return
    let active = true
    void Promise.all([
      window.cogent.engineRequest('mcp.resources.list', { server: server.name, cwd, projectId }),
      window.cogent.engineRequest('mcp.prompts.list', { cwd, projectId })
    ]).then(([resourceResult, promptResult]) => {
      if (!active) return
      setResources(resourceResult.resources); setTemplates(resourceResult.resourceTemplates); setPrompts(promptResult.prompts.filter((prompt) => prompt.server === server.name)); setError(undefined)
    }, (cause: unknown) => { if (active) setError(unwrapIpcError(cause)) })
    return () => { active = false }
  }, [cwd, projectId, server.name, server.runtime?.state, server.runtime?.revision])
  const exposureSelect = (value: McpExposure, tool?: string) => <Select value={value === 'codemode' ? 'deferred' : value} onValueChange={(next) => { if (next !== null) onExposure(tool, next) }}>
    <SelectTrigger aria-label={tool === undefined ? `${server.name} 暴露档` : `${tool} 暴露档`} disabled={busy}><SelectValue /></SelectTrigger>
    <SelectContent>{(['deferred', 'direct', 'hidden'] as const).map((exposure) => <SelectItem key={exposure} value={exposure}>{exposure}</SelectItem>)}</SelectContent>
  </Select>
  return <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
    <div className="flex items-center justify-between gap-3"><span className="text-sm">服务器默认暴露档</span>{exposureSelect(server.exposure)}</div>
    <Tabs defaultValue="tools"><TabsList variant="line"><TabsTrigger value="tools">工具（{server.runtime?.tools.length ?? 0}）</TabsTrigger><TabsTrigger value="resources">资源与提示词</TabsTrigger><TabsTrigger value="diagnostics">诊断与日志</TabsTrigger></TabsList>
      <TabsContent value="tools" className="flex flex-col gap-3 pt-3">
        {(server.runtime?.tools ?? []).map((tool) => <div key={tool.name} className="flex flex-col gap-2 border-b border-border pb-3 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2"><code className="mr-auto text-xs">{tool.name}</code>{tool.annotations?.readOnlyHint === true && <span className={BADGE}>只读</span>}{tool.annotations?.destructiveHint === true && <span className={BADGE}>破坏性</span>}<Switch aria-label={`${tool.name} 工具启用`} disabled={busy} checked={tool.effectiveExposure !== 'hidden'} onCheckedChange={(enabled) => onExposure(tool.name, enabled ? server.exposure === 'hidden' ? 'deferred' : server.exposure : 'hidden')} />{exposureSelect(tool.effectiveExposure, tool.name)}</div>
          {tool.description !== undefined && <p className="text-sm text-muted-foreground">{tool.description}</p>}
          <Collapsible><CollapsibleTrigger render={<Button variant="disclosure" size="xs" />}>参数 Schema</CollapsibleTrigger><CollapsibleContent><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre></CollapsibleContent></Collapsible>
        </div>)}
        {(server.runtime?.tools.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">暂无可用工具</p>}
      </TabsContent>
      <TabsContent value="resources" className="flex flex-col gap-3 pt-3">
        {resources.map((resource) => <div key={resource.uri}><p className="text-sm">{resource.name}</p><p className="break-all text-xs text-muted-foreground">{resource.uri}</p></div>)}
        {templates.map((template) => <div key={template.uriTemplate}><p className="text-sm">{template.name}</p><p className="break-all text-xs text-muted-foreground">{template.uriTemplate}</p></div>)}
        {prompts.map((prompt) => <div key={prompt.name}><code className="text-xs">/mcp:{server.name}:{prompt.name}</code><p className="text-sm text-muted-foreground">{prompt.description}</p></div>)}
        {resources.length === 0 && templates.length === 0 && prompts.length === 0 && <p className="text-sm text-muted-foreground">此服务器未提供资源或提示词</p>}
        {error !== undefined && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </TabsContent>
      <TabsContent value="diagnostics" className="flex flex-col gap-3 pt-3">
        <p className="break-all text-xs text-muted-foreground">来源：{server.source ?? '用户配置'}</p>
        {server.runtime?.serverInfo !== undefined && <p className="text-sm">{server.runtime.serverInfo.name} · {server.runtime.serverInfo.version}</p>}
        {server.runtime?.protocolVersion !== undefined && <p className="text-xs text-muted-foreground">协议 {server.runtime.protocolVersion}</p>}
        {server.runtime?.error !== undefined && <p role="alert" className="whitespace-pre-wrap break-all text-sm text-destructive">{server.runtime.error}</p>}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{server.runtime?.stderrTail || '暂无 stderr 日志'}</pre>
        <Button variant="outline" size="xs" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ name: server.name, source: server.source, runtime: server.runtime }, null, 2)).catch((cause: unknown) => setError(unwrapIpcError(cause)))}>复制诊断</Button>
        {error !== undefined && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </TabsContent>
    </Tabs>
  </div>
}
