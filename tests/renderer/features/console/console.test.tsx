/** 控制台回归：布局分区、过滤后的真实终态、JSON 留存原文与初载竞态。 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
})
