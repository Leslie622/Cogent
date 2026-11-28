/** MCP 设置的配置导入与 OAuth 授权交互。 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { unwrapIpcError } from '@/lib/ipc'
import type { McpServerDef, McpScope } from '@shared/mcp'
import type { McpExternalConfig } from '@shared/mcp-ipc'
import { parseImport } from './mcp-import'

export function McpImportDialog({ open, onClose, onImport }: {
  open: boolean; onClose: () => void; onImport: (definitions: McpServerDef[]) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [warnings, setWarnings] = useState<string[]>([])
  const [external, setExternal] = useState<McpExternalConfig[]>([])
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => { generation.current++; if (open) { setText(''); setError(undefined); setExternal([]); setWarnings([]); setBusy(false) } }, [open])
  const detect = async (): Promise<void> => {
    const operation = generation.current
    setBusy(true)
    try { const candidates = await window.cogent.mcp.detectExternalConfigs(); if (generation.current === operation) setExternal(candidates) } catch (cause) { if (generation.current === operation) setError(unwrapIpcError(cause)) }
    finally { if (generation.current === operation) setBusy(false) }
  }
  const read = async (path: string): Promise<void> => {
    const operation = generation.current
    setBusy(true)
    try {
      const result = (await window.cogent.mcp.detectExternalConfigs([path])).at(0)
      if (generation.current !== operation) return
      if (result?.error !== undefined) throw new Error(result.error)
      if (result?.content === undefined) throw new Error('未能读取所选配置')
      setText(result.content); setError(undefined)
      setWarnings(parseImport(result.content).warnings ?? [])
    } catch (cause) { if (generation.current === operation) setError(unwrapIpcError(cause)) }
    finally { if (generation.current === operation) setBusy(false) }
  }
  const run = async (): Promise<void> => {
    const operation = generation.current
    setBusy(true)
    try {
      const result = parseImport(text)
      if (result.errors.length > 0) throw new Error(result.errors.join('；'))
      if (result.defs.length === 0) throw new Error('没有可导入的服务器')
      if (result.warnings !== undefined && warnings.length === 0) { setWarnings(result.warnings); return }
      if (await onImport(result.defs) && generation.current === operation) onClose()
    } catch (cause) { if (generation.current === operation) setError(unwrapIpcError(cause)) }
    finally { if (generation.current === operation) setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose() }}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader><DialogTitle>导入 MCP 服务器</DialogTitle></DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <label className="flex flex-col gap-1.5 text-sm">配置 JSON<Textarea aria-label="导入配置 JSON" rows={10} className="font-mono text-xs" value={text} onChange={(event) => { setText(event.target.value); setError(undefined); setWarnings([]) }} placeholder="粘贴 Claude / Cursor、VS Code 或 OpenCode 配置" /></label>
        <Button variant="outline" disabled={busy} onClick={() => void detect()}>检测本机客户端配置</Button>
        {external.map((candidate) => <Button key={candidate.path} variant="ghost" disabled={busy} onClick={() => void read(candidate.path)} title={candidate.path}>{candidate.label} · 读取配置</Button>)}
        {warnings.map((warning) => <p key={warning} className="text-sm text-muted-foreground">{warning}</p>)}
        {error !== undefined && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy} onClick={() => void run()}>导入</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export function McpOAuthDialog({ server, scope, onClose, onComplete }: {
  server: string | null; scope: McpScope; onClose: () => void; onComplete: () => void
}) {
  const [login, setLogin] = useState<{ loginId: string; authUrl: string }>()
  const [redirectUrl, setRedirectUrl] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const activeLogin = useRef<string | undefined>(undefined)
  const { cwd, projectId } = scope
  useEffect(() => {
    if (server === null) return
    let active = true
    setLogin(undefined); setError(undefined); setRedirectUrl(''); setBusy(true)
    void window.cogent.engineRequest('mcp.oauth.login', { name: server, cwd, projectId }).then((result) => {
      if (!active) { void window.cogent.engineRequest('mcp.oauth.cancel', { loginId: result.loginId }).catch(() => {}); return }
      activeLogin.current = result.loginId; setLogin(result); setBusy(false)
    }, (cause: unknown) => { if (active) { setError(unwrapIpcError(cause)); setBusy(false) } })
    return () => {
      active = false
      const loginId = activeLogin.current
      activeLogin.current = undefined
      if (loginId !== undefined) void window.cogent.engineRequest('mcp.oauth.cancel', { loginId }).catch(() => {})
    }
  }, [server, cwd, projectId])
  const manual = async (): Promise<void> => {
    if (login === undefined) return
    setBusy(true)
    try { await window.cogent.engineRequest('mcp.oauth.completeManual', { loginId: login.loginId, redirectUrl }); activeLogin.current = undefined; onComplete(); onClose() }
    catch (cause) { setError(unwrapIpcError(cause)) }
    finally { setBusy(false) }
  }
  return <Dialog open={server !== null} onOpenChange={(next) => { if (!next) onClose() }}><DialogContent className="sm:max-w-lg">
    <DialogHeader><DialogTitle>登录 {server}</DialogTitle></DialogHeader>
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">在浏览器完成授权，连接状态会自动更新。</p>
      {login !== undefined && <><Button variant="outline" onClick={() => void window.cogent.mcp.openUrl(login.authUrl).catch((cause: unknown) => setError(unwrapIpcError(cause)))}>打开授权页面</Button><Input aria-label="授权链接" readOnly value={login.authUrl} /><label className="flex flex-col gap-1.5 text-sm">手动粘贴回调 URL<Input aria-label="手动回调 URL" value={redirectUrl} onChange={(event) => setRedirectUrl(event.target.value)} /></label></>}
      {error !== undefined && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    <DialogFooter><Button variant="ghost" onClick={onClose}>取消登录</Button><Button disabled={busy || redirectUrl.trim() === ''} onClick={() => void manual()}>完成授权</Button></DialogFooter>
  </DialogContent></Dialog>
}
