/* eslint-disable @typescript-eslint/no-unnecessary-condition -- 动态索引可能不存在；未开启 noUncheckedIndexedAccess，仍需运行期边界检查。 */
/** AppShell 常驻的唯一内容父节点；面板 portal 到静止主卡，避开侧栏动画中移动的 Frame 绘制原点。
 *  切会话、路由与布局只改变可见性，不搬动查看器父树。
 *  面板宽度不在本组件：WorkspaceFrame 按状态写入，拖拽时这里直写（面板与应用头部中块/右块经
 *  shell-panes.ts，对话留位写 padding-right）。标签头因此 portal
 *  进头部，React 归属仍在本组件 —— 开合寿命、错误上报、焦点交接都留在这里。 */
import { memo, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { SidebarResizeHandle } from '@/components/SidebarResizeHandle'
import { useWorkspaceStore, EMPTY_WORKSPACE, type WorkspaceTab } from '@/stores/workspace'
import { useFilePreviewStore } from '@/stores/file-preview'
import { WORKSPACE_PANE, useShellPane, writeShellPane } from '@/features/shell/shell-panes'
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
export const WorkspaceSurface = memo(function WorkspaceSurface({ contentWidth, visible, tabsHeader, chat, workspaceHost }: {
  contentWidth: RefObject<number>
  visible: boolean
  workspaceHost: HTMLElement
  /** 对话留位（WorkspaceFrame 的子节点）：拖拽时与面板同步写 padding-right */
  chat: RefObject<HTMLDivElement | null>
  /** 应用头部标签页区块的内层裁剪窗：标签头 portal 进去，与本面板同一宽度、同一开合 */
  tabsHeader: RefObject<HTMLDivElement | null>
}) {
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
  const [present, setPresent] = useState(isOpen)
  const [animating, setAnimating] = useState(false)
  const prevOpen = useRef(false)
  // 头部标签页区块在应用头部（React 树之外的位置），提交后把它的裁剪窗记进状态再 portal
  const [tabsSlot, setTabsSlot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setTabsSlot(tabsHeader.current) }, [tabsHeader])
  // 面板是分栏宽的消费端：晚于上一次写入才挂上（懒加载）时照当前宽度补写
  useShellPane(WORKSPACE_PANE)
  // 宽度过渡跑在面板自己的 width 上，transitionend 就落在面板根节点
  useEffect(() => {
    const panel = root.current!
    const onEnd = (event: TransitionEvent) => {
      if (event.target === panel && event.propertyName === 'width') setAnimating(false)
    }
    panel.addEventListener('transitionend', onEnd)
    return () => panel.removeEventListener('transitionend', onEnd)
  }, [])
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
      // 头部的展开钮在工作区打开后卸载，主动把键盘焦点交给活动标签（标签头 portal 在应用头部，
      // 经裁剪窗查找；不用 tabsSlot 状态 —— 挂载当拍它还是 null，会错过这次交接）
      tabsHeader.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({ preventScroll: true })
    }
    if (!isOpen && wasOpen.current && visible) {
      const target = opener.current?.isConnected && opener.current.closest('[inert]') === null && opener.current.getClientRects().length > 0
        ? opener.current : document.querySelector<HTMLElement>('[data-chat-header] [aria-label="展开标签页区"]') ?? chat.current?.querySelector<HTMLElement>('textarea')
      target?.focus({ preventScroll: true })
    }
    wasOpen.current = isOpen
  }, [isOpen, visible, tabsHeader, chat])
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
      // 焦点在面板内或头部的标签头内都算（标签头 portal 在应用头部）
      const focused = target instanceof Node && (root.current?.contains(target) || tabsHeader.current?.contains(target))
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
  // 内层保宽（开合过渡中不逐帧回流）：面板内容与头部标签页区块的裁剪窗同一宽度
  const contentSize = workspaceWidth(contentWidth.current, false, scope.expanded, scope.width)
  const clipWidth = Math.max(0, contentSize - 1)
  useLayoutEffect(() => { if (tabsSlot !== null) tabsSlot.style.width = `${clipWidth}px` }, [tabsSlot, clipWidth])
  // 排序头与内容次序解耦，包括草稿迁移与 DownloadHold；React 始终复用同一 keyed 节点。
  const all = [...new Map([...Object.values(scopes).flatMap(s => s.tabs), ...Object.values(held)].map(tab => [tab.id, tab])).values()]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const show = visible && (isOpen || present)
  const activeTab = scope.tabs.find(tab => tab.id === scope.activeId)
  return <>
    {/* 标签头进应用头部的标签页区块；寿命随 show —— 收起动画播完才卸载，与面板同步消失。
        占满时对话头让位，「占满 / 收起」开关回到标签头右端 */}
    {show && tabsSlot !== null && createPortal(
      <WorkspaceTabs tabs={scope.tabs} activeId={scope.activeId} expanded={scope.expanded} tools={scope.expanded} onError={showError} />,
      tabsSlot
    )}
    {createPortal(<aside ref={root} data-shell-pane={WORKSPACE_PANE} aria-label="多标签工作区" aria-hidden={!isOpen} data-workspace data-home-tabs data-workspace-mode={scope.expanded ? 'expanded' : 'split'} inert={!isOpen} className="shell-pane-width absolute inset-y-0 right-0 z-20 min-h-0 border-l border-border bg-background" style={{ visibility: show ? 'visible' : 'hidden', pointerEvents: isOpen ? 'auto' : 'none' }}>
    {/* 折叠阈值 100 = 下限之半（组件默认档）：拖到 200px 后先钉住（阻力区），再内拖 100px 才折，
        与会话侧栏、文件树、模型设置栏同一手感；此前阈值 = 下限，拖到下限瞬折没有阻力 */}
    {isOpen && !scope.expanded && <SidebarResizeHandle key={scopeId} side="right" label="调整工作区宽度" className="absolute inset-y-0 -left-px z-30" min={WORKSPACE_COLLAPSE_WIDTH} max={() => Math.max(WORKSPACE_COLLAPSE_WIDTH, contentWidth.current - 160)} collapseThreshold={WORKSPACE_COLLAPSE_WIDTH / 2}
      readWidth={() => root.current!.getBoundingClientRect().width}
      writeWidth={px => {
        if (px === 0) {
          // 越过阈值先结束拖动态，再让面板从当前宽度动画收起。
          useWorkspaceStore.getState().setLayout({ width: root.current!.getBoundingClientRect().width, collapsed: true }, scopeId)
          return
        }
        // 拖拽期间过渡已由外壳关闭：直写即跟手（面板与头部中块/右块一起，对话留位同步）；
        // 头部裁剪窗与面板内容保持同一内层宽度
        writeShellPane(WORKSPACE_PANE, px)
        chat.current!.style.paddingRight = `${px}px`
        if (tabsSlot !== null) tabsSlot.style.width = `${Math.max(0, px - 1)}px`
        content.current!.style.width = `${Math.max(0, px - 1)}px`
      }}
      onCommit={px => useWorkspaceStore.getState().setLayout(resizeWorkspace(contentWidth.current, px), scopeId)}
      onReset={() => useWorkspaceStore.getState().setLayout({ width: WORKSPACE_DEFAULT_WIDTH })} />}
    {/* 与会话侧栏同样保宽并常驻合成层；稳定宿主与合成层缺一仍会在分数 DPR 下漂移物理像素。 */}
    <div className="h-full overflow-hidden"><div ref={content} data-workspace-content data-shell-pane={WORKSPACE_PANE} data-shell-pane-offset={-1} data-shell-pane-preserve className="flex h-full min-h-0 transform-gpu flex-col" style={{ width: clipWidth }}>
    {error !== null && <div role="alert" className="flex items-center gap-2 border-b border-border p-2 text-xs"><span className="min-w-0 flex-1 break-words">{error}</span><Button variant="ghost" size="xs" onClick={() => setError(null)}>关闭</Button></div>}
    <div className="min-h-0 flex-1 overflow-hidden">
      <WorkspaceAnimatingContext.Provider value={animating}>
        <FileWorkspacePane tabs={all.filter(tab => tab.kind === 'file' || tab.kind === 'files')} scopeId={scopeId} projectId={scope.projectId} sessionId={scopeId.startsWith('draft:') ? undefined : scopeId} grantIds={scope.grantIds} active={show && (activeTab?.kind === 'file' || activeTab?.kind === 'files')} activeTabId={scope.activeId}
          onContextChange={({ grantIds }) => useWorkspaceStore.getState().setGrants(scopeId, grantIds)} />
      </WorkspaceAnimatingContext.Provider>
      {all.filter(tab => tab.kind === 'start' || tab.kind === 'browser' || tab.kind === 'diff').map(tab => <WorkspacePanel key={tab.id} tab={tab} active={show && tab.scopeId === scopeId && tab.id === scope.activeId && held[tab.id] === undefined} />)}
    </div>
    </div></div>
  </aside>, workspaceHost)}
  </>
})
