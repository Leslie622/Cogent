/** MCP 服务端表单与浏览器交互；响应失败保留输入，成功由引擎 resolved 事件收口。 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useChatStore } from '@/stores/chat'
import { unwrapIpcError } from '@/lib/ipc'
import type { McpElicitationRequest } from '@/env.d'
const fieldText = (value: unknown): string => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''

function ElicitationForm({ request }: { request: McpElicitationRequest }) {
  const fields = request.mode === 'form' ? (request.requestedSchema.properties ?? {}) as Record<string, Record<string, unknown>> : {}
  const required = request.mode === 'form' && Array.isArray(request.requestedSchema.required) ? request.requestedSchema.required as string[] : []
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(Object.entries(fields).filter(([, field]) => field.default !== undefined || field.type === 'boolean').map(([name, field]) => [name, field.default ?? false])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const respond = async (action: 'accept' | 'decline' | 'cancel') => {
    setBusy(true); setError(undefined)
    try {
      await window.cogent.mcp.elicitationRespond({ requestId: request.requestId, action,
        ...(action === 'accept' && request.mode === 'form' && { content: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')) }) })
    } catch (failure) { setError(unwrapIpcError(failure)) }
    finally { setBusy(false) }
  }
  return <form data-slot="interaction-panel" aria-label="MCP 信息请求" className="flex flex-col gap-3 rounded-xl border bg-card p-4" onSubmit={(event) => { event.preventDefault(); void respond('accept') }}>
    <div className="text-xs text-muted-foreground">{request.server} 请求补充信息</div>
    <div className="whitespace-pre-wrap text-sm">{request.message}</div>
    {request.mode === 'url' ? <div className="flex flex-col gap-2 text-sm">
      <div className="break-all">{new URL(request.url).hostname}</div>
      <p className="text-xs text-muted-foreground">请核对目标网站后继续。只在该网站输入所需信息。</p>
      <Button type="button" variant="outline" onClick={() => { void window.cogent.mcp.openUrl(request.url).catch((failure) => setError(unwrapIpcError(failure))) }}>在浏览器打开</Button>
    </div> : Object.entries(fields).map(([name, field], index) => {
      const label = typeof field.title === 'string' ? field.title : name
      const choices = Array.isArray(field.enum) ? field.enum : undefined
      return <div key={name} className="flex flex-col gap-1.5">
        <label className="text-sm" htmlFor={`${request.requestId}-${name}`}>{label}{required.includes(name) ? ' *' : ''}</label>
        {choices ? <Select value={values[name] === undefined ? null : fieldText(values[name])} onValueChange={(value) => setValues((old) => ({ ...old, [name]: field.type === 'boolean' ? value === 'true' : field.type === 'number' || field.type === 'integer' ? Number(value) : value }))}>
          <SelectTrigger id={`${request.requestId}-${name}`} className="w-full"><SelectValue placeholder="请选择" /></SelectTrigger>
          <SelectContent>{choices.map((choice) => <SelectItem key={String(choice)} value={String(choice)}>{String(choice)}</SelectItem>)}</SelectContent>
        </Select> : field.type === 'boolean' ? <Checkbox id={`${request.requestId}-${name}`} checked={values[name] === true} onCheckedChange={(checked) => setValues((old) => ({ ...old, [name]: checked === true }))} /> :
          <Input id={`${request.requestId}-${name}`} autoFocus={index === 0} required={required.includes(name)}
            type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} step={field.type === 'integer' ? 1 : 'any'}
            value={fieldText(values[name])} onChange={(event) => { const value = event.target.value; setValues((old) => ({ ...old, [name]: value !== '' && (field.type === 'number' || field.type === 'integer') ? Number(value) : value })) }} />}
        {typeof field.description === 'string' && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    })}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void respond('cancel') }}>取消</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void respond('decline') }}>拒绝</Button>
      <Button type="submit" size="sm" disabled={busy}>{request.mode === 'url' ? '我已完成' : '提交'}</Button>
    </div>
  </form>
}
export function ElicitationPanel() {
  const request = useChatStore((state) => state.bySession[state.activeSessionId ?? '']?.pendingElicitations?.[0])
  if (!request) return null
  return <div className="shrink-0 px-4 pb-4"><div className="mx-auto w-full max-w-3xl"><ElicitationForm key={request.requestId} request={request} /></div></div>
}
