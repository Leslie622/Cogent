/** 真事件入口 → 队列 → store：可控节拍、结构屏障与生命周期，不冒充浏览器 FPS。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '@/env.d'
import { bindEngineEvents } from '@/stores/chat/events'
import { emptyBucket, messageDeltas, useChatStore } from '@/stores/chat/store'
import { useHomeStore } from '@/stores/home'

// 回合用例只验证 store 和视图，声音由通知专项覆盖。
vi.mock('@/lib/notify', async (load) => ({
  ...await load<typeof import('@/lib/notify')>(),
  notifyEvent: vi.fn()
}))

const initial = useChatStore.getState()
const handlers = new Set<(event: EngineEvent) => void>()
const request = vi.fn().mockResolvedValue([])
let unbind: () => void
const emit = (event: EngineEvent): void => { for (const handler of handlers) handler(event) }
const delta = (text: string, kind: 'text' | 'thinking' = 'text', sessionId = 'a'): void =>
  emit({ method: 'message.delta', params: { sessionId, messageId: 'm', delta: text, kind } })
const bucket = (id = 'a') => useChatStore.getState().bySession[id]!

beforeEach(() => {
  vi.useFakeTimers()
  request.mockReset().mockImplementation((method: string) => Promise.resolve(method === 'agent.abort' ? { aborted: true } : []))
  window.cogent = { ...window.cogent, engineRequest: request, onEngineEvent: (handler) => {
    handlers.add(handler)
    return () => { handlers.delete(handler) }
  } } as typeof window.cogent
  useChatStore.setState({ ...initial, activeSessionId: 'a', bySession: { a: emptyBucket(), b: emptyBucket() } }, true)
  useHomeStore.setState({ session: { kind: 'chat', chatId: 'a' } })
  unbind = bindEngineEvents()
})
afterEach(() => {
  unbind()
  expect(vi.getTimerCount()).toBe(0)
  handlers.clear()
  vi.useRealTimers()
})

describe('renderer 30ms 发布', () => {
  it('首片后30ms首拍，持续输入不延拍；text/thinking保持各自原序且每批只通知一次', () => {
    const notify = vi.fn()
    const off = useChatStore.subscribe(notify)
    const other = bucket('b')
    delta('甲'); delta('想', 'thinking')
    vi.advanceTimersByTime(20)
    delta('乙'); delta('法', 'thinking')
    vi.advanceTimersByTime(9)
    expect(notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(bucket().messages).toEqual([expect.objectContaining({ content: '甲乙', thinking: '想法' })])
    expect(bucket('b')).toBe(other)
    delta('丙')
    vi.advanceTimersByTime(20); delta('丁')
    vi.advanceTimersByTime(10)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(bucket().messages[0]).toMatchObject({ content: '甲乙丙丁', thinking: '想法' })
    off()
  })

  it('跨session独立计时、屏障只排空目标会话', () => {
    delta('A')
    vi.advanceTimersByTime(10)
    delta('B', 'text', 'b')
    emit({ method: 'run.started', params: { sessionId: 'a' } })
    expect(bucket().messages[0]).toMatchObject({ content: 'A' })
    expect(bucket('b').messages).toEqual([])
    vi.advanceTimersByTime(29)
    expect(bucket('b').messages).toEqual([])
    vi.advanceTimersByTime(1)
    expect(bucket('b').messages[0]).toMatchObject({ content: 'B' })
  })

  it('工具开始/结束屏障保留封段和最后一条引用语义，非连续delta不能穿过工具合并', () => {
    delta('前'); delta('思', 'thinking')
    emit({ method: 'tool.started', params: { sessionId: 'a', callId: 't', name: 'read', kind: 'read' } })
    const sealed = bucket().messages[0]
    // 封段只翻 placeholder 不改 id（id 是渲染 key 素材），新占位 placeholder=true
    expect(sealed).toMatchObject({ placeholder: false })
    delta('后')
    emit({ method: 'tool.completed', params: { sessionId: 'a', callId: 't', isError: false, summary: 'ok' } })
    expect(bucket().messages).toEqual([
      expect.objectContaining({ content: '前', thinking: '思' }),
      expect.objectContaining({ id: 't', status: 'ok' }),
      expect.objectContaining({ content: '后', placeholder: true })
    ])
    delta('续'); vi.advanceTimersByTime(30)
    expect(bucket().messages[0]).toBe(sealed)
    expect(bucket().messages[2]).toMatchObject({ content: '后续' })
  })

  it.each(['run.completed', 'run.failed'] as const)('%s 在后台timer未执行时flush后替换，不复活旧增量', (method) => {
    const user = { id: 'u', role: 'user' as const, content: '问题', timestamp: 0 }
    useChatStore.setState({ bySession: { a: { ...emptyBucket(), messages: [user] } } })
    delta('旧'); delta('思', 'thinking')
    const seen: unknown[] = []
    const off = useChatStore.subscribe((s) => seen.push(s.bySession.a!.messages))
    const final = { id: 'final', role: 'assistant' as const, content: '权威全文', timestamp: 1 }
    if (method === 'run.completed') emit({ method, params: { sessionId: 'a', messages: [final] } })
    else emit({ method, params: { sessionId: 'a', message: '失败', messages: [final] } })
    expect(seen[0]).toEqual([user, expect.objectContaining({ content: '旧', thinking: '思' })])
    expect(bucket().messages).toEqual([user, final])
    vi.advanceTimersByTime(60_000)
    expect(bucket().messages).toEqual([user, final])
    off()
  })

  it('abort先flush，随后到达的尾字在失败终态封存', async () => {
    useChatStore.setState((state) => ({ bySession: { ...state.bySession, a: { ...bucket(), runtime: { ...bucket().runtime, running: true } } } }))
    delta('半')
    await useChatStore.getState().abort()
    expect(bucket().messages[0]).toMatchObject({ content: '半' })
    delta('截'); delta('想', 'thinking')
    emit({ method: 'run.failed', params: { sessionId: 'a', reason: 'aborted', message: 'aborted' } })
    expect(bucket().messages[0]).toMatchObject({ content: '半截', thinking: '想' })
    expect(bucket().messages[0]).toMatchObject({ placeholder: false })
    vi.advanceTimersByTime(1000)
    expect(bucket().messages).toHaveLength(1)
    expect(bucket().runtime).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'stopped' })
  })

  it.each(['clear', 'snapshot', 'delete'] as const)('%s 替换所有权丢弃旧队列', async (action) => {
    delta('旧')
    if (action === 'delete') await useChatStore.getState().deleteSession('a')
    else useChatStore.setState({ bySession: action === 'clear' ? {} : { a: emptyBucket() } })
    vi.advanceTimersByTime(1000)
    expect(useChatStore.getState().bySession.a?.messages ?? []).toEqual([])
  })

  it('切换先flush；异步历史快照落账discard加载期间队列', async () => {
    delta('保留')
    useChatStore.setState((s) => ({ bySession: { a: s.bySession.a } }))
    let resolve!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const loading = useChatStore.getState().selectSession('b')
    expect(bucket().messages[0]).toMatchObject({ content: '保留' })
    delta('加载间旧队列', 'text', 'b')
    resolve({ messages: [], todos: [] })
    await loading
    vi.advanceTimersByTime(1000)
    expect(bucket('b').messages).toEqual([])
  })

  it('submit先排空旧批再追加user；卸载重订阅等价StrictMode清理，无重复监听和timer', async () => {
    delta('旧尾')
    await useChatStore.getState().submit('新问题', 'model')
    expect(bucket().messages).toEqual([expect.objectContaining({ content: '旧尾' }), expect.objectContaining({ role: 'user' })])
    delta('首')
    unbind()
    expect(vi.getTimerCount()).toBe(0)
    expect(handlers.size).toBe(0)
    unbind = bindEngineEvents()
    delta('尾')
    vi.advanceTimersByTime(30)
    expect(bucket().messages.at(-1)).toMatchObject({ content: '首尾' })
  })

  it('可重复对照：300个delta/1ms，旧路径300通知；入口10拍+屏障1拍，全文完全一致', () => {
    const notify = vi.fn()
    const off = useChatStore.subscribe(notify)
    let text = ''; let thinking = ''
    for (let i = 0; i < 300; i++) {
      const part = `${i}中`
      const kind = i % 3 === 0 ? 'thinking' : 'text'
      if (kind === 'thinking') thinking += part
      else text += part
      delta(part, kind)
      vi.advanceTimersByTime(1)
    }
    expect(notify).toHaveBeenCalledTimes(10)
    delta('末'); text += '末'
    messageDeltas.flush('a')
    expect(notify).toHaveBeenCalledTimes(11)
    expect(bucket().messages[0]).toMatchObject({ content: text, thinking })
    off()

    // 同输入逐片发布控制组：真实入口与同一归并函数，每片同步flush恢复旧通知节奏。
    useChatStore.setState({ bySession: { a: emptyBucket() } })
    const immediateNotify = vi.fn()
    const offImmediate = useChatStore.subscribe(immediateNotify)
    for (let i = 0; i < 300; i++) {
      delta(`${i}中`, i % 3 === 0 ? 'thinking' : 'text')
      messageDeltas.flush('a')
      vi.advanceTimersByTime(1)
    }
    delta('末'); messageDeltas.flush('a')
    expect(immediateNotify).toHaveBeenCalledTimes(301)
    expect(bucket().messages[0]).toMatchObject({ content: text, thinking })
    offImmediate()
  })
})
