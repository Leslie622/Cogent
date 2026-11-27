/** 回合尾部正式交付区；只读 Host 发布清单，运行期间仅保留上次已发布卡。 */
import { useContext, useState } from 'react'
import { AppWindow, ChevronDown, Copy, Download, Eye, FolderOpen, Pencil } from 'lucide-react'
import type { OutputItem, OutputTarget, TurnOutputs } from '@shared/outputs'
import { formatFileSystemError } from '@shared/file-errors'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Badge } from '@/components/ui/badge'
import { FileIcon } from '@/components/FileIcon'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { FileLinkContext } from './FileLink'
import { useChatStore } from '@/stores/chat'
import { useFilePreviewStore } from '@/stores/file-preview'
import { FileActionErrorDialog } from './FileActionErrorDialog'
import { acquireFile, releaseFile } from '@/features/workspace/file-client'

function OutputCard({ doc, item }: { doc: TurnOutputs; item: OutputItem }) {
  const [error, setError] = useState<string | null>(null)
  const target: OutputTarget = { sessionId: doc.sessionId, turnId: doc.turnId, revision: doc.revision, outputId: item.outputId, version: 'delivery' }
  const saved = item.copy.status === 'saved'
  const open = (version: OutputTarget['version']) => void useFilePreviewStore.getState().open({ sessionId: doc.sessionId, turnId: doc.turnId, refs: [] }, item.sourcePath, { ...target, version })
  const action = async (action: 'open' | 'save' | 'reveal' | 'editor') => {
    setError(null)
    try {
      const lease = await acquireFile({ sessionId: doc.sessionId, refs: [] }, item.sourcePath, crypto.randomUUID(), { ...target, version: action === 'reveal' || action === 'editor' ? 'current' : 'delivery' })
      try { await window.cogent.fileViewsRequest('fileViews.action', { leaseId: lease.leaseId, action }) }
      finally { await releaseFile(lease.leaseId) }
    } catch (error) { setError(formatFileSystemError(error, 'file')) }
  }
  const type = item.name.includes('.') ? item.name.split('.').at(-1)!.toUpperCase() : '文件'
  return <>
    <Card size="sm" className="rounded-lg py-2" data-output-card={item.outputId}>
      <CardContent className="flex flex-col gap-1 px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon path={item.name} className="size-5 shrink-0" />
          <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <p className="min-w-0 truncate" title={item.sourcePath}>{item.name}</p>
            <p className="shrink-0 text-xs text-muted-foreground">{type}</p>
          </div>
          <ButtonGroup className="shrink-0" aria-label={`${item.name} 操作`}>
            <Button size="sm" variant="outline" aria-label={`打开 ${item.name}`} title={saved ? '预览交付副本' : '查看当前原文件'} onClick={() => open('delivery')}>打开</Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-sm" variant="outline" aria-label={`${item.name} 更多操作`} />}><ChevronDown /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onClick={() => void action('open')}><AppWindow />{saved ? '系统打开交付副本' : '系统打开当前原文件'}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void action('save')}><Download />另存为…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => open('current')}><Eye />预览当前原文件</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void action('editor')}><Pencil />编辑当前原文件</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void action('reveal')}><FolderOpen />在原目录定位</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(item.sourcePath).catch((error: unknown) => setError(formatFileSystemError(error, 'file')))}><Copy />复制原文件路径</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>
        {item.copy.status === 'source-only' && <p role="status" className="text-xs text-muted-foreground">仅当前原文件，未保存交付副本：{item.copy.reason}</p>}
        {item.warning !== undefined && <p role="status" className="text-xs">{item.warning}</p>}
      </CardContent>
    </Card>
    <FileActionErrorDialog file={item.name} error={error} onClose={() => setError(null)} />
  </>
}

export function OutputCards() {
  const scope = useContext(FileLinkContext)
  const doc = useChatStore((state) => scope?.turnId === undefined ? undefined : state.bySession[scope.sessionId]?.outputs[scope.turnId])
  const error = useChatStore((state) => scope?.turnId === undefined ? undefined : state.bySession[scope.sessionId]?.outputErrors[scope.turnId])
  const [expanded, setExpanded] = useState(false)
  if (doc === undefined || doc.published.length === 0) {
    if (error !== undefined) return <p role="alert">产物保存失败：{error}</p>
    return doc?.state === 'finalizing' ? <p role="status" className="text-sm">正在保存产物…</p> : null
  }
  const updating = doc.state === 'running' || doc.state === 'finalizing'
  const items = expanded ? doc.published : doc.published.slice(0, 3)
  return <section className="flex min-w-0 flex-col gap-2" aria-label="产物文件" data-output-cards data-output-state={doc.state}>
    {(updating || doc.outcome === 'aborted' || doc.outcome === 'error') && <div className="flex flex-wrap items-center gap-2 text-sm">{updating && <Badge variant="secondary">{doc.state === 'finalizing' ? '正在保存产物' : '更新中'}</Badge>}{!updating && doc.outcome === 'aborted' && <Badge variant="outline">回合已停止</Badge>}{!updating && doc.outcome === 'error' && <Badge variant="outline">回合失败，保留已确认文件</Badge>}</div>}
    {doc.warning !== undefined && <p role="status" className="text-xs">{doc.warning}</p>}
    {error !== undefined && <p role="alert" className="text-sm">产物保存失败：{error}</p>}
    {items.map((item) => <OutputCard key={item.outputId} doc={doc} item={item} />)}
    {doc.published.length > 3 && <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>{expanded ? '收起文件' : `展开其余 ${doc.published.length - 3} 个文件`}</Button>}
  </section>
}
