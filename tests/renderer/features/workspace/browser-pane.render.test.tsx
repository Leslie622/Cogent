import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPane } from '@/features/workspace/BrowserPane'
import type { BrowserEvent, BrowserReservation, BrowserState } from '@shared/browser'

const previous = window.cogent
const observers = new Set<(event: BrowserEvent) => void>()
const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const state: BrowserState = { scopeId: 'draft', tabId: 'tab', lease: 'lease', generation: 1, url: '', title: '浏览器', favicon: null, loading: false, canGoBack: false, canGoForward: false, zoom: 1, error: null, crashed: false, active: true, held: false }
const reservation: BrowserReservation = { lease: 'lease', partition: 'test-partition', bootstrapUrl: 'about:blank#lease', state }
beforeEach(() => {
  observers.clear(); request.mockReset().mockImplementation(method => Promise.resolve(method === 'reserve' ? reservation : method === 'preferences' ? { search: 'bing' } : method === 'history' ? { entries: [], index: -1 } : state))
  window.cogent = { ...previous, browserRequest: request, onBrowserEvent: observer => { observers.add(observer); return () => { observers.delete(observer) } } } as typeof window.cogent
})
afterEach(() => { cleanup(); window.cogent = previous; vi.useRealTimers(); vi.restoreAllMocks() })
const emit = (event: BrowserEvent) => { for (const observer of observers) observer(event) }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function reserved(lease: string): BrowserReservation {
  return { ...reservation, lease, bootstrapUrl: 'about:blank#' + lease, state: { ...state, lease } }
}
const reply = (method: string) => Promise.resolve(method === 'preferences' ? { search: 'bing' } : method === 'history' ? { entries: [], index: -1 } : state)
async function attach(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
  const guest = container.querySelector<HTMLElement>('webview')!
  Object.assign(guest, { getWebContentsId: () => 100 })
  await act(async () => { fireEvent(guest, new Event('dom-ready')); await Promise.resolve() })
  await waitFor(() => expect(screen.getByLabelText('网页地址或搜索')).not.toBeDisabled())
  return guest
}
describe('BrowserPane 的原生资源接线', () => {
  it('工具图标hover沿用Hint，更多触发仍可点击且缩放三钮全部可用', async () => {
    const user = userEvent.setup(), view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={vi.fn()} />)
    await attach(view.container)
    const refresh = screen.getByRole('button', { name: '刷新网页' }), more = screen.getByRole('button', { name: '浏览器菜单' })
    expect(refresh).not.toHaveAttribute('title'); expect(more).not.toHaveAttribute('title')
    await user.hover(refresh)
    expect(await screen.findByText('刷新网页')).toHaveAttribute('data-slot', 'tooltip-content')
    await user.unhover(refresh)
    await waitFor(() => expect(screen.queryByText('刷新网页')).toBeNull())
    await user.hover(more)
    expect(await screen.findByText('浏览器菜单')).toHaveAttribute('data-slot', 'tooltip-content')
    await user.click(more)
    const menu = await screen.findByRole('menu'), zoom = within(menu).getByLabelText('网页缩放')
    expect(within(zoom).getByRole('button', { name: '缩小网页' })).toBeEnabled()
    expect(within(zoom).getByRole('button', { name: '放大网页' })).toBeEnabled()
    await user.click(within(zoom).getByRole('button', { name: '恢复网页缩放' }))
    expect(request).toHaveBeenCalledWith('zoom', { lease: 'lease', factor: 1 })
  })
  it('空白页显示浏览器引导，地址提交沿用真实导航，网页加载后移除空态', async () => {
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '浏览器' })).toBeInTheDocument()
    expect(screen.getByText('粘贴或输入 URL 以打开网页。')).toBeInTheDocument()
    expect(view.container.querySelector('[data-browser-empty] svg')).toBeInTheDocument()
    const navigation = view.container.querySelector<HTMLElement>('[data-browser-navigation]')!
    expect(within(navigation).getByLabelText('网页后退')).toBeInTheDocument()
    expect(within(navigation).getByLabelText('网页前进')).toBeInTheDocument()
    expect(within(navigation).getByLabelText('刷新网页')).toBeInTheDocument()
    await attach(view.container)
    const input = screen.getByRole('textbox', { name: '网页地址或搜索' })
    expect(input).toHaveAttribute('placeholder', '输入网址后回车')
    fireEvent.change(input, { target: { value: 'example.org' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(request).toHaveBeenCalledWith('navigate', { lease: 'lease', url: 'example.org' }))
    act(() => emit({ type: 'state', scopeId: 'draft', tabId: 'tab', state: { ...state, url: 'https://example.org/', title: '网页', loading: true } }))
    expect(view.container.querySelector('[data-browser-empty]')).toBeNull()
  })
  it('浏览历史收进更多子菜单后仍可键盘打开并回访，缩放与其他操作仍保留', async () => {
    request.mockImplementation(method => Promise.resolve(method === 'reserve' ? reservation : method === 'preferences' ? { search: 'bing' } : method === 'history' ? { entries: [{ url: 'https://first.test/', title: '第一站' }, { url: 'https://second.test/', title: '第二站' }], index: 1 } : state))
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active privateGroupId="temporary" onState={vi.fn()} />)
    await attach(view.container)
    const toolbar = view.container.querySelector<HTMLElement>('[data-browser-toolbar]')!
    expect(within(toolbar).queryByRole('button', { name: '网页浏览历史' })).toBeNull()
    fireEvent.click(screen.getByLabelText('浏览器菜单'))
    expect(await screen.findByText('临时浏览 · 不保留登录与历史')).toBeInTheDocument()
    expect(screen.getByText('页面内查找')).toBeInTheDocument()
    expect(screen.getByText('下载')).toBeInTheDocument()
    expect(screen.getByText('站点权限')).toBeInTheDocument()
    expect(screen.getByLabelText('网页缩放')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('放大网页'))
    await waitFor(() => expect(request).toHaveBeenCalledWith('zoom', { lease: 'lease', factor: 1.1 }))
    const history = screen.getByRole('menuitem', { name: '网页浏览历史' })
    act(() => { history.focus() })
    fireEvent.keyDown(history, { key: 'ArrowRight' })
    fireEvent.click(await screen.findByText('第一站'))
    await waitFor(() => expect(request).toHaveBeenCalledWith('goTo', { lease: 'lease', index: 0 }))
    expect(request).toHaveBeenCalledWith('history', { lease: 'lease' })
  })
  it('attach前禁用地址栏；draft晋升session不重建webview/lease', async () => {
    const onState = vi.fn()
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={onState} />)
    expect(screen.getByLabelText('网页地址或搜索')).toBeDisabled()
    const guest = await attach(view.container)
    view.rerender(<BrowserPane scopeId="session" tabId="tab" active={false} onState={onState} />)
    expect(view.container.querySelector('webview')).toBe(guest)
    expect(request.mock.calls.filter(([method]) => method === 'reserve')).toHaveLength(1)
    view.unmount()
    expect(request).toHaveBeenCalledWith('release', { lease: 'lease' })
    expect(observers.size).toBe(0)
  })
  it('初次HTML只请求一次，Host恢复的新lease在同guest中重载', async () => {
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active previewLeaseId="file-old" onState={vi.fn()} />)
    const guest = await attach(view.container)
    await waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'preview')).toEqual([['preview', { lease: 'lease', source: { leaseId: 'file-old' } }]]))
    view.rerender(<BrowserPane scopeId="session" tabId="tab" active previewLeaseId="file-new" onState={vi.fn()} />)
    await waitFor(() => expect(request).toHaveBeenCalledWith('preview', { lease: 'lease', source: { leaseId: 'file-new' } }))
    expect(view.container.querySelector('webview')).toBe(guest)
    expect(request.mock.calls.filter(([method]) => method === 'preview')).toHaveLength(2)
  })
  it('attach在卸载后返回，不继续更新可见性或发起导航', async () => {
    let attached!: (value: BrowserState) => void
    request.mockImplementation(method => method === 'attach' ? new Promise<BrowserState>(resolve => { attached = resolve }) : Promise.resolve(method === 'reserve' ? reservation : state))
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active url="https://example.org" onState={vi.fn()} />)
    await waitFor(() => expect(view.container.querySelector('webview')).not.toBeNull())
    const guest = view.container.querySelector<HTMLElement>('webview')!
    Object.assign(guest, { getWebContentsId: () => 100 })
    act(() => { fireEvent(guest, new Event('dom-ready')) })
    expect(request).toHaveBeenCalledWith('attach', { lease: 'lease', webContentsId: 100 })
    view.unmount()
    await act(async () => { attached(state); await Promise.resolve() })
    expect(request.mock.calls.some(([method]) => ['visibility', 'preferences', 'navigate'].includes(method))).toBe(false)
    expect(request).toHaveBeenCalledWith('release', { lease: 'lease' })
  })
  it('原生guest已释放后切换前后台，不向旧lease发送可见性请求', async () => {
    const released = vi.fn()
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={vi.fn()} onReleased={released} />)
    await attach(view.container)
    act(() => emit({ type: 'released', scopeId: 'draft', tabId: 'tab', lease: 'lease' }))
    request.mockClear()
    view.rerender(<BrowserPane scopeId="draft" tabId="tab" active={false} onState={vi.fn()} onReleased={released} />)
    await act(async () => { await Promise.resolve() })
    expect(request).not.toHaveBeenCalledWith('visibility', expect.anything())
    expect(released).toHaveBeenCalledOnce()
  })
  it('本地原件可从浏览器菜单显式选择资源目录', async () => {
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active previewLeaseId="file-html" allowPreviewRoot onState={vi.fn()} />)
    await attach(view.container)
    fireEvent.click(screen.getByLabelText('浏览器菜单'))
    fireEvent.click(await screen.findByText('选择资源目录…'))
    await waitFor(() => expect(request).toHaveBeenCalledWith('preview', { lease: 'lease', source: { leaseId: 'file-html' }, pickRoot: true }))
  })
  it('alert/confirm使用有归属的Dialog，后台不保留模态锁，取消事件收起旧请求', async () => {
    const onState = vi.fn(), view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={onState} />)
    await attach(view.container)
    act(() => emit({ type: 'prompt', scopeId: 'draft', tabId: 'tab', requestId: 'alert', kind: 'alert', message: '网页提示测试', defaultValue: '' }))
    expect(await screen.findByText('网页提示测试')).toBeInTheDocument()
    expect(screen.queryByLabelText('网页输入内容')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('promptReply', { lease: 'lease', requestId: 'alert', value: 'accepted' }))
    act(() => emit({ type: 'prompt', scopeId: 'draft', tabId: 'tab', requestId: 'confirm', kind: 'confirm', message: '确认测试', defaultValue: '' }))
    expect(await screen.findByText('确认测试')).toBeInTheDocument()
    view.rerender(<BrowserPane scopeId="draft" tabId="tab" active={false} onState={onState} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    view.rerender(<BrowserPane scopeId="draft" tabId="tab" active onState={onState} />)
    expect(await screen.findByText('确认测试')).toBeInTheDocument()
    act(() => emit({ type: 'prompt-cancel', scopeId: 'draft', tabId: 'tab', requestId: 'confirm' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
  it('身份验证双输入只回复临时凭据，确认后清空UI内容', async () => {
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={vi.fn()} />)
    const guest = await attach(view.container)
    expect(guest.style.backgroundColor).toBe('rgb(255, 255, 255)')
    act(() => emit({ type: 'prompt', scopeId: 'draft', tabId: 'tab', requestId: 'auth', kind: 'authentication', message: '网站：example.test:443', defaultValue: '' }))
    fireEvent.change(await screen.findByLabelText('身份验证用户名'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('身份验证密码'), { target: { value: 'test-secret' } })
    expect(screen.getByLabelText('身份验证密码')).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('promptReply', { lease: 'lease', requestId: 'auth', value: JSON.stringify({ username: 'user', password: 'test-secret' }) }))
    await waitFor(() => expect(screen.queryByLabelText('身份验证密码')).not.toBeInTheDocument())
  })

  it('StrictMode两次reserve拥有独立lease，迟到旧代只释放旧lease且不销毁当前guest', async () => {
    const first = deferred<BrowserReservation>(), second = deferred<BrowserReservation>()
    const old = reserved('strict-old'), current = reserved('strict-current')
    let reserves = 0
    request.mockImplementation(method => method === 'reserve' ? (++reserves === 1 ? first.promise : second.promise) : reply(method))
    const view = render(<StrictMode><BrowserPane scopeId="draft" tabId="tab" active url="https://example.org" onState={vi.fn()} /></StrictMode>)
    expect(reserves).toBe(2)
    await act(async () => { second.resolve(current); await Promise.resolve() })
    const guest = await attach(view.container)
    await act(async () => { first.resolve(old); await Promise.resolve() })
    expect(request).toHaveBeenCalledWith('release', { lease: old.lease })
    expect(request).not.toHaveBeenCalledWith('release', { lease: current.lease })
    expect(request).toHaveBeenCalledWith('attach', { lease: current.lease, webContentsId: 100 })
    expect(view.container.querySelector('webview')).toBe(guest)
    expect(screen.getByLabelText('网页地址或搜索')).not.toBeDisabled()
    view.unmount()
    expect(request).toHaveBeenCalledWith('release', { lease: current.lease })
    expect(observers.size).toBe(0)
  })

  it('attach失败不伪造ready或并发重复握手，重试真正释放旧代并创建新guest', async () => {
    const oldAttach = deferred<BrowserState>(), old = reserved('attach-old'), current = reserved('attach-current')
    let reserves = 0
    request.mockImplementation((method, params) => {
      if (method === 'reserve') return Promise.resolve(++reserves === 1 ? old : current)
      if (method === 'attach' && (params as { lease: string }).lease === old.lease) return oldAttach.promise
      return reply(method)
    })
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={vi.fn()} />)
    await waitFor(() => expect(view.container.querySelector('webview')).not.toBeNull())
    const oldGuest = view.container.querySelector<HTMLElement>('webview')!
    Object.assign(oldGuest, { getWebContentsId: () => 101 })
    act(() => { fireEvent(oldGuest, new Event('dom-ready')); fireEvent(oldGuest, new Event('dom-ready')) })
    expect(request.mock.calls.filter(([method]) => method === 'attach')).toHaveLength(1)
    expect(screen.getByLabelText('网页地址或搜索')).toBeDisabled()
    await act(async () => { oldAttach.reject(new Error('测试附加失败')); await Promise.resolve() })
    expect(screen.getByRole('alert')).toHaveTextContent('测试附加失败')
    act(() => { fireEvent(oldGuest, new Event('dom-ready')) })
    expect(screen.getByLabelText('网页地址或搜索')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^重试$/ }))
    const guest = await attach(view.container)
    expect(guest).not.toBe(oldGuest); expect(oldGuest.isConnected).toBe(false)
    expect(request).toHaveBeenCalledWith('release', { lease: old.lease })
    expect(request).toHaveBeenCalledWith('attach', { lease: current.lease, webContentsId: 100 })
    expect(request.mock.calls.some(([method]) => method === 'reload')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('bootstrap没有dom-ready在15秒明确报错，重试新guest成功后取消截止计时', async () => {
    vi.useFakeTimers()
    const old = reserved('bootstrap-old'), current = reserved('bootstrap-current')
    let reserves = 0
    request.mockImplementation(method => method === 'reserve' ? Promise.resolve(++reserves === 1 ? old : current) : reply(method))
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    const oldGuest = view.container.querySelector<HTMLElement>('webview')!
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(screen.getByRole('alert')).toHaveTextContent('网页启动超时，未收到就绪信号')
    expect(screen.getByLabelText('网页地址或搜索')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^重试$/ }))
    await act(async () => { await Promise.resolve() })
    const guest = view.container.querySelector<HTMLElement>('webview')!
    expect(guest).not.toBe(oldGuest); expect(oldGuest.isConnected).toBe(false)
    Object.assign(guest, { getWebContentsId: () => 102 })
    await act(async () => { fireEvent(guest, new Event('dom-ready')); await Promise.resolve() })
    expect(screen.getByLabelText('网页地址或搜索')).not.toBeDisabled()
    expect(request).toHaveBeenCalledWith('release', { lease: old.lease })
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(request.mock.calls.filter(([method]) => method === 'reserve')).toHaveLength(2)
  })

  it.each(['reserve', 'attach', 'visibility'] as const)('%s握手挂起15秒后报错，迟到成功不能恢复ready或继续导航', async phase => {
    vi.useFakeTimers()
    const pending = deferred<BrowserReservation | BrowserState>()
    request.mockImplementation(method => method === phase ? pending.promise : method === 'reserve' ? Promise.resolve(reservation) : reply(method))
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active url="https://example.org" onState={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    if (phase !== 'reserve') {
      const guest = view.container.querySelector<HTMLElement>('webview')!
      Object.assign(guest, { getWebContentsId: () => 103 })
      await act(async () => { fireEvent(guest, new Event('dom-ready')); await Promise.resolve() })
    }
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(screen.getByRole('alert')).toHaveTextContent('超时')
    await act(async () => { pending.resolve(phase === 'reserve' ? reservation : state); await Promise.resolve() })
    expect(screen.getByLabelText('网页地址或搜索')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('超时')
    expect(request.mock.calls.some(([method]) => ['preferences', 'navigate', 'restore'].includes(method))).toBe(false)
    if (phase === 'reserve') {
      expect(view.container.querySelector('webview')).toBeNull()
      expect(request).toHaveBeenCalledWith('release', { lease: reservation.lease })
    }
  })

  it('真卸载时取消截止计时，迟到reserve只释放自己的lease且不复活guest', async () => {
    vi.useFakeTimers()
    const pending = deferred<BrowserReservation>(), onState = vi.fn()
    request.mockImplementation(method => method === 'reserve' ? pending.promise : reply(method))
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active url="https://example.org" onState={onState} />)
    view.unmount()
    await act(async () => { vi.advanceTimersByTime(30_000); pending.resolve(reserved('unmounted')); await Promise.resolve() })
    expect(request.mock.calls.map(([method]) => method)).toEqual(['reserve', 'release'])
    expect(request).toHaveBeenCalledWith('release', { lease: 'unmounted' })
    expect(view.container.querySelector('webview')).toBeNull()
    expect(onState).not.toHaveBeenCalled(); expect(observers.size).toBe(0)
  })

  it('已就绪网页加载错误仍在原guest中reload，不重新reserve', async () => {
    const view = render(<BrowserPane scopeId="draft" tabId="tab" active onState={vi.fn()} />)
    const guest = await attach(view.container)
    act(() => emit({ type: 'state', scopeId: 'draft', tabId: 'tab', state: { ...state, error: '测试网页加载失败' } }))
    expect(screen.getByRole('alert')).toHaveTextContent('测试网页加载失败')
    fireEvent.click(screen.getByRole('button', { name: /^重试$/ }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('reload', { lease: reservation.lease }))
    expect(view.container.querySelector('webview')).toBe(guest)
    expect(request.mock.calls.filter(([method]) => method === 'reserve')).toHaveLength(1)
  })
})
