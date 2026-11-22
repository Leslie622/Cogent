/** 对话本体与工作区生命周期独立，工作区常驻于 AppShell。 */
import { HomeChat } from './HomeChat'
import { useWorkspaceStore, EMPTY_WORKSPACE } from '@/stores/workspace'
export function HomeMain() {
  const collapsed = useWorkspaceStore(s => s.autoCollapsed || (s.scopes[s.activeScopeId] ?? EMPTY_WORKSPACE).collapsed)
  return <div className="h-full min-w-0" data-home-split>
    <HomeChat tabsCollapsed={collapsed} onToggleTabs={() => useWorkspaceStore.getState().toggle()} />
  </div>
}
