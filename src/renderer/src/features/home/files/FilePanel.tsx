/** 共用当前文件面板；宽窗用既有右栏，窄窗的 Dialog 容器由 HomeMain 决定。 */
import { lazy, Suspense, useMemo, useState } from 'react'
import {
  File,
  Image,
  FileText,
  FileSpreadsheet,
  Music,
  Video,
  Folder,
  MoreHorizontal,
  X
} from 'lucide-react'
import type { FileAction, FileKind } from '@shared/files'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { Markdown } from '@/components/ui/markdown'
import { FileLinkContext } from './FileLink'
import { useFilePreviewStore, type Preview } from '@/stores/file-preview'
const TextPreview = lazy(() => import('./TextPreview'))
const PdfPreview = lazy(() => import('./PdfPreview'))
const ICONS = {
  text: FileText,
  markdown: FileText,
  image: Image,
  office: FileSpreadsheet,
  audio: Music,
  video: Video,
  directory: Folder,
  pdf: FileText,
  other: File
} satisfies Record<FileKind, typeof File>

function ImagePreview({ url, name }: { url: string; name: string }) {
  const [zoom, setZoom] = useState<number | null>(null)
  const [error, setError] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap gap-2 p-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setZoom(Math.max(0.1, (zoom ?? 1) - 0.25))}
        >
          缩小
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(null)}>
          适配
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(1)}>
          原图
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(Math.min(4, (zoom ?? 1) + 0.25))}>
          放大
        </Button>
      </div>
      {error && (
        <p role="alert" className="p-3 text-sm">
          图片解码失败，请用系统打开
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <img
          src={url}
          alt={name}
          onError={() => setError(true)}
          style={
            zoom === null
              ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
              : { maxWidth: 'none', zoom }
          }
        />
      </div>
    </div>
  )
}
function OfficePreview({ preview }: { preview: Preview }) {
  const [sheet, setSheet] = useState('')
  const [range, setRange] = useState('')
  const [cursors, setCursors] = useState([0])
  const document = preview.document!
  const load = (cursor: number) =>
    void useFilePreviewStore
      .getState()
      .documentPage(cursor, sheet === '' ? undefined : sheet, range === '' ? undefined : range)
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <p className="text-xs">内容预览 · {document.source}；原生版式请用系统打开。</p>
      {document.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      {preview.descriptor!.name.toLowerCase().endsWith('.xlsx') && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setCursors([0])
            load(0)
          }}
        >
          <Input
            aria-label="工作表"
            placeholder="工作表名称"
            value={sheet}
            onChange={(event) => setSheet(event.target.value)}
          />
          <Input
            aria-label="单元格范围"
            placeholder="A1:D20（可选）"
            value={range}
            onChange={(event) => setRange(event.target.value)}
          />
          <Button size="sm" disabled={preview.loading}>
            读取工作表
          </Button>
        </form>
      )}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={cursors.length <= 1 || preview.loading}
          onClick={() => {
            const next = cursors.slice(0, -1)
            setCursors(next)
            load(next.at(-1)!)
          }}
        >
          上一段
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={document.nextCursor === undefined || preview.loading}
          onClick={() => {
            setCursors([...cursors, document.nextCursor!])
            load(document.nextCursor!)
          }}
        >
          下一段
        </Button>
      </div>
      <pre className="code-typography min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono">
        {document.text}
      </pre>
    </div>
  )
}
function MediaPreview({ url, kind, name }: { url: string; kind: 'audio' | 'video'; name: string }) {
  const [error, setError] = useState(false)
  return (
    <div className="h-full overflow-auto p-3">
      {kind === 'audio' ? (
        <audio
          controls
          src={url}
          aria-label={name}
          className="w-full"
          onError={() => setError(true)}
        />
      ) : (
        <video
          controls
          src={url}
          aria-label={name}
          className="max-h-full w-full"
          onError={() => setError(true)}
        />
      )}
      {error && (
        <p role="alert" className="text-sm">
          该媒体格式或编码无法解码，请用系统打开。
        </p>
      )}
    </div>
  )
}
function FileContent({ preview }: { preview: Preview }) {
  const file = preview.descriptor!
  const markdownScope = useMemo(
    () => ({ ...preview.scope, refs: [], relativeTo: file.fileId, preview: true }),
    [preview.scope, file.fileId]
  )
  if (preview.text !== null) {
    const source = <TextPreview text={preview.text} name={file.name} location={file.location} />
    if (file.kind !== 'markdown') return source
    return (
      <Tabs
        defaultValue={file.location === undefined ? 'render' : 'source'}
        className="h-full min-h-0"
      >
        <TabsList className="mx-3 mt-2">
          <TabsTrigger value="render">预览</TabsTrigger>
          <TabsTrigger value="source">源码</TabsTrigger>
        </TabsList>
        <TabsContent value="render" className="min-h-0 flex-1 overflow-auto p-3">
          <FileLinkContext.Provider value={markdownScope}>
            <Markdown content={preview.text} />
          </FileLinkContext.Provider>
        </TabsContent>
        <TabsContent value="source" className="min-h-0 flex-1">
          {source}
        </TabsContent>
      </Tabs>
    )
  }
  if (preview.url !== null) {
    if (file.kind === 'image') return <ImagePreview url={preview.url} name={file.name} />
    if (file.kind === 'pdf') return <PdfPreview url={preview.url} />
    if (file.kind === 'audio' || file.kind === 'video')
      return <MediaPreview key={preview.url} url={preview.url} kind={file.kind} name={file.name} />
  }
  if (preview.document !== null) return <OfficePreview preview={preview} />
  return (
    <p className="p-4 text-sm text-muted-foreground">
      {file.kind === 'directory'
        ? '目录可在文件管理器中打开。'
        : '此类型没有内嵌预览，请使用系统打开。'}
    </p>
  )
}
export function FilePanel() {
  const preview = useFilePreviewStore((state) => state.current)!
  const [actionError, setActionError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const file = preview.descriptor
  const Icon = ICONS[file?.kind ?? 'other']
  const action = async (action: FileAction) => {
    setActionError(null)
    setStatus(null)
    try {
      const target = file!.delivery !== undefined && (action === 'reveal' || action === 'editor')
        ? await window.cogent.engineRequest('outputs.resolve', { ...file!.delivery.target, version: 'current' }) : file!
      await window.cogent.fileAction({
        sessionId: preview.scope.sessionId,
        fileId: target.fileId,
        action,
        location: file!.location
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file!.path)
      setStatus('已复制路径')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col" aria-label="文件预览" data-file-preview>
      <header className="flex shrink-0 items-center gap-2 p-3">
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm" title={file?.path ?? preview.rawTarget}>
          {file?.name ?? preview.rawTarget}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void useFilePreviewStore.getState().open(preview.scope, preview.rawTarget, preview.outputTarget)}
        >
          重新加载
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="文件操作"
                disabled={file === null}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void copy()}>复制原文件路径</DropdownMenuItem>
            {file?.delivery !== undefined && <DropdownMenuItem onClick={() => void useFilePreviewStore.getState().open(preview.scope, preview.rawTarget, { ...file.delivery!.target, version: 'current' })}>预览当前原文件</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => void action('reveal')}>
              {file?.delivery !== undefined ? '在原目录定位' : '在文件管理器中定位'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void action('open')}>系统打开</DropdownMenuItem>
            <DropdownMenuItem
              disabled={file?.kind === 'directory'}
              onClick={() => void action('save')}
            >
              另存为
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void action('editor')}>{file?.delivery !== undefined ? '编辑当前原文件' : '编辑器打开'}</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void window.cogent
                  .configureFileEditor()
                  .catch((error: unknown) =>
                    setActionError(error instanceof Error ? error.message : String(error))
                  )
              }}
            >
              配置编辑器…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭文件预览"
          onClick={() => useFilePreviewStore.getState().close()}
        >
          <X />
        </Button>
      </header>
      {file !== null && (
        <div className="shrink-0 px-3 pb-2 text-xs text-muted-foreground">
          <p className="break-all">{file.path}</p>
          <p>
            {file.kind} · {file.size.toLocaleString()} 字节 · {file.delivery === undefined ? '当前文件' : '交付副本'}
            {preview.encoding === null ? '' : ' · ' + preview.encoding}
          </p>
          {file.delivery !== undefined && <p>确认时间：{new Date(file.delivery.confirmedAt).toLocaleString()}；预览与另存使用已保存字节。</p>}
          {file.source === 'current-workspace' && <p>使用当前工作区（此消息未保存历史来源）</p>}
          {file.locationWarning !== undefined && <p>{file.locationWarning}</p>}
        </div>
      )}
      {status !== null && (
        <p role="status" className="px-3 text-xs">
          {status}
        </p>
      )}
      {(preview.error !== null || actionError !== null) && (
        <p role="alert" className="break-words p-3 text-sm">
          {actionError ?? preview.error}
        </p>
      )}
      {preview.loading && (
        <p role="status" className="p-3 text-sm">
          正在读取当前文件…
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<p className="p-3 text-sm">正在加载查看器…</p>}>
          {file !== null &&
            (!preview.loading || preview.document !== null) &&
            preview.error === null && <FileContent key={file.fileId} preview={preview} />}
        </Suspense>
      </div>
    </aside>
  )
}
