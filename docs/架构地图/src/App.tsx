/** 三栏阅读界面；侧栏使用共享折叠原语，画布与说明各自占满可用空间。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { ArrowLeft, Layers3, Moon, PanelLeftClose, PanelLeftOpen, PanelRightOpen, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWindowMediaQuery } from '@/hooks/use-window-media-query'
import { useAppearanceStore, useIsDarkMode } from '@/stores/appearance'
import { ArchitectureCanvas } from './components/架构画布'
import { IconButton } from './components/图标按钮'
import { ModulePanel } from './components/模块面板'
import { moduleDetails, viewDetails } from './模块说明'
import { primaryViewIds, viewNames, type ViewId } from './视图'

const isDetailView = (id: ViewId) => id === 'services' || id === 'capabilities'

export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewId, setViewId] = useState<ViewId>('overview')
  const [origin, setOrigin] = useState<{ view: ViewId; node: string | null } | null>(null)
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null)
  const compact = useWindowMediaQuery('(max-width: 999px)')
  const narrow = useWindowMediaQuery('(max-width: 699px)')
  const [leftOpen, setLeftOpen] = useState(!compact)
  const [rightOpen, setRightOpen] = useState(!narrow)
  const dark = useIsDarkMode()
  const detail = selectedId === null ? viewDetails[viewId] : moduleDetails[selectedId]
  const heading = useRef<HTMLHeadingElement>(null)
  const panelHeading = useRef<HTMLHeadingElement>(null)
  const leftHeading = useRef<HTMLAnchorElement>(null)
  const leftTrigger = useRef<HTMLButtonElement>(null)
  const panelOpener = useRef<HTMLElement | null>(null)
  const nextFocus = useRef<(() => void) | null>(null)

  // 视图切换会重挂画布，等待新标题或返回节点出现以后再交还焦点。
  useLayoutEffect(() => {
    const focus = nextFocus.current
    nextFocus.current = null
    focus?.()
  })

  function openView(id: ViewId, node = selectedId) {
    if (id === viewId && selectedId === null) return
    setOrigin(isDetailView(id) ? { view: viewId, node } : null)
    setSelectedId(null)
    setReturnFocusId(null)
    setViewId(id)
    if (narrow) { setLeftOpen(false); setRightOpen(false) }
    nextFocus.current = () => heading.current?.focus({ preventScroll: true })
  }

  function returnToSource() {
    const node = origin?.node ?? null
    setViewId(origin?.view ?? 'overview')
    setSelectedId(node)
    setReturnFocusId(node)
    setOrigin(null)
    nextFocus.current = () => heading.current?.focus({ preventScroll: true })
  }

  function selectModule(id: string | null) {
    setReturnFocusId(null)
    if (id !== null) {
      const detail = moduleDetails[id]
      if (detail.navigateOnClick === true && detail.navigateTo !== viewId) {
        openView(detail.navigateTo!, id)
        return
      }
      if (narrow) openRight()
    }
    setSelectedId(id)
  }

  // 进入窄窗口时先让出画布；用户仍可从同一组开关展开所需侧栏。
  useEffect(() => { if (compact) setLeftOpen(false) }, [compact])
  useEffect(() => { if (narrow) setRightOpen(false) }, [narrow])

  function openLeft() {
    if (narrow) setRightOpen(false)
    nextFocus.current = () => leftHeading.current?.focus()
    setLeftOpen(true)
  }

  function openRight() {
    if (narrow) setLeftOpen(false)
    panelOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    nextFocus.current = () => panelHeading.current?.focus()
    setRightOpen(true)
  }

  function closeLeft() {
    nextFocus.current = () => leftTrigger.current?.focus()
    setLeftOpen(false)
  }

  function closeRight() {
    nextFocus.current = () => {
      const opener = panelOpener.current
      if (opener !== null && opener !== document.body && opener.isConnected && opener.closest('[inert]') === null) opener.focus({ preventScroll: true })
      else heading.current?.focus({ preventScroll: true })
    }
    setRightOpen(false)
  }

  return <TooltipProvider>
    <a href="#main-content" className="skip-link">跳到架构总览</a>
    <div className="architecture-app">
      <Collapsible open={leftOpen} onOpenChange={setLeftOpen} className="architecture-side architecture-left" data-collapsed={!leftOpen} inert={!leftOpen} onKeyDown={event => { if (narrow && event.key === 'Escape') closeLeft() }}>
        <CollapsibleContent id="architecture-navigation" keepMounted className="architecture-side-content">
          <aside className="architecture-sidebar" aria-label="架构目录">
            <header className="side-header">
              <a ref={leftHeading} href="#" onClick={event => { event.preventDefault(); openView('overview') }} className="text-base font-semibold tracking-tight" aria-label="Cogent 架构地图首页">Cogent</a>
              <IconButton label="折叠左侧栏" aria-expanded={leftOpen} aria-controls="architecture-navigation" onClick={closeLeft}><PanelLeftClose /></IconButton>
            </header>
            <nav className="p-3" aria-label="架构导航">
              <Button variant="secondary" className="w-full justify-start gap-2" aria-current="page" onClick={() => openView('overview')}><Layers3 />架构总览</Button>
            </nav>
          </aside>
        </CollapsibleContent>
      </Collapsible>
      <main id="main-content" className="architecture-main" aria-label="架构画布" inert={narrow && (leftOpen || rightOpen)}>
        <h1 ref={heading} tabIndex={-1} className="sr-only">{viewNames[viewId]} · 目标架构</h1>
        <ReactFlowProvider key={viewId}>
          <ArchitectureCanvas viewId={viewId} selectedId={selectedId} onSelect={selectModule} returnFocusId={returnFocusId} onReturnFocus={() => setReturnFocusId(null)} />
        </ReactFlowProvider>
        <div className="canvas-top-controls">
          <div className="flex items-center gap-1">
            {!leftOpen && <IconButton ref={leftTrigger} label="展开左侧栏" aria-expanded={leftOpen} aria-controls="architecture-navigation" onClick={openLeft}><PanelLeftOpen /></IconButton>}
            <span className="px-2 text-xs text-muted-foreground" aria-hidden="true">目标架构</span>
          </div>
          <div className="architecture-view-controls flex gap-1" role="group" aria-label="架构视图">
            {isDetailView(viewId) ? <>
              <Button variant="ghost" size="sm" onClick={returnToSource}><ArrowLeft />返回{viewNames[origin?.view ?? 'overview']}</Button>
              <span className="flex items-center px-2 text-xs text-muted-foreground">{viewNames[viewId]}</span>
            </> : primaryViewIds.map(id => <Button key={id} variant={viewId === id ? 'secondary' : 'ghost'} size="sm" aria-pressed={viewId === id} onClick={() => openView(id)}>{viewNames[id]}</Button>)}
          </div>
          <div className="flex gap-1">
            <span className="theme-control"><IconButton label={dark ? '切换浅色' : '切换深色'} onClick={() => useAppearanceStore.getState().setColorMode(dark ? 'light' : 'dark')}>{dark ? <Sun /> : <Moon />}</IconButton></span>
            {!rightOpen && <IconButton label="展开右侧栏" aria-expanded={rightOpen} aria-controls="architecture-description" onClick={openRight}><PanelRightOpen /></IconButton>}
          </div>
        </div>
      </main>
      <Collapsible open={rightOpen} onOpenChange={setRightOpen} className="architecture-side architecture-right" data-collapsed={!rightOpen} inert={!rightOpen} onKeyDown={event => { if (narrow && event.key === 'Escape') closeRight() }}>
        <CollapsibleContent id="architecture-description" keepMounted className="architecture-side-content">
          <ModulePanel detail={detail} headingRef={panelHeading} onClose={closeRight} onNavigate={openView} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  </TooltipProvider>
}
