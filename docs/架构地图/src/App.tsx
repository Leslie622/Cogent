/** 三栏阅读界面；侧栏使用共享折叠原语，画布与说明各自占满可用空间。 */
import { useEffect, useState } from 'react'
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

export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewId, setViewId] = useState<ViewId>('overview')
  const compact = useWindowMediaQuery('(max-width: 999px)')
  const narrow = useWindowMediaQuery('(max-width: 699px)')
  const [leftOpen, setLeftOpen] = useState(!compact)
  const [rightOpen, setRightOpen] = useState(!narrow)
  const dark = useIsDarkMode()
  const detail = selectedId === null ? viewDetails[viewId] : moduleDetails[selectedId]

  function openView(id: ViewId) {
    setSelectedId(null)
    setViewId(id)
  }

  function selectModule(id: string | null) {
    if (id !== null) {
      const detail = moduleDetails[id]
      if (detail.navigateOnClick === true && detail.navigateTo !== viewId) {
        openView(detail.navigateTo!)
        return
      }
    }
    setSelectedId(id)
  }

  // 进入窄窗口时先让出画布；用户仍可从同一组开关展开所需侧栏。
  useEffect(() => { if (compact) setLeftOpen(false) }, [compact])
  useEffect(() => { if (narrow) setRightOpen(false) }, [narrow])

  function openLeft() {
    if (narrow) setRightOpen(false)
    setLeftOpen(true)
  }

  function openRight() {
    if (narrow) setLeftOpen(false)
    setRightOpen(true)
  }

  return <TooltipProvider>
    <a href="#main-content" className="skip-link">跳到架构总览</a>
    <div className="architecture-app">
      <Collapsible open={leftOpen} onOpenChange={setLeftOpen} className="architecture-side architecture-left" data-collapsed={!leftOpen} inert={!leftOpen}>
        <CollapsibleContent id="architecture-navigation" keepMounted className="architecture-side-content">
          <aside className="architecture-sidebar" aria-label="架构目录">
            <header className="side-header">
              <a href="#" onClick={() => openView('overview')} className="text-base font-semibold tracking-tight" aria-label="Cogent 架构地图首页">Cogent</a>
              <IconButton label="折叠左侧栏" aria-expanded={leftOpen} aria-controls="architecture-navigation" onClick={() => setLeftOpen(false)}><PanelLeftClose /></IconButton>
            </header>
            <nav className="p-3" aria-label="架构导航">
              <Button variant="secondary" className="w-full justify-start gap-2" aria-current="page" onClick={() => openView('overview')}><Layers3 />架构总览</Button>
            </nav>
          </aside>
        </CollapsibleContent>
      </Collapsible>
      <main id="main-content" className="architecture-main" aria-label="架构画布">
        <h1 className="sr-only">架构总览</h1>
        <ReactFlowProvider key={viewId}><ArchitectureCanvas viewId={viewId} selectedId={selectedId} onSelect={selectModule} /></ReactFlowProvider>
        <div className="canvas-top-controls">
          <div className="flex gap-1">
            {!leftOpen && <IconButton label="展开左侧栏" aria-expanded={leftOpen} aria-controls="architecture-navigation" onClick={openLeft}><PanelLeftOpen /></IconButton>}
          </div>
          <div className="architecture-view-controls flex gap-1" role="group" aria-label="架构视图">
            {viewId === 'services' || viewId === 'capabilities' ? <>
              <Button variant="ghost" size="sm" onClick={() => openView('overview')}><ArrowLeft />返回总览</Button>
              <span className="flex items-center px-2 text-xs text-muted-foreground">{viewNames[viewId]}</span>
            </> : primaryViewIds.map(id => <Button key={id} variant={viewId === id ? 'secondary' : 'ghost'} size="sm" aria-pressed={viewId === id} onClick={() => openView(id)}>{viewNames[id]}</Button>)}
          </div>
          <div className="flex gap-1">
            <span className="theme-control"><IconButton label={dark ? '切换浅色' : '切换深色'} onClick={() => useAppearanceStore.getState().setColorMode(dark ? 'light' : 'dark')}>{dark ? <Sun /> : <Moon />}</IconButton></span>
            {!rightOpen && <IconButton label="展开右侧栏" aria-expanded={rightOpen} aria-controls="architecture-description" onClick={openRight}><PanelRightOpen /></IconButton>}
          </div>
        </div>
      </main>
      <Collapsible open={rightOpen} onOpenChange={setRightOpen} className="architecture-side architecture-right" data-collapsed={!rightOpen} inert={!rightOpen}>
        <CollapsibleContent id="architecture-description" keepMounted className="architecture-side-content">
          <ModulePanel detail={detail} onClose={() => setRightOpen(false)} onNavigate={openView} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  </TooltipProvider>
}
