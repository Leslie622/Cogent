import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore, EMPTY_WORKSPACE } from '@/stores/workspace'
import { WorkspaceTabs } from '@/features/workspace/WorkspaceTabs'
import { closeWorkspaceTab, closeWorkspaceTabs, registerTabClose, releaseHeldTab, useWorkspaceRuntime } from '@/features/workspace/runtime'
import { useChatStore } from '@/stores/chat'
function Subject() {
  const scope = useWorkspaceStore(s => Object.entries(s.scopes).find(([id]) => id === 's')?.[1] ?? EMPTY_WORKSPACE)
  return <WorkspaceTabs tabs={scope.tabs} activeId={scope.activeId} onError={vi.fn()} />
}
const cleanups: Array<() => void> = []
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); useWorkspaceStore.getState().reset(); useWorkspaceStore.getState().setScope('s'); useWorkspaceRuntime.setState({ held: {} }) })
afterEach(() => { cleanup(); cleanups.splice(0).forEach(fn => fn()); useWorkspaceStore.getState().reset(); useWorkspaceRuntime.setState({ held: {} }); vi.unstubAllGlobals() })
describe('标签条及关闭协商', () => {
  it('批量关闭仅提交快照内标签，不误关等待网页确认时新建的标签', async () => {
    const store = useWorkspaceStore.getState()
    store.newTab(); store.newTab()
    const browser = store.openBrowser('https://a.test')
    for (let i = 0; i < 98; i++) store.newTab()
    let confirm!: (result: { closed: boolean; keepMounted: boolean }) => void
    cleanups.push(registerTabClose(browser, () => new Promise(done => { confirm = done })))
    const ids = useWorkspaceStore.getState().scopes.s.tabs.map(tab => tab.id)
    const pending = closeWorkspaceTabs(ids)
    const fresh = store.newTab()
    confirm({ closed: true, keepMounted: false })
    expect(await pending).toBe(true)
    expect(useWorkspaceStore.getState().scopes.s.tabs.map(tab => tab.id)).toEqual([fresh])
  })
  it('可访问Tabs语义保留，拖动属性不覆盖role/roving tabindex，关闭钮是同级元素', async () => {
    const a = useWorkspaceStore.getState().openBrowser('https://a.test')
    const b = useWorkspaceStore.getState().openBrowser('https://b.test')
    render(<Subject />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('tabindex', '-1')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('button button')).toBeNull()
    fireEvent.click(tabs[0])
    expect(useWorkspaceStore.getState().scopes.s.activeId).toBe(a)
    fireEvent.click(screen.getByRole('button', { name: '关闭 https://b.test' }))
    await waitFor(() => expect(useWorkspaceStore.getState().scopes.s.tabs.some(t => t.id === b)).toBe(false))
    expect(useWorkspaceStore.getState().scopes.s.activeId).toBe(a)
  })
  it('可搜索标签、直接激活，列表关闭后台页不误切当前页', async () => {
    const store = useWorkspaceStore.getState()
    const alpha = store.openBrowser('https://alpha.test')
    const beta = store.openBrowser('https://beta.test')
    render(<Subject />)
    fireEvent.click(screen.getByRole('button', { name: '标签页列表' }))
    const input = await screen.findByRole('textbox', { name: '搜索标签页' })
    const row = screen.getByRole('button', { name: 'https://alpha.test' }).closest('[data-slot=item]')!
    expect(row.querySelector('[data-slot=item-content] button')).toBeNull()
    expect(row.querySelector('[data-slot=item-actions]')).toHaveTextContent('')
    expect(row.querySelector('button button')).toBeNull()
    fireEvent.change(input, { target: { value: 'alpha' } })
    expect(screen.queryByRole('button', { name: '在列表中关闭 https://beta.test' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'https://alpha.test' }))
    expect(useWorkspaceStore.getState().scopes.s.activeId).toBe(alpha)
    fireEvent.click(screen.getByRole('button', { name: '标签页列表' }))
    fireEvent.click(await screen.findByRole('button', { name: '在列表中关闭 https://beta.test' }))
    await waitFor(() => expect(useWorkspaceStore.getState().scopes.s.tabs.some(tab => tab.id === beta)).toBe(false))
    expect(useWorkspaceStore.getState().scopes.s.activeId).toBe(alpha)
  })
  it('同一标签行可占满、恢复并排和收起，不依赖窗口宽度', () => {
    useWorkspaceStore.getState().newTab()
    const view = render(<Subject />)
    fireEvent.click(screen.getByRole('button', { name: '展开工作区' }))
    expect(useWorkspaceStore.getState().scopes.s.expanded).toBe(true)
    view.rerender(<WorkspaceTabs tabs={useWorkspaceStore.getState().scopes.s.tabs} activeId={useWorkspaceStore.getState().scopes.s.activeId} expanded onError={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复并排' }))
    expect(useWorkspaceStore.getState().scopes.s.expanded).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '收起工作区' }))
    expect(useWorkspaceStore.getState().scopes.s.collapsed).toBe(true)
  })
  it('关闭按钮卸载后焦点交给存活标签，列表关闭后继续留在搜索框', async () => {
    const store = useWorkspaceStore.getState()
    store.openBrowser('https://alpha.test')
    store.openBrowser('https://beta.test')
    render(<Subject />)
    const close = screen.getByRole('button', { name: '关闭 https://beta.test' })
    act(() => close.focus())
    fireEvent.click(close)
    await waitFor(() => expect(screen.getByRole('tab', { selected: true })).toHaveFocus())
    act(() => { store.openBrowser('https://gamma.test') })
    fireEvent.click(screen.getByRole('button', { name: '标签页列表' }))
    const listClose = await screen.findByRole('button', { name: '在列表中关闭 https://alpha.test' })
    act(() => listClose.focus())
    fireEvent.click(listClose)
    await waitFor(() => expect(screen.getByRole('textbox', { name: '搜索标签页' })).toHaveFocus())
  })
  it('beforeunload取消不删描述，多次关闭共享同一次协商', async () => {
    const id = useWorkspaceStore.getState().openBrowser('https://a.test')
    let resolve!: (result: { closed: boolean; keepMounted: boolean }) => void
    const close = vi.fn(() => new Promise<{ closed: boolean; keepMounted: boolean }>(done => { resolve = done }))
    cleanups.push(registerTabClose(id, close))
    const a = closeWorkspaceTab(id), b = closeWorkspaceTab(id)
    expect(a).toBe(b); expect(close).toHaveBeenCalledTimes(1)
    resolve({ closed: false, keepMounted: false })
    expect(await a).toBe(false)
    expect(useWorkspaceStore.getState().scopes.s.tabs[0].id).toBe(id)
  })
  it('继续下载只移除标签头，独立hold收到released才卸载', async () => {
    const id = useWorkspaceStore.getState().openBrowser('https://a.test')
    cleanups.push(registerTabClose(id, () => Promise.resolve({ closed: true, keepMounted: true })))
    await closeWorkspaceTab(id)
    expect(useWorkspaceStore.getState().scopes.s.tabs).toHaveLength(0)
    expect(useWorkspaceRuntime.getState().held[id].id).toBe(id)
    releaseHeldTab(id)
    expect(Object.keys(useWorkspaceRuntime.getState().held)).toHaveLength(0)
  })
  it('网页取消关闭时不请求删除Host会话', async () => {
    const id = useWorkspaceStore.getState().openBrowser('https://a.test')
    cleanups.push(registerTabClose(id, () => Promise.resolve({ closed: false, keepMounted: false })))
    const request = vi.fn().mockResolvedValue({ ok: true })
    window.cogent = { engineRequest: request } as unknown as typeof window.cogent
    await useChatStore.getState().deleteSession('s')
    expect(request).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().scopes.s.tabs[0].id).toBe(id)
  })
})

describe('标签条与头部按钮的悬停滑动装配', () => {
  it('标签条每组一个胶囊、标签项都是行；头部「展开 / 收起」两钮一组，新建钮隔着留白不入组', () => {
    useWorkspaceStore.getState().openBrowser('https://a.test')
    useWorkspaceStore.getState().newTab()
    const { container } = render(<Subject />)
    const tablist = screen.getByRole('tablist', { name: '工作区标签页' })
    expect(tablist).toHaveClass('relative', 'isolate')
    expect(tablist.firstElementChild).toHaveClass('hover-slide-pill')
    // 标签项是 ContextMenuTrigger 的渲染元素（Base UI 会把 data-slot 改写成自己的），按行标记找
    const items = [...tablist.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    // 活动标签不是行（底色靠 :has([data-active]) 落在整项上，副本读不出）；其余标签项都是行
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveClass('hover:bg-muted/60', 'has-data-active:bg-muted')
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    const header = container.querySelector('[data-workspace-header]') as HTMLElement
    expect(header).toHaveClass('relative', 'isolate')
    expect(header.firstElementChild).toHaveClass('hover-slide-pill')
    expect(screen.getByRole('button', { name: '新建标签页' })).not.toHaveAttribute('data-hover-slide')
    expect(screen.getByRole('button', { name: '展开工作区' })).toHaveAttribute('data-hover-slide')
    expect(screen.getByRole('button', { name: '收起工作区' })).toHaveAttribute('data-hover-slide')
    expect(container.querySelectorAll('.hover-slide-pill')).toHaveLength(2)
  })
})
