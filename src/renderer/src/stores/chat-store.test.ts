/**
 * chat store 事件驱动行为测试（docs/计划/测试体系.md S5）：window.cogent
 * 可编程 stub + bindEngineEvents 驱动**真实接线**（不测复制品）—— 事件 →
 * 状态手术的全链路。重点钉 D9 保留式呈现的 store 侧手术：
 * - compaction.pruned standalone 行立即落尾；
 * - compaction.completed 时间序落点 + 同检查点 standalone 撤销 + 副行随条配对；
 * - run.completed 终态替换不吞压缩条/副行（keptCompaction 并回）；
 * - submit 边界失败：IPC 前缀剥壳 + 乐观消息回滚（R10）。
 * 纯函数部分见 chat.test.ts。
 */
import type { ChatMessage } from '@/env.d'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindEngineEvents, useChatStore } from './chat'

// ———— window.cogent 可编程 stub（模块加载前就位，bindEngineEvents 才拿得到） ————

type EventHandler = (event: unknown) => void
const handlers: EventHandler[] = []
const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>().mockResolvedValue([])
const respondApproval = vi.fn().mockResolvedValue(undefined)

window.cogent = {
  engineRequest,
  respondApproval,
  onEngineEvent: (handler: EventHandler) => {
    handlers.push(handler)
    return () => {}
  }
} as unknown as typeof window.cogent

const emit = (event: Parameters<EventHandler>[0]): void => {
  for (const handler of [...handlers]) handler(event)
}

// ———— 状态隔离：每测试回滚到初照（zustand 动作引用稳定，快照含动作可整体替换） ————

const initialState = { ...useChatStore.getState() }
beforeEach(() => {
  useChatStore.setState(initialState, true)
  engineRequest.mockReset().mockResolvedValue([])
  respondApproval.mockClear()
})

const SID = 's1'
/** 预置消息列表（直写 store，绕开 submit 的乐观路径） */
const seedMessages = (items: ReturnType<typeof useChatStore.getState>['messagesBySession'][string]): void => {
  useChatStore.setState((state) => ({
    messagesBySession: { ...state.messagesBySession, [SID]: items },
    activeSessionId: SID
  }))
}
const messages = (): Array<unknown> => useChatStore.getState().messagesBySession[SID] ?? []

const userMsg = (content: string, at: number): ChatMessage => ({ id: `u-${content}`, role: 'user', content, timestamp: at })
const assistantMsg = (content: string, at: number): ChatMessage => ({ id: `a-${content}`, role: 'assistant', content, timestamp: at })

bindEngineEvents()

describe('compaction 事件序列（D9 保留式 store 手术）', () => {
  it('started → completed：折叠条落在压缩时刻已存在的内容之后（=「正在压缩」状态条的位置），旧消息一条不删', () => {
    // fake 钟把 bar.timestamp 钉在 10000：q2(300) 是压缩前刚发的 —— bar 应落它
    // 之后（压缩打断在 q2 与其回复之间），压缩后新消息（timestamp > 10000）才会排到 bar 后面
    vi.useFakeTimers({ now: 10_000 })
    try {
      seedMessages([userMsg('q1', 100), assistantMsg('a1', 200), userMsg('q2', 300)])
      emit({ method: 'compaction.started', params: { sessionId: SID, reason: 'threshold' } })
      expect(useChatStore.getState().compactingBySession[SID]).toBe(true)

      emit({
        method: 'compaction.completed',
        params: { sessionId: SID, reason: 'threshold', tokensBefore: 90_000, tokensAfter: 10_000, summary: 'SUMMARY', summarizedUntil: 250 }
      })
      const state = useChatStore.getState()
      expect(state.compactingBySession[SID]).toBeUndefined() // 窗口关闭
      const list = messages()
      expect(list.map((m) => (m as ChatMessage).role)).toEqual(['user', 'assistant', 'user', 'compaction'])
      expect(list.map((m) => (m as ChatMessage).content)).toEqual(['q1', 'a1', 'q2', 'SUMMARY'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('pruned standalone 行立即落尾；completed 撤下独立行、随折叠条配对重插（不双份）', () => {
    seedMessages([userMsg('q1', 100), assistantMsg('a1', 200), userMsg('q2', 300)])
    const entries = [{ toolCallId: 't1', originalChars: 20_000, prunedChars: 5_155 }]
    emit({ method: 'compaction.pruned', params: { sessionId: SID, entries } })
    let list = messages() as Array<{ id: string; type?: string }>
    expect(list.at(-1)).toMatchObject({ type: 'pruned' }) // L1-alone：它就是全部呈现

    emit({
      method: 'compaction.completed',
      params: { sessionId: SID, reason: 'threshold', tokensBefore: 90, tokensAfter: 10, summary: 'S', summarizedUntil: 250 }
    })
    list = messages() as Array<{ id: string; type?: string }>
    const prunedRows = list.filter((m) => m.type === 'pruned')
    expect(prunedRows).toHaveLength(1) // 独立行撤下、配对行不双份
    const barAt = list.findIndex((m) => (m as ChatMessage).role === 'compaction')
    expect(list[barAt + 1]).toMatchObject({ type: 'pruned' }) // 紧随折叠条
  })

  it('失败帧（error）：清压缩位、不动列表', () => {
    seedMessages([userMsg('q1', 100)])
    emit({ method: 'compaction.started', params: { sessionId: SID, reason: 'manual' } })
    emit({ method: 'compaction.completed', params: { sessionId: SID, reason: 'manual', error: '生成失败' } })
    expect(useChatStore.getState().compactingBySession[SID]).toBeUndefined()
    expect(messages()).toHaveLength(1)
  })
})

describe('run.completed 终态替换（D9 不吞压缩条/副行）', () => {
  it('替换区内已落的 bar 按时间序并回替换结果（终态段晚于 bar → bar 在回复之前），旧消息不丢', () => {
    // 场景：q2 回合流式中触发轮间压缩（bar 已插进替换区尾部），随后 run.completed
    // 带分段终态整段替换 —— keptCompaction 按时间序并回，bar 停在 q2 与其回复之间
    vi.useFakeTimers({ now: 10_000 })
    try {
      seedMessages([userMsg('q1', 100), assistantMsg('a1', 200), userMsg('q2', 300)])
      emit({
        method: 'compaction.completed',
        params: { sessionId: SID, reason: 'threshold', tokensBefore: 90, tokensAfter: 10, summary: 'S', summarizedUntil: 250 }
      })
      // q2 回合终态：一段正文（timestamp 晚于 bar → bar 并回它之前）
      emit({
        method: 'run.completed',
        params: {
          sessionId: SID,
          messages: [assistantMsg('answer', 10_500)],
          stopReason: 'stop'
        }
      })
      const list = messages()
      expect(list.map((m) => `${(m as ChatMessage).role}:${(m as ChatMessage).content}`)).toEqual([
        'user:q1',
        'assistant:a1',
        'user:q2',
        'compaction:S',
        'assistant:answer'
      ])
      expect(useChatStore.getState().runningBySession[SID]).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('submit 边界失败（R10 IPC 剥壳 + 乐观回滚）', () => {
  it('engineRequest 拒绝：错误条显示剥壳后的协议文案，乐观用户消息撤回、运行态复位', async () => {
    seedMessages([])
    engineRequest.mockRejectedValueOnce(
      new Error("Error invoking remote method 'engine:request': Error: 会话正在回复中，请先停止或等待完成")
    )
    // submit 会 rethrow（调用方回填输入框）—— 这里只关心 store 收尾
    await useChatStore.getState().submit('hello', 'mock').catch(() => {})
    const state = useChatStore.getState()
    expect(state.lastErrorBySession[SID]).toBe('会话正在回复中，请先停止或等待完成') // 剥过壳
    expect(state.runningBySession[SID]).toBe(false)
    expect(messages()).toHaveLength(0) // 乐观消息回滚
  })
})
