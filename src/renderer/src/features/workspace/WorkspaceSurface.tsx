/* eslint-disable @typescript-eslint/no-unnecessary-condition -- 动态索引可能不存在；未开启 noUncheckedIndexedAccess，仍需运行期边界检查。 */
/** AppShell 常驻的唯一内容父节点；切会话、路由与布局只改变可见性。 */
import { useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react'
import { Button } from '@/components/ui/button'
import { SidebarResizeHandle } from '@/components/SidebarResizeHandle'
import { useWorkspaceStore, EMPTY_WORKSPACE, type WorkspaceTab } from '@/stores/workspace'
import { useFilePreviewStore } from '@/stores/file-preview'
import { FileWorkspacePane } from './FileWorkspacePane'
import { BrowserPane } from './BrowserPane'
import { WorkspaceTabs } from './WorkspaceTabs'
import { WorkspaceLauncher } from './WorkspaceLauncher'
import { WORKSPACE_COLLAPSE_WIDTH, WORKSPACE_DEFAULT_WIDTH, resizeWorkspace, workspaceWidth } from './layout'
import { acquireFile, releaseFile, restoreFileSource } from './file-client'
import { invalidateFileNavigators } from './file-navigator-owner'
import { useWorkspaceRuntime, registerTabClose, releaseHeldTab, closeWorkspaceTab, cycleWorkspaceTab } from './runtime'
import { WorkspaceAnimatingContext } from './motion'
import { clearLegacyWorkspaceCache } from './legacy-cache'
import type { BrowserState } from '@shared/browser'
const DiffPreview = lazy(() => import('@/features/home/files/DiffPreview'))

function BrowserOwnedPane({ tab, active }: { tab: Extract<WorkspaceTab, { kind: 'browser' }>; active: boolean }) {
  const [previewLeaseId, setPreviewLeaseId] = useState<string | undefined>()
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const initial = useRef(tab)
  const live = useRef(tab); live.current = tab
  const sourceRef = useRef(tab.previewSource)
  useEffect(() => window.cogent.onEngineEvent(event => {
    if (event.method !== 'files.invalidated' || live.current.previewSource === undefined) return
    const source = live.current.previewSource
    sourceRef.current = { ...source, scope: source.scope.contextId === undefined ? source.scope : { ...source.scope, contextId: 'restore' } }
    setPreviewError('文件服务已重启。网页仍保留；重新载入会清空当前表单。')
  }), [])
  useEffect(() => {
    const source = sourceRef.current
    if (source === undefined) return
    setPreviewError(null)
    let alive = true, leaseId: string | undefined
    void restoreFileSource(source, live.current.scopeId).then(async source => ({ source, lease: await acquireFile(source.scope, source.target, crypto.randomUUID(), source.outputTarget) })).then(({ source, lease }) => {
      leaseId = lease.leaseId
      if (alive) {
        const { relativeTo: _relativeTo, parentSource: _parent, refs: _refs, ...scope } = source.scope
        sourceRef.current = { scope: { ...scope, refs: [] }, target: lease.descriptor.path, outputTarget: lease.descriptor.delivery?.target }
        useWorkspaceStore.getState().updateBrowser(initial.current.id, { previewSource: sourceRef.current })
        setPreviewLeaseId(leaseId)
      }
      else void releaseFile(leaseId).catch(() => {})
    }, error => { if (alive) setPreviewError(String(error)) })
    return () => { alive = false; if (leaseId !== undefined) void releaseFile(leaseId).catch(() => {}) }
  }, [attempt])
  if (tab.previewSource !== undefined && previewLeaseId === undefined) return <div className="p-4 text-sm">{previewError === null ? <p>正在准备本地网页…</p> : <><p role="alert">{previewError}</p><Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重试本地网页</Button></>}</div>
  return <div className="flex h-full min-h-0 flex-col">
    {previewError !== null && <div role="alert" className="flex items-center gap-2 border-b border-border p-2 text-xs"><span className="min-w-0 flex-1">{previewError}</span><Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重新载入网页</Button></div>}
    <div className="min-h-0 flex-1"><BrowserPane scopeId={tab.scopeId} tabId={tab.id} url={initial.current.url} privateGroupId={tab.privateGroupId} initialHistory={initial.current.history} previewLeaseId={previewLeaseId} allowPreviewRoot={tab.previewSource !== undefined && tab.previewSource.outputTarget === undefined} active={active}
    onHistory={history => useWorkspaceStore.getState().updateBrowser(tab.id, { history })}
    onState={(state: BrowserState) => useWorkspaceStore.getState().updateBrowser(tab.id, { title: state.title || '浏览器', url: state.url, favicon: state.favicon, loading: state.loading, ...(state.url.startsWith('http') ? { previewSource: undefined } : {}) })}
    onRegisterClose={close => registerTabClose(tab.id, close)}
    onOpenUrl={url => useWorkspaceStore.getState().openBrowser(url, tab.privateGroupId, tab.scopeId)}
    onReleased={() => releaseHeldTab(tab.id)} /></div>
  </div>
}
function WorkspacePanel({ tab, active }: { tab: Extract<WorkspaceTab, { kind: 'start' | 'browser' | 'diff' }>; active: boolean }) {
  const [visited, setVisited] = useState(active)
  useEffect(() => { if (active) setVisited(true) }, [active])
  return <section id={'workspace-panel-' + tab.id} role="tabpanel" aria-labelledby={'workspace-tab-' + tab.id} hidden={!active} inert={!active} data-workspace-panel={tab.id} data-tab-kind={tab.kind} className="h-full min-h-0" style={{ display: active ? 'block' : 'none' }}>
    {(active || visited) && (
      tab.kind === 'start'
        ? (active ? <WorkspaceLauncher /> : null)
        : tab.kind === 'diff'
          ? <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在加载差异视图…</p>}><DiffPreview tab={tab} active={active} /></Suspense>
          : <BrowserOwnedPane tab={tab} active={active} />
    )}
  </section>
}
export function WorkspaceSurface({ contentWidth, visible }: { contentWidth: number; visible: boolean }) {
  const scopes = useWorkspaceStore(s => s.scopes)
  const scopeId = useWorkspaceStore(s => s.activeScopeId)
  const autoCollapsed = useWorkspaceStore(s => s.autoCollapsed)
  const held = useWorkspaceRuntime(s => s.held)
  const scope = scopes[scopeId] ?? EMPTY_WORKSPACE
  const [error, setError] = useState<string | null>(null)
  const showError = useRef((value: string) => setError(value)).current
  const root = useRef<HTMLElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const wasOpen = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  const isOpen = visible && !scope.collapsed && !autoCollapsed
  const [entered, setEntered] = useState(!isOpen)
  const [present, setPresent] = useState(isOpen)
  const [animating, setAnimating] = useState(false)
  const prevOpen = useRef(false)
  useLayoutEffect(() => {
    if (entered) return
    const frame = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(frame)
  }, [entered])
  useLayoutEffect(() => {
    if (isOpen && !prevOpen.current) {
      setAnimating(true)
      prevOpen.current = true
      const timer = window.setTimeout(() => setAnimating(false), 220)
      return () => window.clearTimeout(timer)
    }
    if (!isOpen) {
      prevOpen.current = false
      setAnimating(false)
    }
    return undefined
  }, [isOpen])
  useLayoutEffect(() => {
    if (isOpen) { setPresent(true); return }
    // 先完成裁剪收起，再隐藏查看器；内容保持原宽，不随动画逐帧换行。
    const timer = window.setTimeout(() => setPresent(false), 200)
    return () => window.clearTimeout(timer)
  }, [isOpen])
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !root.current?.contains(document.activeElement)) opener.current = document.activeElement
      // 聊天展开钮在工作区打开后卸载，主动把键盘焦点交给活动标签。
      root.current!.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({ preventScroll: true })
    }
    if (!isOpen && wasOpen.current && visible) {
      const frame = root.current?.closest('[data-workspace-frame]')
      const target = opener.current?.isConnected && opener.current.closest('[inert]') === null && opener.current.getClientRects().length > 0
        ? opener.current : frame?.querySelector<HTMLElement>('[aria-label="展开标签页区"]') ?? frame?.querySelector<HTMLElement>('textarea')
      target?.focus({ preventScroll: true })
    }
    wasOpen.current = isOpen
  }, [isOpen, visible])
  useEffect(() => {
    let stopped = false
    void clearLegacyWorkspaceCache().catch((error: unknown) => { if (!stopped) showError(String(error)) })
    const offEngine = window.cogent.onEngineEvent(event => {
      if (event.method !== 'files.invalidated') return
      useFilePreviewStore.getState().invalidate()
      useWorkspaceStore.setState(s => ({ scopes: Object.fromEntries(Object.entries(s.scopes).map(([id, scope]) => [id, {
        ...scope, tabs: scope.tabs.map(tab => tab.kind === 'file' && tab.source.scope.contextId !== undefined ? { ...tab, source: { ...tab.source, scope: { ...tab.source.scope, contextId: 'restore' } } } : tab)
      }])) }))
      void invalidateFileNavigators().catch(showError)
    })
    return () => { stopped = true; offEngine() }
  }, [])
  useEffect(() => {
    const command = (event: KeyboardEvent) => {
      if (!visible || event.defaultPrevented) return
      const target = event.target
      const focused = target instanceof Node && root.current?.contains(target)
      if (!focused) return
      const workspace = useWorkspaceStore.getState(), current = workspace.scopes[workspace.activeScopeId]
      if (event.key === 'Escape' && current?.expanded && !document.querySelector('[role=dialog][data-open], [role=alertdialog], [role=menu][data-open], [data-slot=popover-content][data-open], [role=listbox]')) {
        event.preventDefault(); workspace.setLayout({ collapsed: true }); return
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (event.key.toLowerCase() === 't') { event.preventDefault(); if (event.shiftKey) { const t = workspace.reopen(); if (t?.kind === 'file') void useFilePreviewStore.getState().loadTab(t.id) } else workspace.newTab() }
      else if (event.key.toLowerCase() === 'w' && current?.activeId != null) { event.preventDefault(); void closeWorkspaceTab(current.activeId).catch(showError) }
      else if (event.key === 'Tab') { event.preventDefault(); cycleWorkspaceTab(event.shiftKey ? -1 : 1) }
      else if (/^[1-9]$/.test(event.key) && current !== undefined) { event.preventDefault(); const tab = event.key === '9' ? current.tabs.at(-1) : current.tabs[Number(event.key) - 1]; if (tab !== undefined) workspace.activate(tab.id) }
    }
    window.addEventListener('keydown', command)
    const offBrowser = window.cogent.onBrowserEvent(event => {
      const owner = Object.values(useWorkspaceStore.getState().scopes).find(s => s.tabs.some(t => t.id === event.tabId))
      const current = useWorkspaceStore.getState()
      const tab = owner?.tabs.find(t => t.id === event.tabId)
      if (event.type === 'open' && tab !== undefined) {
        current.openBrowser(event.url, event.privateGroupId, tab.scopeId, event.background || !visible || current.activeScopeId !== tab.scopeId || owner?.collapsed === true)
      }
      if (event.type === 'shortcut' && tab !== undefined) {
        if (event.command === 'new') current.newTab(tab.scopeId)
        if (event.command === 'close') void closeWorkspaceTab(tab.id).catch(showError)
        if (event.command === 'reopen') { const restored = current.reopen(); if (restored?.kind === 'file') void useFilePreviewStore.getState().loadTab(restored.id) }
        if (event.command === 'next' || event.command === 'previous') cycleWorkspaceTab(event.command === 'next' ? 1 : -1)
      }
      if (event.type === 'released') releaseHeldTab(event.tabId)
    })
    return () => { window.removeEventListener('keydown', command); offBrowser() }
  }, [visible, showError])
  const width = entered ? workspaceWidth(contentWidth, scope.collapsed || autoCollapsed, scope.expanded, scope.width) : 0
  const contentSize = workspaceWidth(contentWidth, false, scope.expanded, scope.width)
  // 排序头与内容次序解耦，包括草稿迁移与 DownloadHold；React 始终复用同一 keyed 节点。
  const all = [...new Map([...Object.values(scopes).flatMap(s => s.tabs), ...Object.values(held)].map(tab => [tab.id, tab])).values()]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const show = visible && (isOpen || present)
  const activeTab = scope.tabs.find(tab => tab.id === scope.activeId)
  return <aside ref={root} aria-label="多标签工作区" aria-hidden={!isOpen} data-workspace data-home-tabs data-workspace-mode={scope.expanded ? 'expanded' : 'split'} inert={!isOpen} className="absolute inset-y-0 right-0 z-20 min-h-0 border-l border-border bg-background transition-[width] duration-200 ease-out motion-reduce:transition-none" style={{ width, visibility: show ? 'visible' : 'hidden', pointerEvents: isOpen ? 'auto' : 'none' }} onTransitionEnd={event => { if (event.target === root.current && event.propertyName === 'width') setAnimating(false) }}>
    {isOpen && !scope.expanded && <SidebarResizeHandle key={scopeId} side="right" label="调整工作区宽度" className="absolute inset-y-0 -left-px z-30" min={WORKSPACE_COLLAPSE_WIDTH} max={Math.max(WORKSPACE_COLLAPSE_WIDTH, contentWidth - 160)} collapseThreshold={WORKSPACE_COLLAPSE_WIDTH}
      readWidth={() => root.current!.getBoundingClientRect().width}
      writeWidth={px => {
        if (px === 0) {
          // 越过阈值先结束拖动态，再让裁剪窗从当前宽度动画收起。
          useWorkspaceStore.getState().setLayout({ width: root.current!.getBoundingClientRect().width, collapsed: true }, scopeId)
          return
        }
        root.current!.style.width = `${px}px`
        root.current!.parentElement!.querySelector<HTMLElement>('[data-workspace-chat]')!.style.paddingRight = `${px}px`
        content.current!.style.width = `${Math.max(0, px - 1)}px`
      }}
      onCommit={px => useWorkspaceStore.getState().setLayout(resizeWorkspace(contentWidth, px), scopeId)}
      onReset={() => useWorkspaceStore.getState().setLayout({ width: WORKSPACE_DEFAULT_WIDTH }, scopeId)} />}
    <div className="h-full overflow-hidden"><div ref={content} className="flex h-full min-h-0 flex-col" style={{ width: Math.max(0, contentSize - 1) }}>
    {show && <WorkspaceTabs tabs={scope.tabs} activeId={scope.activeId} expanded={scope.expanded} onError={showError} />}
    {error !== null && <div role="alert" className="flex items-center gap-2 border-b border-border p-2 text-xs"><span className="min-w-0 flex-1 break-words">{error}</span><Button variant="ghost" size="xs" onClick={() => setError(null)}>关闭</Button></div>}
    <div className="min-h-0 flex-1 overflow-hidden">
      <WorkspaceAnimatingContext.Provider value={animating}>
        <FileWorkspacePane tabs={all.filter(tab => tab.kind === 'file' || tab.kind === 'files')} scopeId={scopeId} projectId={scope.projectId} sessionId={scopeId.startsWith('draft:') ? undefined : scopeId} grantIds={scope.grantIds} active={show && (activeTab?.kind === 'file' || activeTab?.kind === 'files')} activeTabId={scope.activeId}
          onContextChange={({ grantIds }) => useWorkspaceStore.getState().setGrants(scopeId, grantIds)} />
      </WorkspaceAnimatingContext.Provider>
      {all.filter(tab => tab.kind === 'start' || tab.kind === 'browser' || tab.kind === 'diff').map(tab => <WorkspacePanel key={tab.id} tab={tab} active={show && tab.scopeId === scopeId && tab.id === scope.activeId && held[tab.id] === undefined} />)}
    </div>
    </div></div>
  </aside>
}
