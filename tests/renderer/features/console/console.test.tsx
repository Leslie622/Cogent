/** 控制台回归：布局分区、过滤后的真实终态、JSON 留存原文与初载竞态。 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsoleApp } from '@/features/console/ConsoleApp'
import { ConsoleSidebar } from '@/features/console/ConsoleSidebar'
import { useAppearanceStore } from '@/stores/appearance'
import { ConsoleDetail } from '@/features/console/ConsoleDetail'
import { ConsoleTimeline } from '@/features/console/ConsoleTimeline'
import { DetailBlock } from '@/features/console/DetailBlock'
import { useConsoleStore } from '@/stores/console'
import type { InspectEntrySummary } from '@/env.d'

// CodeMirror 的浏览器几何与折叠另由 console.browser 页面验收；这里只钉容器行为。
vi.mock('@/components/InspectCodeViewer', () => ({ default: ({ content, render: renderBlock }: { content: string; render: (controls: ReactNode, body: ReactNode) => ReactNode }) => renderBlock(null, <pre>{content}</pre>) }))
const initial = useConsoleStore.getState()
const entry = (seq: number, kind: InspectEntrySummary['kind'] = 'turn.completed'): InspectEntrySummary => ({
  seq, kind, ts: 1234, run: 1, title: kind, hasDetail: false,
})
beforeEach(() => useConsoleStore.setState(initial, true))
afterEach(() => { useConsoleStore.setState(initial, true); vi.unstubAllGlobals() })

describe('控制台阅读与真实状态', () => {
  it('assistant 数据优先，元信息集中收起，数据块可独立展开', async () => {
    useConsoleStore.setState({
      sessionId: 'one', selectedSeq: 1,
      entries: [{ ...entry(1), hasDetail: true, overview: [{ label: '输入 tokens', value: '123' }] }],
      details: { 1: { seq: 1, blocks: [{ name: 'assistant 消息', format: 'json', content: '{"role":"assistant","content":[{"type":"text","text":"answer"}]}' }] } },
    })
    render(<ConsoleDetail />)
    expect(screen.getByRole('button', { name: '记录信息' })).toHaveAttribute('aria-expanded', 'false')
    expect(await screen.findByText('answer')).toBeVisible()
    expect(screen.getByRole('button', { name: 'assistant 消息' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: '记录信息' }))
    expect(await screen.findByText('输入 tokens')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '完整回复' }))
    await waitFor(() => expect(screen.getByText('answer')).not.toBeVisible())
    expect(screen.getByText('输入 tokens')).toBeVisible()
  })

  it('旧 run 完成条目拉取最后一轮，完整回复可复制，思考和 JSON 默认收起', async () => {
    const text = '`![图片](图片.png)`\n`[未随附](未随附.txt)`'
    const detail = { seq: 49, blocks: [{ name: 'assistant 消息（pi 归一化终态）', format: 'json', content: JSON.stringify({
      role: 'assistant', content: [{ type: 'thinking', thinking: '推理内容' }, { type: 'text', text }],
    }) }] }
    const request = vi.fn().mockResolvedValue(detail)
    Object.defineProperty(window, 'cogent', { configurable: true, value: { engineRequest: request } })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    useConsoleStore.setState({ sessionId: 'old', entries: [{ ...entry(49), hasDetail: true }, entry(50, 'run.completed')] })
    await useConsoleStore.getState().selectEntry(50)
    expect(request).toHaveBeenCalledWith('inspect.entry', { sessionId: 'old', seq: 49 })
    render(<ConsoleDetail />)
    const result = await screen.findByRole('button', { name: '完整回复' })
    expect(result).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '思考内容' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'assistant 消息' })).toHaveAttribute('aria-expanded', 'false')
    const section = result.closest('[data-slot="collapsible"]')!
    expect(section.textContent).toContain(text)
    fireEvent.click(within(section as HTMLElement).getByRole('button', { name: '复制' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text))
    await useConsoleStore.getState().selectEntry(49)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('完成入口的源详情缺失可见；迟到的失败不能覆盖新选中条目', async () => {
    let reject!: (error: Error) => void
    const request = vi.fn(() => new Promise((_resolve, fail) => { reject = fail }))
    Object.defineProperty(window, 'cogent', { configurable: true, value: { engineRequest: request } })
    useConsoleStore.setState({ sessionId: 'old', entries: [entry(1, 'run.started'), { ...entry(49), hasDetail: true }, entry(50, 'run.completed')] })
    const load = useConsoleStore.getState().selectEntry(50)
    reject(new Error('详情已滚动丢弃'))
    await load
    render(<ConsoleDetail />)
    expect(screen.getByRole('alert')).toHaveTextContent('详情已滚动丢弃')
    let pending!: Promise<void>
    act(() => { pending = useConsoleStore.getState().selectEntry(50) })
    await act(() => useConsoleStore.getState().selectEntry(1))
    await act(async () => { reject(new Error('旧错误')); await pending })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('该条目没有详情数据（概览即全部）。')).toBeVisible()
  })

  it('隐藏会话层后仍显示已完成；没有终态的历史不猜成进行中；run 可折叠', () => {
    useConsoleStore.setState({ sessionId: 'one', entries: [entry(1, 'run.started'), entry(2), entry(3, 'run.completed')], layers: { ...initial.layers, session: false } })
    render(<ConsoleTimeline />)
    expect(screen.getByText('完成')).toBeVisible()
    expect(screen.getByRole('button', { name: /Run #1/ })).toContainElement(screen.getByText('完成'))
    expect(screen.queryByText('进行中')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Run #1/ }))
    expect(screen.getByRole('button', { name: /Run #1/ })).toHaveAttribute('aria-expanded', 'false')
    act(() => useConsoleStore.setState({ entries: [entry(1, 'run.started'), entry(2)] }))
    expect(screen.getByText('未见终态')).toBeVisible()
    expect(screen.queryByText('进行中')).not.toBeInTheDocument()
    act(() => useConsoleStore.setState({ entries: [entry(1, 'run.started'), entry(2), entry(3, 'run.failed')] }))
    expect(screen.getByText('失败')).toBeVisible()
  })

  it('复制与原文视图保留大整数、转义和截断现场，复制失败可见', async () => {
    const content = '{"id":9007199254740993,"text":"\\n"}\n…[已截断，原始 400000 字符]'
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<DetailBlock block={{ name: '请求体', format: 'json', content }} />)
    expect((await screen.findByText(/9007199254740993/)).textContent).toBe(content)
    expect(screen.getByText(/此块已在采集时截断/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(content))
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(await screen.findByText('复制失败：denied')).toBeVisible()
  })

  it('初载快照晚于实时条目时合并历史并去重，顺序仍按 seq', async () => {
    let resolve!: (value: { entries: InspectEntrySummary[] }) => void
    const pending = new Promise<{ entries: InspectEntrySummary[] }>((done) => { resolve = done })
    vi.stubGlobal('window', { cogent: { engineRequest: vi.fn(() => pending) } })
    const load = useConsoleStore.getState().selectSession('one')
    useConsoleStore.getState().applyEntry('one', entry(3))
    resolve({ entries: [entry(1, 'run.started'), entry(2), entry(3)] })
    await load
    expect(useConsoleStore.getState().entries.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('会话选择失败可重试，同一会话旧请求晚到不覆盖新时间线', async () => {
    let failOld!: (error: Error) => void
    const old = new Promise<never>((_resolve, reject) => { failOld = reject })
    const request = vi.fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({ entries: [entry(5)] })
      .mockRejectedValueOnce(new Error('读取失败'))
      .mockResolvedValueOnce({ entries: [entry(1), entry(2)] })
    vi.stubGlobal('window', { cogent: { engineRequest: request } })
    const store = useConsoleStore.getState()
    const first = store.selectSession('one')
    await store.selectSession('two')
    await store.selectSession('one')
    expect(useConsoleStore.getState().entriesError).toBe('读取失败')
    store.applyEntry('one', entry(3))
    await store.selectSession('one')
    failOld(new Error('已失效的读取'))
    await first
    expect(useConsoleStore.getState().entriesError).toBeNull()
    expect(useConsoleStore.getState().entries.map(item => item.seq)).toEqual([1, 2, 3])
  })
})

describe('控制台悬停滑动装配', () => {
  function mountApp() {
    // react-resizable-panels 挂载即查 ResizeObserver（jsdom 没有）
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    // 本文件的 window.cogent 只读（setup 定义），按全局桩挂
    vi.stubGlobal('cogent', {
      engineRequest: vi.fn((method: string) => Promise.resolve(method.endsWith('.list') ? [] : null)),
      onEngineEvent: () => () => {},
      onWindowState: () => () => {},
      minimizeWindow: vi.fn(),
      toggleMaximizeWindow: vi.fn(),
      closeWindow: vi.fn(),
    })
    return render(<ConsoleApp />)
  }

  it('会话行一组（当前会话行自带底色），时间线条目每组一张列表一组；原 hover 类未动', () => {
    useConsoleStore.setState({
      sessions: [{ id: 'one', title: '会话一', createdAt: 1, updatedAt: 1 }, { id: 'two', title: '会话二', createdAt: 1, updatedAt: 1 }],
      sessionId: 'one',
      entries: [entry(1, 'run.started'), entry(2)],
    })
    const { container } = render(
      <>
        <ConsoleSidebar />
        <ConsoleTimeline />
      </>
    )
    const sessionList = screen.getByRole('button', { name: '会话一' }).closest('ul')!
    expect(sessionList).toHaveClass('relative', 'isolate')
    expect(sessionList.firstElementChild).toHaveClass('hover-slide-pill')
    expect(sessionList.querySelectorAll('[data-hover-slide]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '会话一' })).toHaveClass('bg-foreground/5')
    expect(screen.getByRole('button', { name: '会话二' })).toHaveClass('hover:bg-foreground/5')
    const timeline = container.querySelector('ul.rounded-lg.border') as HTMLElement
    expect(timeline).toHaveClass('relative', 'isolate')
    expect(timeline.firstElementChild).toHaveClass('hover-slide-pill')
    expect(timeline.querySelectorAll('[data-hover-slide]')).toHaveLength(2)
    expect(container.querySelectorAll('.hover-slide-pill')).toHaveLength(2)
  })

  it('窗口控制三钮一组，关闭钮保留红色 hover 类；外观关闭时不渲染胶囊、容器类不变', () => {
    mountApp()
    const close = screen.getByRole('button', { name: '关闭' })
    const group = close.parentElement!
    expect(group).toHaveClass('relative', 'isolate')
    expect(group.firstElementChild).toHaveClass('hover-slide-pill')
    expect(group.querySelectorAll('[data-hover-slide]')).toHaveLength(3)
    expect(close).toHaveClass('hover:bg-destructive', 'hover:text-white')
    act(() => { useAppearanceStore.setState({ hoverSlide: false }) })
    expect(group.querySelector('.hover-slide-pill')).toBeNull()
    expect(group).not.toHaveClass('relative', 'isolate')
    act(() => { useAppearanceStore.setState({ hoverSlide: true }) })
  })
})
