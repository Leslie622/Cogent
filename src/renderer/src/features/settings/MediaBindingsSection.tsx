/** 媒体处理能力单独绑定到既有 MCP；配置不触发安装或上传。 */
import { useEffect, useState } from 'react'
import type { MediaBinding, MediaBindings, MediaCapability } from '@shared/attachments'
import type { McpServerSummary } from '@/env.d'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import type { SettingItemId } from './search/catalog'
import { unwrapIpcError } from '@/lib/ipc'
import { useAttachmentStore } from '@/stores/attachments'

const LABELS: Record<MediaCapability, string> = { image: '图片分析', video: '视频分析', document: '文档视觉分析' }
const SEARCH_IDS: Record<MediaCapability, SettingItemId> = {
  image: 'connections.media-image',
  video: 'connections.media-video',
  document: 'connections.media-document',
}
const EMPTY: MediaBinding = { server: '', tool: '', pathArgument: 'path', questionArgument: 'question', formats: [] }

export function MediaBindingsSection({ servers }: { servers: McpServerSummary[] }) {
  const [bindings, setBindings] = useState<MediaBindings>({})
  const [editing, setEditing] = useState<MediaCapability>()
  const [form, setForm] = useState<MediaBinding>(EMPTY)
  const [formats, setFormats] = useState('')
  const [limit, setLimit] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.cogent.engineRequest('attachments.media', {}).then(setBindings, (cause: unknown) => setError(unwrapIpcError(cause)))
  }, [])
  const save = async (remove: boolean): Promise<void> => {
    const next = { ...bindings }
    if (remove) delete next[editing!]
    else {
      const bytes = limit.trim() === '' ? undefined : Number(limit) * 1024 * 1024
      const binding: MediaBinding = { ...form, formats: formats.split(/[,，\s]+/).filter(Boolean).map((f) => (f.startsWith('.') ? f : '.' + f).toLowerCase()) }
      if (bytes === undefined) delete binding.maxBytes
      else binding.maxBytes = bytes
      next[editing!] = binding
    }
    setBusy(true)
    try {
      await window.cogent.engineRequest('attachments.saveMedia', { bindings: next })
      setBindings(next); useAttachmentStore.setState({ media: next }); setEditing(undefined); setError(undefined)
    } catch (cause) { setError(unwrapIpcError(cause)) }
    finally { setBusy(false) }
  }
  const diagnostic = (binding: MediaBinding): string => {
    const server = servers.find((s) => s.name === binding.server)
    if (server === undefined) return '服务器未安装；无法分析'
    if (!server.enabled) return '服务器未启用；无法分析'
    if (server.type === 'http') return '输入不兼容：远程 HTTP MCP 无法读取本机路径'
    return `${binding.server} / ${binding.tool}；工具存在及 schema 在调用时校验`
  }
  return <>
    <SettingsGroup label="附件分析工具">
      <p className="px-5 py-4 text-sm text-muted-foreground">选择图片、视频和文档的分析服务。修改后新会话生效。</p>
      {(Object.keys(LABELS) as MediaCapability[]).map((kind) => <SettingsRow key={kind} searchId={SEARCH_IDS[kind]} title={LABELS[kind]}
        desc={bindings[kind] === undefined ? '未配置' : diagnostic(bindings[kind])}>
        <Button variant="outline" size="default" onClick={() => {
          const value = bindings[kind] ?? EMPTY
          setForm({ ...value }); setFormats(value.formats.join(', ')); setLimit(value.maxBytes === undefined ? '' : String(value.maxBytes / 1024 / 1024)); setError(undefined); setEditing(kind)
        }}>配置</Button>
      </SettingsRow>)}
      {error !== undefined && editing === undefined && <p className="px-5 py-4 text-sm text-destructive" role="alert">{error}</p>}
    </SettingsGroup>
    <Dialog open={editing !== undefined} onOpenChange={(open) => { if (!open) setEditing(undefined) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{editing === undefined ? '附件分析工具' : LABELS[editing]}</DialogTitle></DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <label className="flex flex-col gap-1">MCP 服务器
            <Select value={form.server} onValueChange={(server) => { if (server !== null) setForm({ ...form, server }) }}>
              <SelectTrigger><SelectValue placeholder="选择已安装的服务器" /></SelectTrigger>
              <SelectContent>{servers.map((s) => <SelectItem key={s.name} value={s.name}>{s.name}{s.type === 'http' ? '（远程，不兼容）' : ''}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          {([
            ['tool', '工具原名（不含 mcp__ 前缀）'], ['pathArgument', '本机路径参数名'],
            ['questionArgument', '问题参数名'], ['pagesArgument', '页码参数名（可选，字符串）']
          ] as const).map(([field, label]) => <label key={field} className="flex flex-col gap-1">{label}<Input value={form[field] ?? ''} onChange={(event) => {
            const next = { ...form, [field]: event.target.value }; if (field === 'pagesArgument' && event.target.value === '') delete next.pagesArgument; setForm(next)
          }} /></label>)}
          <label className="flex flex-col gap-1">支持格式（如 .mp4, .mov；空表示由服务判定）<Input value={formats} onChange={(event) => setFormats(event.target.value)} /></label>
          <label className="flex flex-col gap-1">单文件上限（MiB，留空表示未知）<Input inputMode="decimal" value={limit} onChange={(event) => setLimit(event.target.value)} /></label>
          {editing === 'video' && <label className="flex items-center justify-between">服务明确支持分析音轨<Switch checked={form.audio === true} onCheckedChange={(audio) => setForm({ ...form, audio })} /></label>}
          <p className="text-sm text-muted-foreground">服务必须能读取此 Host 的本机路径并返回分析文字。仅接受 URL 的工具不兼容；账号和费用使用该 MCP 服务自己的配置。认证、审批、格式和工具错误会在聊天工具记录中原样显示。</p>
          {error !== undefined && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>清除绑定</Button>
          <Button variant="outline" disabled={busy} onClick={() => setEditing(undefined)}>取消</Button>
          <Button disabled={busy} onClick={() => void save(false)}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
