/** 回合尾部正式交付区；只读 Host 发布清单，运行期间仅保留上次已发布卡。 */
import { useContext, useState } from 'react'
import { File, MoreHorizontal } from 'lucide-react'
import type { OutputItem, OutputTarget, TurnOutputs } from '@shared/outputs'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { FileLinkContext } from './FileLink'
import { useChatStore } from '@/stores/chat'
import { useFilePreviewStore } from '@/stores/file-preview'

function OutputCard({ doc, item }: { doc: TurnOutputs; item: OutputItem }) {
  const [error, setError] = useState<string | null>(null)
  const target: OutputTarget = { sessionId: doc.sessionId, turnId: doc.turnId, revision: doc.revision, outputId: item.outputId, version: 'delivery' }
  const saved = item.copy.status === 'saved'
  const open = (version: OutputTarget['version']) => void useFilePreviewStore.getState().open({ sessionId: doc.sessionId, turnId: doc.turnId, refs: [] }, item.sourcePath, { ...target, version })
  const action = async (action: 'open' | 'save' | 'reveal' | 'editor') => {
    setError(null)
    try {
      const descriptor = await window.cogent.engineRequest('outputs.resolve', { ...target, version: action === 'reveal' || action === 'editor' ? 'current' : 'delivery' })
      try { await window.cogent.fileAction({ sessionId: doc.sessionId, fileId: descriptor.fileId, action }) }
      finally { await window.cogent.engineRequest('files.cancel', { sessionId: doc.sessionId, operationId: crypto.randomUUID(), fileId: descriptor.fileId }) }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  const type = item.name.includes('.') ? item.name.split('.').at(-1)!.toUpperCase() : '文件'
  return <Card size="sm" data-output-card={item.outputId}>
    <CardHeader>
      <CardTitle className="flex min-w-0 items-center gap-2"><File className="size-4 shrink-0" /><span className="truncate" title={item.sourcePath}>{item.name}</span></CardTitle>
      <CardDescription>{type} · {item.size.toLocaleString()} 字节 · {saved ? '已保存交付副本' : '仅当前原文件，未保存交付副本'}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-2">
      {item.note !== undefined && <p className="text-sm break-words">{item.note}</p>}
      {!saved && <p className="text-xs text-muted-foreground">{item.copy.status === 'source-only' && item.copy.reason}</p>}
      {item.warning !== undefined && <p role="status" className="text-xs">{item.warning}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => open('delivery')}>{saved ? '预览交付副本' : '查看当前原文件'}</Button>
        <Button size="sm" variant="ghost" onClick={() => void action('save')}>另存为</Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`${item.name} 操作`} />}><MoreHorizontal /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void action('open')}>{saved ? '系统打开交付副本' : '系统打开当前原文件'}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => open('current')}>预览当前原文件</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void action('reveal')}>在原目录定位</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void action('editor')}>编辑当前原文件</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(item.sourcePath).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))}>复制原文件路径</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error !== null && <p role="alert" className="text-sm break-words">{error}</p>}
    </CardContent>
  </Card>
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
  return <section className="flex min-w-0 flex-col gap-3" aria-label="产物文件" data-output-cards data-output-state={doc.state}>
    <div className="flex flex-wrap items-center gap-2 text-sm"><span>交付文件 · {doc.published.length}</span>{updating && <Badge variant="secondary">{doc.state === 'finalizing' ? '正在保存产物' : '更新中'}</Badge>}{!updating && doc.outcome === 'aborted' && <Badge variant="outline">回合已停止</Badge>}{!updating && doc.outcome === 'error' && <Badge variant="outline">回合失败，保留已确认文件</Badge>}</div>
    {doc.warning !== undefined && <p role="status" className="text-xs">{doc.warning}</p>}
    {error !== undefined && <p role="alert" className="text-sm">产物保存失败：{error}</p>}
    {items.map((item) => <OutputCard key={item.outputId} doc={doc} item={item} />)}
    {doc.published.length > 3 && <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>{expanded ? '收起文件' : `展开其余 ${doc.published.length - 3} 个文件`}</Button>}
  </section>
}
