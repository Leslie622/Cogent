/** 展开入口随状态卸载，验证焦点交接依赖真实DOM而不是只检查store。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceSurface } from '@/features/workspace/WorkspaceSurface'
import { EMPTY_WORKSPACE, useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/features/workspace/legacy-cache', () => ({ clearLegacyWorkspaceCache: () => Promise.resolve() }))
vi.mock('@/features/workspace/FileWorkspacePane', () => ({ FileWorkspacePane: () => null }))
vi.mock('@/features/workspace/BrowserPane', () => ({ BrowserPane: () => null }))

function Subject() {
  const scope = useWorkspaceStore(state => state.scopes[state.activeScopeId] ?? EMPTY_WORKSPACE)
  return <div data-workspace-frame>
    {scope.collapsed && <button type="button" aria-label="展开标签页区" onClick={() => useWorkspaceStore.getState().toggle()}>展开</button>}
    <WorkspaceSurface contentWidth={700} visible />
  </div>
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.cogent = { onEngineEvent: () => () => {}, onBrowserEvent: () => () => {} } as unknown as typeof window.cogent
  useWorkspaceStore.getState().reset()
  useWorkspaceStore.getState().setScope('draft:focus')
})
afterEach(() => { cleanup(); useWorkspaceStore.getState().reset(); vi.unstubAllGlobals() })

it('首次启动不创建标签、不展开或聚焦工作区，也不弹标签Tooltip', async () => {
  render(<Subject />)
  await act(async () => { await Promise.resolve() })
  expect(useWorkspaceStore.getState().scopes['draft:focus']).toMatchObject({ tabs: [], collapsed: true, activeId: null })
  expect(screen.queryByRole('tab')).toBeNull()
  expect(screen.getByRole('button', { name: '展开标签页区' })).not.toHaveFocus()
  expect(document.querySelector('[data-slot=tooltip-content]')).toBeNull()
})

it('展开按钮卸载后聚焦活动标签，折叠后返回重新出现的展开入口', async () => {
  render(<Subject />)
  const open = screen.getByRole('button', { name: '展开标签页区' })
  act(() => open.focus())
  fireEvent.click(open)
  await waitFor(() => expect(screen.getByRole('tab', { selected: true })).toHaveFocus())
  expect(open.isConnected).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '收起工作区' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '展开标签页区' })).toHaveFocus())
})
