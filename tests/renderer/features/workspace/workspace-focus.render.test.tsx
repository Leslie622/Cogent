/** 展开入口随状态卸载，验证焦点交接依赖真实DOM而不是只检查store。
 *  应用头部是单行三区块：标签头 portal 进头部的标签页区块（在面板之外），
 *  这里照产品结构搭头部两个区块。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type RefObject } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceSurface } from '@/features/workspace/WorkspaceSurface'
import { EMPTY_WORKSPACE, useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/features/workspace/legacy-cache', () => ({ clearLegacyWorkspaceCache: () => Promise.resolve() }))
vi.mock('@/features/workspace/FileWorkspacePane', () => ({ FileWorkspacePane: () => null }))
vi.mock('@/features/workspace/BrowserPane', () => ({ BrowserPane: () => null }))

let tabsHeader: RefObject<HTMLDivElement | null>
let chat: RefObject<HTMLDivElement | null>

function Subject({ visible = true }: { visible?: boolean }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const scope = useWorkspaceStore(state => state.scopes[state.activeScopeId] ?? EMPTY_WORKSPACE)
  return <div>
    {/* 应用头部：中块的对话头与右块的标签页区块裁剪窗。工作区开关恒在对话头右端 —— 收起时是
        展开入口，并排时是收起（占满时才回到标签头右端，这里不走占满） */}
    <div data-app-header>
      <div data-chat-header>
        {scope.collapsed
          ? <button key="expand" type="button" aria-label="展开标签页区" onClick={() => useWorkspaceStore.getState().toggle()}>展开</button>
          : <button key="collapse" type="button" aria-label="收起工作区" onClick={() => useWorkspaceStore.getState().setLayout({ collapsed: true })}>收起</button>}
      </div>
      <div ref={tabsHeader} data-app-header-tabs />
    </div>
    <main ref={setHost} data-workspace-host><div data-workspace-frame>
      <div ref={chat} data-workspace-chat />
      {host !== null && <WorkspaceSurface contentWidth={{ current: 700 }} visible={visible} tabsHeader={tabsHeader} chat={chat} workspaceHost={host} />}
    </div></main>
  </div>
}

beforeEach(() => {
  tabsHeader = { current: null }
  chat = { current: null }
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
  // 标签头在面板之外的应用头部里，不落在 [data-workspace] 内
  expect(document.querySelector('[data-workspace] [data-workspace-header]')).toBeNull()
  expect(document.querySelector('[data-app-header-tabs] [data-workspace-header]')).not.toBeNull()
  expect(document.querySelector('[data-workspace]')!.parentElement).toBe(document.querySelector('[data-workspace-host]'))
  expect(document.querySelector('[data-workspace-frame] [data-workspace]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '收起工作区' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '展开标签页区' })).toHaveFocus())
})

it('焦点停在头部的标签上时，工作区快捷键仍然生效', async () => {
  act(() => { useWorkspaceStore.getState().newTab() })
  act(() => { useWorkspaceStore.getState().newTab() })
  render(<Subject />)
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
  const tabs = screen.getAllByRole('tab')
  const first = tabs.find(tab => tab.getAttribute('aria-selected') === 'true')!
  const second = tabs.find(tab => tab !== first)!
  expect(first.closest('[data-workspace]')).toBeNull()
  act(() => first.focus())
  fireEvent.keyDown(first, { key: 'Tab', ctrlKey: true })
  await waitFor(() => expect(second).toHaveAttribute('aria-selected', 'true'))
})

it('面板始终挂在同一主卡，布局切换、路由隐藏和收起不会搬动内容父树', async () => {
  act(() => { useWorkspaceStore.getState().newTab() })
  const view = render(<Subject />)
  const panel = document.querySelector('[data-workspace]')!
  const content = panel.querySelector('[data-workspace-content]')!
  const host = panel.parentElement
  act(() => { useWorkspaceStore.getState().setLayout({ expanded: true }) })
  view.rerender(<Subject visible={false} />)
  view.rerender(<Subject />)
  act(() => { useWorkspaceStore.getState().setLayout({ collapsed: true }) })
  act(() => { useWorkspaceStore.getState().setLayout({ collapsed: false, expanded: false }) })
  await waitFor(() => expect(document.querySelector('[data-workspace-content]')).toBe(content))
  expect(document.querySelector('[data-workspace]')).toBe(panel)
  expect(panel.parentElement).toBe(host)
  expect(host).toHaveAttribute('data-workspace-host')
})
