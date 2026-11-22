/** 常驻宿主把左导航断点投影到临时开合状态；显式打开可接管，不覆盖会话布局记忆。 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useHomeStore } from '@/stores/home'
import { useChatStore } from '@/stores/chat'
import { useWorkspaceStore, EMPTY_WORKSPACE } from '@/stores/workspace'
import { WorkspaceSurface } from './WorkspaceSurface'
import { workspaceWidth } from './layout'

export function WorkspaceFrame({ visible, autoCollapsed = false, children }: { visible: boolean; autoCollapsed?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const session = useHomeStore(s => s.session)
  const sessions = useChatStore(s => s.sessions)
  const scopeId = session.kind === 'chat' ? session.chatId : 'draft:' + (session.draftId ?? 'default')
  const projectId = session.kind === 'new' ? session.projectId : sessions.find(s => s.id === session.chatId)?.projectId
  const scope = useWorkspaceStore(s => s.scopes[s.activeScopeId] ?? EMPTY_WORKSPACE)
  const temporarilyCollapsed = useWorkspaceStore(s => s.autoCollapsed)
  useLayoutEffect(() => { useWorkspaceStore.getState().setAutoCollapsed(autoCollapsed) }, [autoCollapsed])
  useEffect(() => { useWorkspaceStore.getState().setScope(scopeId, projectId) }, [scopeId, projectId])
  useEffect(() => {
    const node = ref.current!
    const observer = new ResizeObserver(() => setWidth(node.clientWidth))
    setWidth(node.clientWidth); observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const collapsed = scope.collapsed || temporarilyCollapsed
  const panelWidth = workspaceWidth(width, collapsed, scope.expanded, scope.width)
  const expanded = visible && !collapsed && scope.expanded
  return <div ref={ref} data-workspace-frame className="relative h-full min-w-0 overflow-hidden [&:has([data-separator=active])>[data-workspace-chat]]:transition-none [&:has([data-separator=active])>[data-workspace]]:transition-none">
    <div data-workspace-chat className="h-full min-w-0 transition-[padding-right] duration-200 ease-out motion-reduce:transition-none" inert={expanded} style={{ paddingRight: visible && !scope.expanded ? panelWidth : 0 }}>{children}</div>
    <WorkspaceSurface contentWidth={width} visible={visible} />
  </div>
}
