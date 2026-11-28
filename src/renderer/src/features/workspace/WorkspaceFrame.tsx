/** 常驻owner把左导航断点投影到临时开合状态；显式打开可接管，不覆盖会话布局记忆。
 *  这里量可用宽度、保留对话留位；面板DOM常驻静止主卡，由Surface portal过去。
 *  工作区宽度在这里按状态写入（shell-panes.ts）：面板与应用头部中块/右块经 writeShellPane 一次
 *  写全，对话留位由这里写 padding-right；都是内联普通样式、同一条过渡（globals.css「外壳分栏宽度」），
 *  开合与拖拽只改这一个数，几处线性相关、天然对齐。 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useHomeStore } from '@/stores/home'
import { useChatStore } from '@/stores/chat'
import { useWorkspaceStore, EMPTY_WORKSPACE } from '@/stores/workspace'
import { useWorkspaceRuntime } from './runtime'
import { workspaceWidth } from './layout'
import { WORKSPACE_PANE, writeShellPane } from '@/features/shell/shell-panes'

const WorkspaceSurface = lazy(() =>
  import('./WorkspaceSurface').then((m) => ({ default: m.WorkspaceSurface }))
)

export function WorkspaceFrame({ visible, autoCollapsed = false, tabsHeader, workspaceHost, children }: {
  visible: boolean
  autoCollapsed?: boolean
  /** 应用头部标签页区块的内层裁剪窗：工作区把自己的标签头 portal 进去 */
  tabsHeader: RefObject<HTMLDivElement | null>
  /** 面板的稳定 DOM 宿主（主内容卡），不随会话侧栏的宽度过渡移动。 */
  workspaceHost: HTMLElement | null
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const chat = useRef<HTMLDivElement | null>(null)
  // 只供布局与拖拽现读；侧栏开合逐帧改变容器宽度，不应驱动标签与查看器重渲染。
  const width = useRef(0)
  const session = useHomeStore(s => s.session)
  const sessions = useChatStore(s => s.sessions)
  const scopeId = session.kind === 'chat' ? session.chatId : 'draft:' + (session.draftId ?? 'default')
  const projectId = session.kind === 'new' ? session.projectId : sessions.find(s => s.id === session.chatId)?.projectId
  const scope = useWorkspaceStore(s => s.scopes[s.activeScopeId] ?? EMPTY_WORKSPACE)
  const temporarilyCollapsed = useWorkspaceStore(s => s.autoCollapsed)
  const heldCount = useWorkspaceRuntime(s => Object.keys(s.held).length)
  const shouldActivateSurface = (visible && !scope.collapsed && !temporarilyCollapsed) || scope.tabs.length > 0 || heldCount > 0
  const [surfaceMounted, setSurfaceMounted] = useState(shouldActivateSurface)
  if (shouldActivateSurface && !surfaceMounted) setSurfaceMounted(true)
  useEffect(() => {
    if (!visible || surfaceMounted) return
    let cancelled = false
    const warmup = () => {
      if (cancelled) return
      void import('./WorkspaceSurface')
      void import('../home/files/TextPreview')
      setSurfaceMounted(true)
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warmup, { timeout: 1200 })
      return () => { cancelled = true; window.cancelIdleCallback(id) }
    }
    const timer = window.setTimeout(warmup, 600)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [visible, surfaceMounted])
  useLayoutEffect(() => { useWorkspaceStore.getState().setAutoCollapsed(autoCollapsed) }, [autoCollapsed])
  useEffect(() => { useWorkspaceStore.getState().setScope(scopeId, projectId) }, [scopeId, projectId])
  const collapsed = scope.collapsed || temporarilyCollapsed
  const expanded = visible && !collapsed && scope.expanded
  // 面板宽不随路由隐藏归零：切到设置再回来时工作区原宽原位出现，不重播展开过渡。
  useLayoutEffect(() => {
    const node = ref.current!
    let previousWidth = -1, previousInset = -1
    const measure = (resizing: boolean) => {
      width.current = node.clientWidth
      const workspaceWidthPx = workspaceWidth(width.current, collapsed, scope.expanded, scope.width)
      // 对话留位只在首页并排时让位，占满或非首页为 0。
      const chatInsetPx = visible && !scope.expanded ? workspaceWidthPx : 0
      if (workspaceWidthPx !== previousWidth) {
        writeShellPane(WORKSPACE_PANE, workspaceWidthPx, resizing)
        previousWidth = workspaceWidthPx
      }
      if (chatInsetPx !== previousInset) {
        chat.current!.toggleAttribute('data-shell-pane-resizing', resizing)
        chat.current!.style.paddingRight = `${chatInsetPx}px`
        previousInset = chatInsetPx
      }
    }
    // 开合意图才播放过渡；容器变化由观察器安排 rAF 同步几何，不再进 React 状态。
    measure(false)
    let frame: number | undefined
    const observer = new ResizeObserver(() => {
      width.current = node.clientWidth
      if (frame !== undefined || workspaceWidth(width.current, collapsed, scope.expanded, scope.width) === previousWidth) return
      // 写入还会调整位于 Frame 之外的头部，推迟到下一帧布局前，避免 RO 浅层循环通知。
      frame = requestAnimationFrame(() => { frame = undefined; measure(true) })
    })
    observer.observe(node)
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [collapsed, scope.expanded, scope.width, visible])
  return <div ref={ref} data-workspace-frame className="relative h-full min-w-0 overflow-hidden">
    <div ref={chat} data-workspace-chat className="shell-pane-inset h-full min-w-0" inert={expanded}>{children}</div>
    {surfaceMounted && workspaceHost !== null && (
      <Suspense fallback={null}>
        <WorkspaceSurface contentWidth={width} visible={visible} tabsHeader={tabsHeader} chat={chat} workspaceHost={workspaceHost} />
      </Suspense>
    )}
  </div>
}
