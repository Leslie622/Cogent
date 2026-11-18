/** HomeChat 保留流内工作状态业务源；滚动跟随不能决定它的生命周期。 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, EngineEvent } from '@/env.d'
import { bindEngineEvents, emptyBucket, useChatStore } from '@/stores/chat'
import { useEngineStore } from '@/stores/engine'
import { useHomeStore } from '@/stores/home'
import { useProjectStore } from '@/stores/project'
import { HomeChat } from './HomeChat'

vi.mock('./ChatTheme', () => ({ useChatTheme: () => ({}) }))
vi.mock('./ConversationIndex', () => ({ ConversationIndex: () => null }))
vi.mock('./ContextIndicator', () => ({ ContextIndicator: () => null }))
vi.mock('./ModelMenu', () => ({ ModelMenu: () => null }))
vi.mock('./PermissionMenu', () => ({ PermissionMenu: () => null }))
vi.mock('./PlanToggle', () => ({ PlanToggle: () => null }))
vi.mock('./ProjectPicker', () => ({ ProjectPicker: () => null }))
vi.mock('./TodoStrip', () => ({ TodoStrip: () => null }))
vi.mock('./ApprovalPanel', () => ({ ApprovalPanel: () => null }))
vi.mock('./QuestionPanel', () => ({ QuestionPanel: () => null }))
vi.mock('./PlanPanel', () => ({ PlanPanel: () => null }))

const SID = 'slot-session'
const initialChat = { ...useChatStore.getState() }
const initialHome = { ...useHomeStore.getState() }
const initialProject = { ...useProjectStore.getState() }
const initialEngine = { ...useEngineStore.getState() }

const user: ChatMessage = { id: 'u1', role: 'user', content: '问题', timestamp: 1_000 }
const streaming: ChatMessage = { id: 'streaming', placeholder: true, role: 'assistant', content: '回答中', timestamp: 1_100 }
const completed: ChatMessage = { id: 'a1', role: 'assistant', content: '回答完成', timestamp: 1_100 }
const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element>; disconnected: boolean }> = []
const handlers = new Set<(event: EngineEvent) => void>()
const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const previousCogent = window.cogent
let unbind: () => void
const emit = (event: EngineEvent): void => { for (const handler of handlers) handler(event) }

beforeEach(() => {
  observers.length = 0
  engineRequest.mockReset().mockImplementation((method) => Promise.resolve(method === 'agent.abort' ? { aborted: true } : []))
  window.cogent = {
    ...previousCogent,
    engineRequest,
    onEngineEvent: (handler) => { handlers.add(handler); return () => { handlers.delete(handler) } }
  } as typeof window.cogent
  vi.stubGlobal('ResizeObserver', class {
    entry: (typeof observers)[number]
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set(), disconnected: false }
      observers.push(this.entry)
    }
    observe(target: Element) { this.entry.targets.add(target) }
    unobserve(target: Element) { this.entry.targets.delete(target) }
    disconnect() { this.entry.disconnected = true }
  })
  useChatStore.setState(initialChat, true)
  useHomeStore.setState(initialHome, true)
  useProjectStore.setState(initialProject, true)
  useEngineStore.setState(initialEngine, true)
  useHomeStore.setState({ session: { kind: 'chat', chatId: SID } })
  useChatStore.setState({
    activeSessionId: SID,
    sessions: [{ id: SID, title: '工作槽', createdAt: 1_000, updatedAt: 1_100 }],
    bySession: {
      [SID]: {
        ...emptyBucket(),
        messages: [user, streaming],
        runtime: { ...emptyBucket().runtime, running: true }
      }
    }
  })
  unbind = bindEngineEvents()
})
afterEach(() => {
  unbind()
  handlers.clear()
  window.cogent = previousCogent
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 保留真实组件与 observer 接线，只注入 jsdom 缺失的溢出几何。 */
function overflowWorkingLine(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>('[data-slot="message-scroller"]')!
  const viewport = screen.getByRole('region')
  const content = screen.getByRole('log')
  const source = container.querySelector<HTMLElement>('[data-slot="live-working-line-source"]')!
  let scrollTop = 400
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => 1_000 },
    clientHeight: { configurable: true, get: () => 600 },
    scrollTop: { configurable: true, get: () => scrollTop, set: (next: number) => { scrollTop = Math.max(0, Math.min(next, 400)) } },
  })
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -400, 800, 1_000))
  vi.spyOn(source, 'getBoundingClientRect').mockReturnValue(new DOMRect(64, 556, 712, 20))
  act(() => {
    for (const observer of observers.filter((entry) => !entry.disconnected && entry.targets.has(content))) {
      observer.callback([], {} as ResizeObserver)
    }
  })
  expect(root.querySelector('[data-slot="message-scroller-decoration"]')).toBeNull()
  expect(source.style.opacity).toBe('')
  expect(screen.getAllByText('工作中')).toHaveLength(1)
  expect(source.closest('[aria-hidden="true"]')).toBeNull()
  expect(screen.getAllByText('工作中').filter((node) => node.closest('[aria-hidden="true"]') === null)).toHaveLength(1)
  return { source }
}

describe('HomeChat 流内 live 工作状态', () => {
  it('短内容的工作状态在正文末尾保留唯一可访问源，不装配 root sibling', () => {
    const { container } = render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    expect(screen.getAllByText('工作中')).toHaveLength(1)
    const source = container.querySelector('[data-slot="live-working-line-source"]')!
    expect(source).not.toBeNull()
    expect(source.closest('[data-slot="message-scroller-content"]')).toBe(screen.getByRole('log'))
    expect(source.parentElement?.lastElementChild).toBe(source)
    expect(source.closest('[aria-hidden="true"]')).toBeNull()
    expect(source.querySelector('[data-slot="trace-title"]')?.textContent).toBe('工作中')
    expect(container.querySelector('[data-slot="live-working-slot"]')).toBeNull()
  })

  it('上翻和回底不卸载流内源，阅读意图不改 scrollTop', () => {
    const { container } = render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const viewport = screen.getByRole('region')
    const source = container.querySelector('[data-slot="live-working-line-source"]')!
    let top = 120
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => 1_000 },
      clientHeight: { configurable: true, get: () => 600 },
      scrollTop: { configurable: true, get: () => top, set: (next: number) => { top = next } },
    })
    fireEvent.wheel(viewport, { deltaY: -10 })
    expect(container.querySelector('[data-slot="live-working-line-source"]')).toBe(source)
    expect(source.closest('[aria-hidden="true"]')).toBeNull()
    expect(viewport.scrollTop).toBe(120)
    act(() => {
      viewport.scrollTop = 400
      fireEvent.scroll(viewport)
    })
    expect(container.querySelector('[data-slot="live-working-line-source"]')).toBe(source)
    expect(screen.getAllByText('工作中')).toHaveLength(1)
  })

  it.each([
    ['done', { running: false, lastRunOutcome: 'completed' }, 'completed', '已工作 0.10s'],
    ['stopped', { running: false, stopping: false, lastRunOutcome: 'stopped' }, 'stopped', '已停止'],
    ['failed', { running: false, lastRunOutcome: 'failed', lastError: '请求失败' }, 'failed', '出错了'],
  ] as const)('live → %s 同批终态只由流内 RunTrace 接棒', (_phase, runtime, outcome, terminalText) => {
    const { container } = render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const live = overflowWorkingLine(container)
    act(() => { useChatStore.setState({
      bySession: {
        [SID]: {
          ...emptyBucket(),
          messages: [user, completed],
          turnOutcomes: { [user.id]: outcome },
          runtime: { ...emptyBucket().runtime, ...runtime }
        }
      }
    }) })
    expect(container.querySelector('[data-slot="live-working-line-source"]')).toBeNull()
    expect(container.querySelector('[data-slot="message-scroller-decoration"]')).toBeNull()
    expect(live.source.isConnected).toBe(false)
    expect(live.source.style.opacity).toBe('')
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
    expect(screen.getByText(terminalText)).toBeInTheDocument()
  })

  it('切换活动会话时清理旧源，切回运行会话重新建立流内源', () => {
    const { container } = render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const source = container.querySelector('[data-slot="live-working-line-source"]')!
    const live = overflowWorkingLine(container)
    act(() => { useChatStore.setState({
      activeSessionId: 'other',
      sessions: [
        { id: SID, title: '工作槽', createdAt: 1_000, updatedAt: 1_100 },
        { id: 'other', title: '另一会话', createdAt: 2_000, updatedAt: 2_000 }
      ],
      bySession: {
        [SID]: useChatStore.getState().bySession[SID]!,
        other: { ...emptyBucket() }
      }
    }) })
    expect(container.querySelector('[data-slot="live-working-line-source"]')).toBeNull()
    expect(source.isConnected).toBe(false)
    expect(container.querySelector('[data-slot="message-scroller-decoration"]')).toBeNull()
    expect(live.source.style.opacity).toBe('')
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
    act(() => { useChatStore.setState({ activeSessionId: SID }) })
    const restored = container.querySelector('[data-slot="live-working-line-source"]')!
    expect(restored).not.toBeNull()
    expect(restored).not.toBe(source)
    expect(restored.closest('[data-slot="message-scroller-content"]')).toBe(screen.getByRole('log'))
    const nextLive = overflowWorkingLine(container)
    expect(nextLive.source).not.toBe(live.source)
    expect(container.querySelectorAll('[data-slot="message-scroller-decoration"]')).toHaveLength(0)
  })
})

describe('HomeChat 的真实停止终态接线', () => {
  it('停止请求在途时唯一工作行显示正在停止，DOM 持续存在', async () => {
    const { container } = render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const live = overflowWorkingLine(container)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止' })); await Promise.resolve() })
    expect(container.querySelector('[data-slot="live-working-line-source"]')).toBe(live.source)
    expect(container.querySelector('[data-slot="message-scroller-decoration"]')).toBeNull()
    expect(screen.getAllByText('正在停止')).toHaveLength(1)
    expect(screen.getAllByText('正在停止').filter((node) => node.closest('[aria-hidden="true"]') === null)).toHaveLength(1)
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
    expect(useChatStore.getState().bySession[SID]!.runtime.running).toBe(true)
  })

  it('点击停止 → 未发布尾字 → 权威快照：清停止位后仍显示已停止，尾正文恰一份', async () => {
    const { container } = render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    overflowWorkingLine(container)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止' })); await Promise.resolve() })
    expect(engineRequest).toHaveBeenCalledWith('agent.abort', { sessionId: SID })
    expect(useChatStore.getState().bySession[SID]!.runtime).toMatchObject({ running: true, stopping: true })
    act(() => {
      emit({ method: 'message.delta', params: { sessionId: SID, messageId: 'm', kind: 'text', delta: '尾' } })
      emit({ method: 'run.failed', params: {
        sessionId: SID, reason: 'aborted', message: '已停止',
        messages: [{ ...completed, content: '回答中尾' }]
      } })
    })
    expect(useChatStore.getState().bySession[SID]!.runtime).toMatchObject({
      running: false, stopping: false, lastRunOutcome: 'stopped', lastError: null
    })
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(screen.getAllByText('回答中尾')).toHaveLength(1)
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
    expect(container.querySelector('[data-slot="message-scroller-decoration"]')).toBeNull()
  })

  it('其他入口的中止无需本窗停止前置位，仍按引擎结果显示已停止', () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: [completed]
    } }) })
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(screen.getByText('回答完成')).toBeInTheDocument()
  })

  it('工具封段前后正文行同一 DOM 节点（组 key/段 key 双稳定，计划/正文衔接连续性修复）', () => {
    const { container } = render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const findRow = () =>
      [...container.querySelectorAll('[data-slot="message-scroller-item"]')].find((el) => el.textContent.includes('回答中'))!
    const el1 = findRow()
    // 封段 = 原项翻 placeholder 留在原位 + 工具卡随其后：正文行 DOM 不换，
    // 选区/渐显状态不丢（jsdom 下 React 重挂必换节点，同一引用即零重挂）
    act(() => { emit({ method: 'tool.started', params: { sessionId: SID, callId: 'c1', name: 'read', kind: 'read' } }) })
    expect(findRow()).toBe(el1)
    expect(el1.isConnected).toBe(true)
  })

  it('点过停止但收到真实 error，头条显示出错了并保留错误文案', async () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止' })); await Promise.resolve() })
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'error', message: '真实连接故障', messages: [completed]
    } }) })
    expect(screen.getByText('出错了')).toBeInTheDocument()
    expect(screen.getByText('真实连接故障')).toBeInTheDocument()
    expect(screen.queryByText('已停止')).not.toBeInTheDocument()
  })

  it('完成后操作报错只显示错误条，不把成功回合改成失败', async () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    await act(async () => { emit({ method: 'run.completed', params: { sessionId: SID, messages: [completed] } }); await Promise.resolve() })
    engineRequest.mockRejectedValueOnce(new Error('手动压缩失败'))
    await act(async () => { await useChatStore.getState().compactNow() })
    expect(screen.getByText('已工作 0.10s')).toBeInTheDocument()
    expect(screen.getByText('手动压缩失败')).toBeInTheDocument()
    expect(screen.queryByText('出错了')).not.toBeInTheDocument()
  })

  it('A 在后台中止不改 B 的工作中，切回 A 才显示其停止结果', async () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止' })); await Promise.resolve() })
    act(() => { useChatStore.setState((state) => ({
      activeSessionId: 'other',
      bySession: { ...state.bySession, other: {
        ...emptyBucket(), messages: [{ ...user, id: 'other-u', content: 'B问题' }],
        runtime: { ...emptyBucket().runtime, running: true }
      } }
    })) })
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: [completed]
    } }) })
    expect(screen.getByText('B问题')).toBeInTheDocument()
    expect(screen.getByText('工作中')).toBeInTheDocument()
    expect(screen.queryByText('已停止')).not.toBeInTheDocument()
    await act(async () => { await useChatStore.getState().selectSession(SID) })
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(screen.getByText('回答完成')).toBeInTheDocument()
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
  })
})

describe('HomeChat 回合结果跨后续消息保留', () => {
  it('首片前停止后发送你好并完成，原空回合仍显示已停止', async () => {
    useChatStore.setState((state) => ({
      bySession: { ...state.bySession, [SID]: { ...state.bySession[SID]!, messages: [user] } }
    }))
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止' })); await Promise.resolve() })
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: []
    } }) })
    expect(screen.getByText('已停止')).toBeInTheDocument()

    await act(async () => { await useChatStore.getState().submit('你好') })
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(screen.getByText('工作中')).toBeInTheDocument()
    act(() => { emit({ method: 'run.completed', params: {
      sessionId: SID, messages: [{ ...completed, id: 'next-answer', content: '你好，继续聊', timestamp: Date.now() }]
    } }) })
    expect(screen.getAllByText('已停止')).toHaveLength(1)
    expect(screen.getByText('你好，继续聊')).toBeInTheDocument()
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1)
  })

  it('半截文章停止后发送稍等一下，旧头不变已工作且正文不重复', async () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止' })); await Promise.resolve() })
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: [{ ...completed, content: '半截文章，这不是' }]
    } }) })
    expect(screen.getByText('已停止')).toBeInTheDocument()
    await act(async () => { await useChatStore.getState().submit('稍等一下') })
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(screen.queryByText(/^已工作/)).not.toBeInTheDocument()
    expect(screen.getAllByText('半截文章，这不是')).toHaveLength(1)
    act(() => { emit({ method: 'run.completed', params: {
      sessionId: SID, messages: [{ ...completed, id: 'waiting-answer', content: '好，我等你', timestamp: Date.now() }]
    } }) })
    expect(screen.getAllByText('已停止')).toHaveLength(1)
    expect(screen.getAllByText('半截文章，这不是')).toHaveLength(1)
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1)
  })

  it('失败回合在下一条消息正常完成后仍保留出错了', async () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'error', message: '真实故障', messages: []
    } }) })
    expect(screen.getByText('出错了')).toBeInTheDocument()
    await act(async () => { await useChatStore.getState().submit('再试一次') })
    expect(screen.getByText('出错了')).toBeInTheDocument()
    act(() => { emit({ method: 'run.completed', params: {
      sessionId: SID, messages: [{ ...completed, id: 'retry-answer', content: '新回答', timestamp: Date.now() }]
    } }) })
    expect(screen.getByText('出错了')).toBeInTheDocument()
    expect(screen.getByText('新回答')).toBeInTheDocument()
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1)
  })

  it('continue沿用同一user回合，live优先并由新终态更新结果', async () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: [{ ...completed, content: '旧前缀' }]
    } }) })
    expect(screen.getByText('已停止')).toBeInTheDocument()
    await act(async () => { await useChatStore.getState().continueGeneration() })
    expect(screen.queryByText('已停止')).not.toBeInTheDocument()
    expect(screen.getByText('工作中')).toBeInTheDocument()
    act(() => { emit({ method: 'run.completed', params: {
      sessionId: SID, messages: [{ ...completed, content: '旧前缀与新尾部' }]
    } }) })
    expect(screen.queryByText('已停止')).not.toBeInTheDocument()
    expect(screen.getByText('旧前缀与新尾部')).toBeInTheDocument()
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1)
    await act(async () => { await useChatStore.getState().submit('下一问') })
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: []
    } }) })
    expect(screen.getAllByText('已停止')).toHaveLength(1)
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1)
    expect(screen.getByText('旧前缀与新尾部')).toBeInTheDocument()
  })

  it('未知历史回合不因新submit被拒绝而伪标失败', async () => {
    useChatStore.setState((state) => ({
      bySession: { ...state.bySession, [SID]: {
        ...emptyBucket(), messages: [user, completed]
      } }
    }))
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    expect(screen.getByText('已工作 0.10s')).toBeInTheDocument()
    engineRequest.mockRejectedValueOnce(new Error('本次提交被拒绝'))
    await act(async () => {
      await expect(useChatStore.getState().submit('没有受理的新问题')).rejects.toThrow('本次提交被拒绝')
    })
    expect(screen.getByText('已工作 0.10s')).toBeInTheDocument()
    expect(screen.queryByText('出错了')).not.toBeInTheDocument()
    expect(screen.queryByText('没有受理的新问题')).not.toBeInTheDocument()
    expect(screen.getByText('本次提交被拒绝')).toBeInTheDocument()
  })

  it('相同提问文本的两个user回合分别保留自己的停止和完成结果', async () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: []
    } }) })
    await act(async () => { await useChatStore.getState().submit(user.content) })
    act(() => { emit({ method: 'run.completed', params: {
      sessionId: SID, messages: [{ ...completed, id: 'same-question-answer', content: '第二次回答', timestamp: Date.now() }]
    } }) })
    expect(screen.getAllByText(user.content)).toHaveLength(2)
    expect(screen.getAllByText('已停止')).toHaveLength(1)
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1)
    expect(screen.getByText('第二次回答')).toBeInTheDocument()
  })

  it('同user的continue请求被拒绝后以本次失败更新回合结果', async () => {
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: [{ ...completed, content: '保留的旧前缀' }]
    } }) })
    expect(screen.getByText('已停止')).toBeInTheDocument()
    engineRequest.mockRejectedValueOnce(new Error('本次续写被拒绝'))
    await act(async () => { await useChatStore.getState().continueGeneration() })
    expect(screen.queryByText('已停止')).not.toBeInTheDocument()
    expect(screen.getByText('出错了')).toBeInTheDocument()
    expect(screen.getByText('本次续写被拒绝')).toBeInTheDocument()
    expect(screen.getByText('保留的旧前缀')).toBeInTheDocument()
  })

  it('前导无user旧组不继承当前用户回合的停止结果', () => {
    useChatStore.setState((state) => ({
      bySession: { ...state.bySession, [SID]: {
        ...state.bySession[SID]!,
        messages: [{ ...completed, id: 'leading-answer', content: '前导历史回答' }, user, streaming]
      } }
    }))
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    act(() => { emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: [completed]
    } }) })
    expect(screen.getAllByText('已停止')).toHaveLength(1)
    expect(screen.getByText('已工作')).toBeInTheDocument()
    expect(screen.getByText('前导历史回答')).toBeInTheDocument()
  })
})

describe('HomeChat 提交回包与输入区身份', () => {
  function pendingSubmission() {
    let resolve!: (value: unknown) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
    engineRequest.mockImplementationOnce(() => promise)
    return { resolve, reject }
  }

  function settleInitialRun(): void {
    useChatStore.setState((state) => ({
      bySession: { ...state.bySession, [SID]: {
        ...state.bySession[SID]!, runtime: { ...emptyBucket().runtime }
      } }
    }))
  }

  it.each(['resolved', 'rejected'] as const)('停止后旧submit %s 不清掉用户后来重新编辑的同文草稿', async (settlement) => {
    settleInitialRun()
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const input = screen.getByPlaceholderText('随心输入')
    fireEvent.change(input, { target: { value: '本次问题' } })
    const old = pendingSubmission()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(engineRequest).toHaveBeenCalledWith('agent.submit', expect.objectContaining({ text: '本次问题' }))
    act(() => { emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } }) })
    fireEvent.change(input, { target: { value: '另一个草稿' } })
    fireEvent.change(input, { target: { value: '本次问题' } })
    await act(async () => {
      if (settlement === 'resolved') old.resolve({ accepted: true })
      else old.reject(new Error('过期提交拒绝'))
      await Promise.resolve()
    })
    expect(input).toHaveValue('本次问题')
    expect(screen.getByText('已停止')).toBeInTheDocument()
  })

  it('旧submit成功不能把用户已切换的新聊天视图翻回旧会话', async () => {
    settleInitialRun()
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const input = screen.getByPlaceholderText('随心输入')
    fireEvent.change(input, { target: { value: '旧会话问题' } })
    const old = pendingSubmission()
    fireEvent.keyDown(input, { key: 'Enter' })
    act(() => {
      emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } })
      useHomeStore.setState({ session: { kind: 'new' } })
    })
    await act(async () => { old.resolve({ accepted: true }); await Promise.resolve() })
    expect(useHomeStore.getState().session.kind).toBe('new')
    expect(screen.getByPlaceholderText('随心输入')).toHaveValue('旧会话问题')
  })

  it('同文重发的新请求仍在途时，旧成功回包不能提前清新请求草稿', async () => {
    settleInitialRun()
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const input = screen.getByPlaceholderText('随心输入')
    fireEvent.change(input, { target: { value: '同一个问题' } })
    const first = pendingSubmission()
    fireEvent.keyDown(input, { key: 'Enter' })
    act(() => { emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } }) })
    const second = pendingSubmission()
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { first.resolve({ accepted: true }); await Promise.resolve() })
    expect(input).toHaveValue('同一个问题')
    await act(async () => { second.resolve({ accepted: true }); await Promise.resolve() })
    expect(input).toHaveValue('')
  })

  it('当次submit受理会清原草稿，当次拒绝保留原文供重试', async () => {
    settleInitialRun()
    render(<HomeChat tabsCollapsed onToggleTabs={() => {}} />)
    const input = screen.getByPlaceholderText('随心输入')
    fireEvent.change(input, { target: { value: '可重试问题' } })
    engineRequest.mockRejectedValueOnce(new Error('本次提交失败'))
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); await Promise.resolve() })
    expect(input).toHaveValue('可重试问题')
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); await Promise.resolve() })
    expect(input).toHaveValue('')
  })
})
