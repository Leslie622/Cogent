/** 三栏阅读界面：左侧为「架构地图 + 专题流程」导航，中栏画布，右栏职责/契约/来源说明。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import type { DetailMode, ViewFilterMode } from './网格布局'
import { getEdgeDetail, moduleDetails, viewDetails, type EdgeDetail } from './模块说明'
import { drilldownViewIds, flowCodeViewMap, viewGroups, viewIds, viewNames, type ViewId } from './视图'
import { ArchitectureCanvas } from './components/架构画布'
import { IconButton } from './components/图标按钮'
import { ModulePanel } from './components/模块面板'
import {
  ArrowLeftIcon,
  LayersIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightOpenIcon,
  SunIcon,
  WorkflowIcon,
} from './components/图标'
import { Button, CollapsiblePanel, Separator } from './components/UI'

const themeKey = 'cogent-arch-theme'

function useWindowMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

function initialView(): ViewId {
  if (typeof window === 'undefined') return 'overview'
  const match = /^#view=([a-zA-Z0-9]+)$/.exec(window.location.hash)
  const candidate = match?.[1]
  if (candidate !== undefined && (viewIds as readonly string[]).includes(candidate)) {
    return candidate as ViewId
  }
  return 'overview'
}

function initialDark(): boolean {
  try {
    const saved = window.localStorage.getItem(themeKey)
    if (saved === 'dark') return true
    if (saved === 'light') return false
  } catch {
    // 隐私模式或禁用存储时回退系统偏好
  }
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<{
    id: string
    source: string
    target: string
    label?: string
    description?: string | null
  } | null>(null)
  const [viewId, setViewId] = useState<ViewId>(initialView)
  const [filter, setFilter] = useState<ViewFilterMode>('all')
  const [detailMode, setDetailMode] = useState<DetailMode>('logic')
  const [origin, setOrigin] = useState<{ view: ViewId; node: string | null } | null>(null)
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null)
  const compact = useWindowMediaQuery('(max-width: 999px)')
  const narrow = useWindowMediaQuery('(max-width: 699px)')
  const [leftOpen, setLeftOpen] = useState(!compact)
  const [rightOpen, setRightOpen] = useState(!narrow)
  const [dark, setDark] = useState(initialDark)

  const heading = useRef<HTMLHeadingElement>(null)
  const panelHeading = useRef<HTMLHeadingElement>(null)
  const leftHeading = useRef<HTMLAnchorElement>(null)
  const leftTrigger = useRef<HTMLButtonElement>(null)
  const panelOpener = useRef<HTMLElement | null>(null)
  const nextFocus = useRef<(() => void) | null>(null)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      window.localStorage.setItem(themeKey, dark ? 'dark' : 'light')
    } catch {
      // ignore
    }
  }, [dark])

  useEffect(() => {
    try {
      const nextHash = `#view=${viewId}`
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash)
      }
    } catch {
      // ignore
    }
  }, [viewId])

  useLayoutEffect(() => {
    const focus = nextFocus.current
    nextFocus.current = null
    focus?.()
  })

  function openView(id: ViewId, drillFromNode?: string) {
    if (id === viewId && selectedId === null && selectedEdge === null) return
    setOrigin(drillFromNode !== undefined && drilldownViewIds.has(id) ? { view: viewId, node: drillFromNode } : null)
    setSelectedId(null)
    setSelectedEdge(null)
    setReturnFocusId(null)
    setViewId(id)
    if (narrow) {
      setLeftOpen(false)
      setRightOpen(false)
    }
    nextFocus.current = () => heading.current?.focus({ preventScroll: true })
  }

  function returnToSource() {
    const node = origin?.node ?? null
    setViewId(origin?.view ?? 'overview')
    setSelectedId(node)
    setSelectedEdge(null)
    setReturnFocusId(node)
    setOrigin(null)
    nextFocus.current = () => heading.current?.focus({ preventScroll: true })
  }

  function selectModule(id: string | null) {
    setReturnFocusId(null)
    setSelectedEdge(null)
    if (id !== null) {
      const detail = moduleDetails[id]
      if (detail.navigateOnClick === true && detail.navigateTo !== undefined && detail.navigateTo !== viewId) {
        openView(detail.navigateTo, id)
        return
      }
      if (narrow) openRight()
    }
    setSelectedId(id)
  }

  function selectEdge(
    edge: { id: string; source: string; target: string; label?: string; description?: string | null } | null,
  ) {
    setReturnFocusId(null)
    setSelectedId(null)
    setSelectedEdge(edge)
    if (edge !== null && narrow) openRight()
  }

  useEffect(() => {
    if (compact) setLeftOpen(false)
  }, [compact])
  useEffect(() => {
    if (narrow) setRightOpen(false)
  }, [narrow])

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
      if (opener !== null && opener !== document.body && opener.isConnected && opener.closest('[inert]') === null) {
        opener.focus({ preventScroll: true })
      } else {
        heading.current?.focus({ preventScroll: true })
      }
    }
    setRightOpen(false)
  }

  const codeViewId = flowCodeViewMap[viewId]
  const activeViewId: ViewId = detailMode === 'code' && codeViewId !== undefined ? codeViewId : viewId
  const activeDetail = selectedId === null ? viewDetails[activeViewId] : moduleDetails[selectedId]
  const activeEdgeDetail: EdgeDetail | null = selectedEdge === null
    ? null
    : getEdgeDetail(selectedEdge.source, selectedEdge.target)

  return (
    <>
      <a href="#main-content" className="skip-link">跳到架构总览</a>
      <div className="architecture-app">
        <CollapsiblePanel
          open={leftOpen}
          id="architecture-navigation"
          className="architecture-side architecture-left"
          onKeyDown={(event) => {
            if (narrow && event.key === 'Escape') closeLeft()
          }}
        >
          <aside className="architecture-sidebar" aria-label="架构目录">
            <header className="side-header">
              <a
                ref={leftHeading}
                href="#"
                onClick={(event) => {
                  event.preventDefault()
                  openView('overview')
                }}
                className="text-base font-semibold tracking-tight"
                aria-label="Cogent 项目地图首页"
              >
                Cogent 地图
              </a>
              <IconButton label="折叠左侧栏" aria-expanded={leftOpen} aria-controls="architecture-navigation" onClick={closeLeft}>
                <PanelLeftCloseIcon />
              </IconButton>
            </header>
            <nav className="architecture-nav-scroll space-y-5" aria-label="架构导航">
              {viewGroups.map((group) => (
                <section key={group.title} className="space-y-1">
                  <h2 className="px-2.5 pb-1 text-xs font-semibold text-muted-foreground">{group.title}</h2>
                  {group.ids.map((id) => {
                    const Icon = group.title === '专题流程' ? WorkflowIcon : LayersIcon
                    const active = viewId === id
                    return (
                      <Button
                        key={id}
                        variant={active ? 'secondary' : 'ghost'}
                        size="default"
                        className="h-9 w-full justify-start gap-2.5 px-2.5 text-sm"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => openView(id)}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate">{viewNames[id]}</span>
                      </Button>
                    )
                  })}
                </section>
              ))}
            </nav>
          </aside>
        </CollapsiblePanel>

        <main id="main-content" className="architecture-main" aria-label="架构画布" inert={narrow && (leftOpen || rightOpen)}>
          <h1 ref={heading} tabIndex={-1} className="sr-only">{viewNames[activeViewId]} · Cogent 项目地图</h1>
          <ReactFlowProvider key={activeViewId}>
            <ArchitectureCanvas
              viewId={activeViewId}
              filter={filter}
              selectedId={selectedId}
              selectedEdgeId={selectedEdge?.id ?? null}
              onSelect={selectModule}
              onSelectEdge={selectEdge}
              returnFocusId={returnFocusId}
              onReturnFocus={() => setReturnFocusId(null)}
            />
          </ReactFlowProvider>

          <div className="canvas-top-controls">
            <div className="flex items-center gap-1">
              {!leftOpen && (
                <IconButton ref={leftTrigger} label="展开左侧栏" aria-expanded={leftOpen} aria-controls="architecture-navigation" onClick={openLeft}>
                  <PanelLeftOpenIcon />
                </IconButton>
              )}
              {origin !== null && (
                <Button variant="ghost" size="sm" onClick={returnToSource}>
                  <ArrowLeftIcon className="size-3.5" />
                  返回{viewNames[origin.view]}
                </Button>
              )}
              <span className="px-2 text-xs font-medium text-muted-foreground">{viewNames[activeViewId]}</span>
            </div>

            <div className="flex items-center gap-1.5">
              {codeViewId !== undefined && (
                <>
                  <div className="flex items-center gap-1" role="group" aria-label="逻辑版与源码版切换">
                    {([
                      ['logic', '逻辑版'],
                      ['code', '源码版'],
                    ] as const).map(([mode, label]) => (
                      <Button
                        key={mode}
                        variant={detailMode === mode ? 'secondary' : 'ghost'}
                        size="sm"
                        aria-pressed={detailMode === mode}
                        onClick={() => {
                          setDetailMode(mode)
                          setSelectedId(null)
                          setSelectedEdge(null)
                        }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <Separator orientation="vertical" className="mx-0.5 h-4" />
                </>
              )}
              <div className="flex items-center gap-1" role="group" aria-label="完成度筛选">
                {([
                  ['all', '全部'],
                  ['implemented', '仅已实现'],
                  ['gaps', '高亮缺口'],
                ] as const).map(([mode, label]) => (
                  <Button
                    key={mode}
                    variant={filter === mode ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={filter === mode}
                    onClick={() => {
                      setFilter(mode)
                      if (mode === 'implemented') {
                        if (selectedId !== null && moduleDetails[selectedId].status === 'planned') {
                          setSelectedId(null)
                        }
                        setSelectedEdge(null)
                      }
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1">
              <span className="theme-control">
                <IconButton label={dark ? '切换浅色' : '切换深色'} onClick={() => setDark((prev) => !prev)}>
                  {dark ? <SunIcon /> : <MoonIcon />}
                </IconButton>
              </span>
              {!rightOpen && (
                <IconButton label="展开右侧栏" aria-expanded={rightOpen} aria-controls="architecture-description" onClick={openRight}>
                  <PanelRightOpenIcon />
                </IconButton>
              )}
            </div>
          </div>
        </main>

        <CollapsiblePanel
          open={rightOpen}
          id="architecture-description"
          className="architecture-side architecture-right"
          onKeyDown={(event) => {
            if (narrow && event.key === 'Escape') closeRight()
          }}
        >
          <ModulePanel
            detail={activeDetail}
            edgeDetail={activeEdgeDetail}
            isViewOverview={selectedId === null && activeEdgeDetail === null}
            headingRef={panelHeading}
            onClose={closeRight}
            onNavigate={(target) => openView(target, selectedId ?? undefined)}
          />
        </CollapsiblePanel>
      </div>
    </>
  )
}
