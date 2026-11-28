/* eslint-disable @typescript-eslint/no-unnecessary-condition -- byTab/views 为稀疏动态索引，tsconfig 未启用 noUncheckedIndexedAccess。 */
/** 每个文件标签显式消费自己的预览和查看状态；容器显隐不再拥有全局单槽。 */
import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { WorkspaceAnimatingContext } from '@/features/workspace/motion'
import { File, Image, FileText, FileSpreadsheet, FileX, Music, Video, Folder, ChevronDown, Globe, ExternalLink, X } from 'lucide-react'
import type { FileAction, FileKind } from '@shared/files'
import { formatFileSystemError } from '@shared/file-errors'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Hint } from '@/components/Hint'
import { cn } from 'cn'
import { useHoverSlide } from '@/hooks/use-hover-slide'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FileLinkContext } from './FileLink'
import { useFilePreviewStore, type Preview } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'
import ImagePreview from './visual/ImagePreview'
import SvgPreview from './visual/SvgPreview'
const TextPreview = lazy(() => import('./TextPreview'))
const PdfPreview = lazy(() => import('./PdfPreview'))
const OfficePreview = lazy(() => import('./visual/OfficePreview'))
const DocumentMarkdown = lazy(() => import('./visual/DocumentMarkdown'))
const ICONS = { text: FileText, markdown: FileText, image: Image, office: FileSpreadsheet, audio: Music, video: Video, directory: Folder, pdf: FileText, other: File } satisfies Record<FileKind, typeof File>

function useFileScroll(tabId: string, active: boolean, renderedMarkdown = false) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (element === null || !active) return
    const saved = useFilePreviewStore.getState().views[tabId]
    element.scrollTop = (renderedMarkdown ? saved?.renderScrollTop : saved?.scrollTop) ?? 0
    element.scrollLeft = (renderedMarkdown ? saved?.renderScrollLeft : saved?.scrollLeft) ?? 0
  }, [tabId, active, renderedMarkdown])
  const onScroll = (): void => {
    const element = ref.current!
    if (!active) return
    useFilePreviewStore.getState().setView(tabId, renderedMarkdown
      ? { renderScrollTop: element.scrollTop, renderScrollLeft: element.scrollLeft }
      : { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft })
  }
  return { ref, onScroll }
}

function MediaPreview({ preview, active }: { preview: Preview; active: boolean }) {
  const media = useRef<HTMLMediaElement | null>(null)
  const [error, setError] = useState(false)
  const time = (): void => {
    const element = media.current
    if (element !== null && Number.isFinite(element.currentTime)) useFilePreviewStore.getState().setView(preview.tabId, { mediaTime: element.currentTime }, preview.generation)
  }
  useEffect(() => {
    if (!active) { media.current!.pause(); time() }
  }, [active])
  useEffect(() => {
    const element = media.current!
    const flush = (): void => {
      if (Number.isFinite(element.currentTime)) useFilePreviewStore.getState().setView(preview.tabId, { mediaTime: element.currentTime }, preview.generation)
    }
    window.addEventListener('workspace:save-view-state', flush)
    return () => { flush(); window.removeEventListener('workspace:save-view-state', flush); element.pause() }
  }, [])
  const restoreTime = (): void => {
    const element = media.current!
    const savedTime = useFilePreviewStore.getState().views[preview.tabId]?.mediaTime ?? 0
    if (savedTime > 0) element.currentTime = Number.isFinite(element.duration) ? Math.min(savedTime, element.duration) : savedTime
    if (!active) element.pause()
  }
  const common = {
    controls: true, src: preview.url!, 'aria-label': preview.descriptor!.name,
    onError: () => setError(true), onTimeUpdate: time, onPause: time,
    onLoadedMetadata: restoreTime, ref: (element: HTMLMediaElement | null) => { media.current = element }
  }
  return <div className="h-full overflow-auto p-3">
    {preview.descriptor!.kind === 'audio' ? <audio {...common} className="w-full" /> : <video {...common} className="max-h-full w-full" />}
    {error && <p role="alert" className="text-sm">该媒体格式或编码无法解码，请用系统打开。</p>}
  </div>
}

function FileContent({ preview, active }: { preview: Preview; active: boolean }) {
  const file = preview.descriptor!
  const saved = useFilePreviewStore((state) => state.views[preview.tabId])
  const workspaceScopeId = useWorkspaceStore((state) => Object.entries(state.scopes).find(([, scope]) => scope.tabs.some((tab) => tab.id === preview.tabId))?.[0])
  const openDocumentUrl = useCallback((url: string) => { useWorkspaceStore.getState().openBrowser(url, undefined, workspaceScopeId) }, [workspaceScopeId])
  const saveImage = useCallback(() => window.cogent.fileViewsRequest('fileViews.action', { leaseId: preview.leaseId!, action: 'save' }), [preview.leaseId])
  const mode = saved?.markdownMode ?? (file.location === undefined ? 'render' : 'source')
  const markdownScope = useMemo(() => {
    const { relativeTo: _relativeTo, parentSource: _parent, refs: _refs, ...origin } = preview.scope
    const parentSource = { scope: { ...origin, refs: [], workspaceScopeId }, target: file.path, outputTarget: preview.outputTarget }
    return { ...preview.scope, workspaceScopeId, refs: [], relativeTo: preview.leaseId!, parentSource, preview: true }
  }, [preview.scope, preview.leaseId, preview.outputTarget, file.path, workspaceScopeId])
  const scroll = useFileScroll(preview.tabId, active && mode === 'render', true)
  if (preview.text !== null) {
    if (/\.svg$/i.test(file.name)) return <SvgPreview text={preview.text} name={file.name} location={file.location} tabId={preview.tabId} active={active} onSave={saveImage} />
    const source = <TextPreview text={preview.text} name={file.name} location={file.location} tabId={preview.tabId} active={active && (file.kind !== 'markdown' || mode === 'source')} />
    if (file.kind !== 'markdown') return source
    return <Tabs value={mode} onValueChange={(value: unknown) => { if (value === 'render' || value === 'source') useFilePreviewStore.getState().setView(preview.tabId, { markdownMode: value }) }} className="h-full min-h-0">
      <TabsList className="mx-3 mt-2"><TabsTrigger value="render">预览</TabsTrigger><TabsTrigger value="source">源码</TabsTrigger></TabsList>
      <TabsContent value="render" keepMounted {...scroll} className="min-h-0 flex-1 overflow-auto p-3"><FileLinkContext.Provider value={markdownScope}><DocumentMarkdown content={preview.text} /></FileLinkContext.Provider></TabsContent>
      <TabsContent value="source" keepMounted className="min-h-0 flex-1">{source}</TabsContent>
    </Tabs>
  }
  if (preview.url !== null) {
    if (file.kind === 'image') return <ImagePreview url={preview.url} name={file.name} tabId={preview.tabId} active={active} onSave={saveImage} />
    if (file.kind === 'pdf') return <PdfPreview url={preview.url} tabId={preview.tabId} active={active} />
    if (file.kind === 'audio' || file.kind === 'video') return <MediaPreview preview={preview} active={active} />
    if (file.kind === 'office') return <OfficePreview url={preview.url} name={file.name} tabId={preview.tabId} active={active} onOpenUrl={openDocumentUrl} />
  }
  return <p className="p-4 text-sm text-muted-foreground">{file.kind === 'directory' ? '目录可在文件管理器中打开。' : '此类型没有内嵌预览，请使用系统打开。'}</p>
}

/** 组合文件工作面与独立查看器共用动作；导航不持有或改写文件租约。 */
export function FileToolbar({ tabId, active, leading, label, showClose = false, onChooseFile, choosingFile = false }: {
  tabId: string | null
  active: boolean
  leading?: ReactNode
  label?: ReactNode
  showClose?: boolean
  onChooseFile?: () => void
  choosingFile?: boolean
}) {
  const preview = useFilePreviewStore((state) => tabId === null ? undefined : state.byTab[tabId])
  const [actionError, setActionError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  // 「打开 + 文件操作」按钮组两钮之间的悬停滑动（同差异视图切换）
  const openSlide = useHoverSlide()
  const file = preview?.descriptor ?? null
  const canAct = file !== null && preview?.leaseId != null
  const Icon = ICONS[file?.kind ?? 'other']
  const action = async (action: FileAction): Promise<void> => {
    setActionError(null); setStatus(null)
    try {
      await window.cogent.fileViewsRequest('fileViews.action', { leaseId: preview!.leaseId!, action, location: file!.location })
    } catch (error) { setActionError(formatFileSystemError(error, 'file')) }
  }
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(file!.delivery?.sourcePath ?? file!.path); setStatus('已复制路径') }
    catch (error) { setActionError(formatFileSystemError(error, 'file')) }
  }
  const html = file !== null && /\.html?$/i.test(file.name)
  const openHtml = (): void => {
    // 成功解析后使用当前 HTML 自身的来源，父 Markdown 标签可能早已关闭并归还租约。
    const { relativeTo: _relativeTo, parentSource: _parent, refs: _refs, ...origin } = preview!.scope
    const workspace = useWorkspaceStore.getState()
    const scopeId = Object.entries(workspace.scopes).find(([, scope]) => scope.tabs.some(tab => tab.id === tabId))![0]
    workspace.openPreview({ scope: { ...origin, refs: [], workspaceScopeId: scopeId }, target: file!.path, outputTarget: file!.delivery?.target })
  }
  return <>
    <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2" data-file-toolbar>
      {leading}
      <div className="min-w-0 flex-1">{label ?? <span className="flex min-w-0 items-center gap-2 text-sm"><Icon className="size-4 shrink-0" /><Hint tip={<span className="break-all">{file?.path ?? preview?.rawTarget ?? '文件'}</span>}><span className="truncate">{file?.name ?? preview?.rawTarget ?? '文件'}</span></Hint></span>}</div>
      {html && <Hint tip="网页预览"><Button variant="ghost" size="icon-sm" aria-label="网页预览" onClick={openHtml}><Globe /></Button></Hint>}
      {(tabId !== null || onChooseFile !== undefined) && <ButtonGroup ref={openSlide.containerRef} aria-label="文件打开操作" className={cn(openSlide.containerClassName, 'shrink-0')}>
        {openSlide.pill}
        {tabId === null
          ? <Hint tip="打开本地文件"><Button variant="outline" size="sm" data-hover-slide aria-label="打开文件" disabled={choosingFile} onClick={onChooseFile}>打开</Button></Hint>
          : <Hint tip="用系统应用打开"><Button variant="outline" size="sm" data-hover-slide aria-label="系统打开" disabled={file === null || preview?.leaseId == null} onClick={() => void action('open')}><ExternalLink />打开</Button></Hint>}
        <DropdownMenu open={active && menuOpen} onOpenChange={setMenuOpen}>
          <Hint tip="文件操作"><DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" data-hover-slide aria-label="文件操作" disabled={tabId !== null && onChooseFile === undefined && (file === null || preview?.leaseId == null)} />}><ChevronDown /></DropdownMenuTrigger></Hint>
          <DropdownMenuContent align="end">
            {onChooseFile !== undefined && <DropdownMenuItem disabled={choosingFile} onClick={onChooseFile}>打开本地文件…</DropdownMenuItem>}
            {onChooseFile !== undefined && tabId !== null && <DropdownMenuSeparator />}
            {tabId !== null && <>
              <DropdownMenuItem disabled={preview?.loading} onClick={() => void useFilePreviewStore.getState().loadTab(tabId, true)}>重新加载</DropdownMenuItem>
              <DropdownMenuItem disabled={file === null} onClick={() => setInfoOpen(true)}>文件信息</DropdownMenuItem>
              <DropdownMenuItem disabled={file === null} onClick={() => void copy()}>复制原文件路径</DropdownMenuItem>
              {file?.delivery !== undefined && <DropdownMenuItem onClick={() => void useFilePreviewStore.getState().open(preview!.scope, preview!.rawTarget, { ...file.delivery!.target, version: 'current' })}>预览当前原文件</DropdownMenuItem>}
              <DropdownMenuItem disabled={!canAct} onClick={() => void action('reveal')}>{file?.delivery === undefined ? '在文件管理器中定位' : '在原目录定位'}</DropdownMenuItem>
              <DropdownMenuItem disabled={!canAct} onClick={() => void action('open')}>系统打开</DropdownMenuItem>
              <DropdownMenuItem disabled={!canAct || file?.kind === 'directory'} onClick={() => void action('save')}>另存为</DropdownMenuItem>
              <DropdownMenuItem disabled={!canAct} onClick={() => void action('editor')}>{file?.delivery === undefined ? '编辑器打开' : '编辑当前原文件'}</DropdownMenuItem>
            </>}
            <DropdownMenuItem onClick={() => { void window.cogent.configureFileEditor().catch((error: unknown) => setActionError(formatFileSystemError(error, 'file'))) }}>配置编辑器…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>}
      {tabId !== null && showClose && <Hint tip="关闭文件预览"><Button variant="ghost" size="icon-sm" aria-label="关闭文件预览" onClick={() => useFilePreviewStore.getState().close(tabId)}><X /></Button></Hint>}
    </header>
    {status !== null && <p role="status" className="px-3 text-xs">{status}</p>}
    {actionError !== null && <p role="alert" className="break-words p-3 text-sm">{actionError}</p>}
    <Dialog open={active && infoOpen && file !== null} onOpenChange={setInfoOpen}>
      <DialogContent><DialogHeader><DialogTitle>文件信息</DialogTitle><DialogDescription>{file?.name}</DialogDescription></DialogHeader>
      {file !== null && <div className="grid gap-2 text-sm">
      <p className="break-all">{file.path}</p>
      <p>{file.kind} · {file.size.toLocaleString()} 字节 · {file.delivery === undefined ? '当前文件' : '交付副本'}{preview!.encoding === null ? '' : ' · ' + preview!.encoding}</p>
      {file.delivery !== undefined && <p>确认时间：{new Date(file.delivery.confirmedAt).toLocaleString()}；预览与另存使用已保存字节。</p>}
      {file.source === 'current-workspace' && <p>{preview!.scope.contextId === undefined ? '使用当前工作区（此消息未保存历史来源）' : '本地文件 · 来自已授权目录'}</p>}
      {file.locationWarning !== undefined && <p>{file.locationWarning}</p>}
      </div>}
      </DialogContent>
    </Dialog>
  </>
}

export function FilePanel({ tabId, active, showHeader = true }: { tabId: string; active: boolean; showHeader?: boolean }) {
  const preview = useFilePreviewStore((state) => state.byTab[tabId])
  const animating = useContext(WorkspaceAnimatingContext)
  const [renderedOnce, setRenderedOnce] = useState(false)
  useEffect(() => {
    if (active && (preview === undefined || preview.evicted)) void useFilePreviewStore.getState().loadTab(tabId)
  }, [tabId, active, preview?.evicted])
  const readyToRender = preview !== undefined && preview.descriptor !== null && !preview.evicted && (!preview.loading || preview.document !== null) && preview.error === null
  const showContent = readyToRender && (renderedOnce || !animating)
  useEffect(() => {
    if (showContent && !renderedOnce) setRenderedOnce(true)
  }, [showContent, renderedOnce])
  if (preview === undefined) return <div className="p-3 text-sm" role="status">正在准备文件…</div>
  const file = preview.descriptor
  return <aside className="flex h-full min-h-0 min-w-0 flex-col" aria-label="文件预览" data-file-preview data-file-tab-id={tabId} data-file-delivery={file?.delivery === undefined ? 'current' : 'saved'}>
    {showHeader && <FileToolbar tabId={tabId} active={active} />}
    {preview.error !== null && (
      <Empty role="alert" className="p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileX aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="break-words">{preview.error}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={() => void useFilePreviewStore.getState().loadTab(tabId, true)}>重新加载</Button>
        </EmptyContent>
      </Empty>
    )}
    {preview.loading && <p role="status" className="p-3 text-sm">正在读取当前文件…</p>}
    {preview.evicted && !preview.loading && <div className="p-3 text-sm"><p>预览内容已回收，阅读位置仍保留。</p><Button variant="ghost" size="sm" onClick={() => void useFilePreviewStore.getState().loadTab(tabId)}>恢复预览</Button></div>}
    {preview.error === null && <div className="min-h-0 flex-1 overflow-hidden"><Suspense fallback={<p className="p-3 text-sm">正在加载查看器…</p>}>
      {showContent && <FileContent key={preview.generation} preview={preview} active={active} />}
    </Suspense></div>}
  </aside>
}
