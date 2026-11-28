import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore, EMPTY_WORKSPACE } from '@/stores/workspace'
import { WorkspaceTabs } from '@/features/workspace/WorkspaceTabs'
import { closeWorkspaceTab, closeWorkspaceTabs, registerTabClose, releaseHeldTab, useWorkspaceRuntime } from '@/features/workspace/runtime'
import { useChatStore } from '@/stores/chat'
function Subject({ expanded = false, tools = false }: { expanded?: boolean; tools?: boolean }) {
  const scope = useWorkspaceStore(s => Object.entries(s.scopes).find(([id]) => id === 's')?.[1] ?? EMPTY_WORKSPACE)
  return <WorkspaceTabs tabs={scope.tabs} activeId={scope.activeId} expanded={expanded} tools={tools} onError={vi.fn()} />
}
const cleanups: Array<() => void> = []
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); useWorkspaceStore.getState().reset(); useWorkspaceStore.getState().setScope('s'); useWorkspaceRuntime.setState({ held: {} }) })
afterEach(() => { cleanup(); cleanups.splice(0).forEach(fn => fn()); useWorkspaceStore.getState().reset(); useWorkspaceRuntime.setState({ held: {} }); vi.unstubAllGlobals() })
describe('标签条及关闭协商', () => {
  it('从任意活动页新建都追加在末尾，拖动后的既有顺序保持不变', () => {
    const store = useWorkspaceStore.getState()
    const first = store.newTab(), second = store.newTab(), third = store.newTab()
    store.reorder('s', [third, first, second])
    store.activate(third)
    render(<Subject />)
    fireEvent.click(screen.getByRole('button', { name: '新建标签页' }))
    const scope = useWorkspaceStore.getState().scopes.s
    expect(scope.tabs.map(tab => tab.id)).toEqual([third, first, second, scope.activeId])
    expect(screen.getAllByRole('tab').map(tab => tab.id)).toEqual(scope.tabs.map(tab => 'workspace-tab-' + tab.id))
    expect(screen.getAllByRole('tab').at(-1)).toHaveAttribute('aria-selected', 'true')
  })

  it('活动页显露仅调整标签条滚动，不调用祖先滚动', () => {
    const store = useWorkspaceStore.getState()
    const first = store.newTab(), second = store.newTab()
    store.activate(first)
    render(<Subject />)
    const list = screen.getByRole('tablist'), tab = document.getElementById('workspace-tab-' + second)!.parentElement!
    const rect = (left: number, right: number) => ({ left, right, width: right - left, height: 32, top: 0, bottom: 32, x: left, y: 0, toJSON: () => ({}) })
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(100, 300))
    vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(rect(280, 456))
    act(() => store.activate(second))
    expect(list.scrollLeft).toBe(156)
    expect(list.parentElement!.scrollLeft).toBe(0)
  })

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
  it('并排与收起态的开关不在标签头（在对话头，给窗口三钮让位）；占满时标签头右端接管恢复并排与收起', () => {
    useWorkspaceStore.getState().newTab()
    render(<Subject />)
    expect(screen.queryByRole('button', { name: '展开工作区' })).toBeNull()
    expect(screen.queryByRole('button', { name: '收起工作区' })).toBeNull()
    cleanup()
    useWorkspaceStore.getState().setLayout({ expanded: true })
    render(<Subject expanded tools />)
    // 两枚开关在标签头右端，排在列表 / 标签 / 新建之后
    const header = screen.getByRole('button', { name: '恢复并排' }).closest('[data-workspace-header]')!
    expect([...header.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label')).slice(-3))
      .toEqual(['新建标签页', '恢复并排', '收起工作区'])
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
  it('标签条每组一个胶囊、标签项都是行；头部「占满 / 收起」两钮（占满时在右端）一组，新建钮不入组', () => {
    useWorkspaceStore.getState().openBrowser('https://a.test')
    useWorkspaceStore.getState().newTab()
    const { container } = render(<Subject />)
    const tablist = screen.getByRole('tablist', { name: '工作区标签页' })
    expect(tablist).toHaveClass('relative', 'isolate')
    expect(tablist.firstElementChild).toHaveClass('hover-slide-pill')
    // 标签条里除胶囊与标签项外不得有任何文本节点（JSX 子节点位置的 /* */ 会渲染成文字，2026-11-28 实录）
    expect([...tablist.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')).toEqual([])
    // 标签项是 ContextMenuTrigger 的渲染元素（Base UI 会把 data-slot 改写成自己的），按行标记找
    const items = [...tablist.querySelectorAll<HTMLElement>('[data-hover-slide]')]
    // 活动标签不是行（底色靠 :has([data-active]) 落在整项上，副本读不出）；其余标签项都是行
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveClass('hover:bg-(--chrome-hover)', 'has-data-active:bg-(--chrome-active)')
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    const header = container.querySelector('[data-workspace-header]') as HTMLElement
    expect(header).toHaveClass('relative', 'isolate')
    expect(header.firstElementChild).toHaveClass('hover-slide-pill')
    expect(screen.getByRole('button', { name: '新建标签页' })).not.toHaveAttribute('data-hover-slide')
    expect(container.querySelectorAll('.hover-slide-pill')).toHaveLength(2)
    cleanup()
    const expanded = render(<Subject expanded tools />)
    const expandedHeader = expanded.container.querySelector('[data-workspace-header]') as HTMLElement
    expect(expandedHeader.firstElementChild).toHaveClass('hover-slide-pill')
    expect(expanded.getByRole('button', { name: '恢复并排' })).toHaveAttribute('data-hover-slide')
    expect(expanded.getByRole('button', { name: '收起工作区' })).toHaveAttribute('data-hover-slide')
    expect(expanded.container.querySelectorAll('.hover-slide-pill')).toHaveLength(2)
  })
})
