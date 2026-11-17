/**
 * chat store 事件驱动行为测试（docs/模块/测试.md）：window.cogent
 * 可编程 stub + bindEngineEvents 驱动**真实接线**（不测复制品）—— 事件 →
 * 会话桶手术的全链路。重点钉 D9 保留式呈现的 store 侧手术：
 * - compaction.pruned standalone 行立即落尾；
 * - compaction.completed 时间序落点 + 同检查点 standalone 撤销 + 副行随条配对；
 * - run.completed 终态替换不吞压缩条/副行（keptCompaction 并回）；
 * - submit 边界失败：IPC 前缀剥壳 + 乐观消息回滚（R10）。
 * 纯函数部分见 flatten.test.ts；projectDefaultMode（F6 解析链一环）随本件。
 * 2026-11-17 会话状态重构 P1：断言自平行 map 迁到 bySession 桶，判据不变。
 */
import type { ChatMessage } from '@/env.d'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project'
import { useHomeStore } from '@/stores/home'
import { bindEngineEvents } from './events'
import { emptyBucket, patchBucket, projectDefaultMode, useChatStore } from './store'
import type { MessageItem } from './types'

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
  engineRequest.mockReset().mockImplementation((method) => Promise.resolve(method === 'agent.abort' ? { aborted: true } : []))
  respondApproval.mockClear()
})

const SID = 's1'
/** 预置消息桶（直写 store，绕开 submit 的乐观路径）。视图态同步置 chat：
 *  生产里"有活动会话"必然是 chat 态（openSession/send 都会翻转 home store），
 *  submit 的物化条件按视图态优先，seed 不对齐会误入
 *  "新聊天强制物化"分支 */
const seedMessages = (items: MessageItem[]): void => {
  useHomeStore.setState({ session: { kind: 'chat', chatId: SID } })
  useChatStore.setState((state) => ({
    bySession: { ...state.bySession, [SID]: { ...emptyBucket(), messages: items } },
    activeSessionId: SID
  }))
}
const messages = (): MessageItem[] => useChatStore.getState().bySession[SID]?.messages ?? []

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
      expect(useChatStore.getState().bySession[SID]?.runtime.compacting).toBe(true)

      emit({
        method: 'compaction.completed',
        params: { sessionId: SID, reason: 'threshold', tokensBefore: 90_000, tokensAfter: 10_000, summary: 'SUMMARY', summarizedUntil: 250 }
      })
      const state = useChatStore.getState()
      expect(state.bySession[SID]?.runtime.compacting).toBe(false) // 窗口关闭
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
    list = messages()
    const prunedRows = list.filter((m) => m.type === 'pruned')
    expect(prunedRows).toHaveLength(1) // 独立行撤下、配对行不双份
    const barAt = list.findIndex((m) => (m as ChatMessage).role === 'compaction')
    expect(list[barAt + 1]).toMatchObject({ type: 'pruned' }) // 紧随折叠条
  })

  it('失败帧（error）：清压缩位、不动列表', () => {
    seedMessages([userMsg('q1', 100)])
    emit({ method: 'compaction.started', params: { sessionId: SID, reason: 'manual' } })
    emit({ method: 'compaction.completed', params: { sessionId: SID, reason: 'manual', error: '生成失败' } })
    expect(useChatStore.getState().bySession[SID]?.runtime.compacting).toBe(false)
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
      expect(useChatStore.getState().bySession[SID]?.runtime.running).toBe(false)
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
    const bucket = useChatStore.getState().bySession[SID]
    expect(bucket?.runtime.lastError).toBe('会话正在回复中，请先停止或等待完成') // 剥过壳
    expect(bucket?.runtime.running).toBe(false)
    expect(bucket?.runtime.stopping).toBe(false)
    expect(bucket?.runtime.lastRunOutcome).toBe('failed')
    expect(messages()).toHaveLength(0) // 乐观消息回滚
  })
})

describe('context.updated 轮终实报与 run.failed 分段终态', () => {
  const usageMsg = (n: number): ChatMessage => ({
    id: `a-${n}`,
    role: 'assistant',
    content: `t${n}`,
    usage: { input: n * 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: n * 100 + 10, totalCost: 0 },
    timestamp: 1_000 + n
  })

  it('context.updated 落 live 值；run 终态清键（segments 内 usage 为准）', () => {
    seedMessages([userMsg('u1', 100), usageMsg(1)])
    emit({ method: 'context.updated', params: { sessionId: SID, usage: { input: 900, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 950, totalCost: 0 } } })
    expect(useChatStore.getState().bySession[SID]?.runtime.contextLive?.input).toBe(900)
    emit({ method: 'run.completed', params: { sessionId: SID, messages: [usageMsg(2)] } })
    expect(useChatStore.getState().bySession[SID]?.runtime.contextLive).toBeNull()
  })

  it('compaction.completed 弃置 live（压缩前旧账让位 tokensAfter 估算）', () => {
    seedMessages([userMsg('u1', 100), usageMsg(1)])
    emit({ method: 'context.updated', params: { sessionId: SID, usage: { input: 900, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 950, totalCost: 0 } } })
    emit({
      method: 'compaction.completed',
      params: { sessionId: SID, reason: 'threshold', tokensBefore: 900, tokensAfter: 100, summary: 'S', summarizedUntil: 200 }
    })
    expect(useChatStore.getState().bySession[SID]?.runtime.contextLive).toBeNull()
  })

  it('run.failed 带权威分段：已封存的中止尾段恰一份，usage 同时落账', async () => {
    // 流式态：user + 占位 + running 工具卡（abort 场景：一轮已完成、下一轮被打断）
    seedMessages([
      userMsg('u1', 100),
      { id: 't1', type: 'tool', name: 'read', toolKind: 'read', summary: 'read(a)', status: 'running', startedAt: 150 },
      { id: 'streaming', role: 'assistant', content: '半截', timestamp: 200 }
    ])
    // 走 store 的真实写入姿势（patchBucket 兜底建桶），免手搓 Partial 索引
    useChatStore.setState((state) =>
      patchBucket(state, SID, (bucket) => ({ ...bucket, runtime: { ...bucket.runtime, running: true } }))
    )
    await useChatStore.getState().abort()
    // pi 的 aborted turn 也已触发 turn_end，Host 快照包含这个尾段，不能再拼占位。
    const partial = assistantMsg('半截', 200)
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已中止', messages: [usageMsg(1), partial] } })
    const list = messages()
    // 引擎已完成轮的 usage 与被截断的正文都来自同一份权威快照。
    const withUsage = list.find((m): m is ChatMessage => m.type === undefined && m.usage !== undefined)
    expect(withUsage?.usage?.input).toBe(100)
    expect(list.filter((m) => m.type === undefined && m.content === '半截')).toEqual([partial])
    expect(useChatStore.getState().bySession[SID]?.runtime.running).toBe(false)
    expect(useChatStore.getState().bySession[SID]?.runtime.stopping).toBe(false)
    expect(useChatStore.getState().bySession[SID]?.runtime.lastRunOutcome).toBe('stopped')
    expect(useChatStore.getState().bySession[SID]?.runtime.lastError).toBeNull() // 停止不是错误
  })
})

describe('run 最终结果与停止请求窗口分离', () => {
  const runtime = () => useChatStore.getState().bySession[SID]!.runtime
  const seedLive = (content = '半截', thinking?: string): void => {
    seedMessages([
      userMsg('问题', 100),
      { id: 'streaming', role: 'assistant', content, thinking, timestamp: 200 }
    ])
    useChatStore.setState((state) => patchBucket(state, SID, (bucket) => ({
      ...bucket, runtime: { ...bucket.runtime, running: true }
    })))
  }
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
  }

  it('abort 受理只打开停止窗口，权威中止终态才写 stopped；无快照时封存本地半截', async () => {
    seedLive()
    await useChatStore.getState().abort()
    expect(runtime()).toMatchObject({ running: true, stopping: true, lastRunOutcome: null })
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } })
    expect(runtime()).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'stopped', lastError: null })
    expect(messages()).toEqual([userMsg('问题', 100), expect.objectContaining({ content: '半截' })])
    expect(messages()[1].id).not.toBe('streaming')
  })

  it('其他入口中止时，本窗没有 stopping 也按权威 reason 保留正文与 stopped', () => {
    seedLive()
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } })
    expect(runtime()).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'stopped', lastError: null })
    expect(messages()[1]).toMatchObject({ content: '半截' })
  })

  it.each(['error', undefined] as const)('点过停止仍不能把 reason=%s 的真实失败猜成 stopped', async (reason) => {
    seedLive()
    await useChatStore.getState().abort()
    emit({ method: 'run.failed', params: { sessionId: SID, reason, message: '连接失败' } })
    expect(runtime()).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'failed', lastError: '连接失败' })
    expect(messages()).toEqual([userMsg('问题', 100)])
  })

  it('messages 空数组是权威空快照，不能把本地占位补回来', async () => {
    seedLive()
    await useChatStore.getState().abort()
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止', messages: [] } })
    expect(messages()).toEqual([userMsg('问题', 100)])
    expect(runtime().lastRunOutcome).toBe('stopped')
  })

  it.each(['aborted', 'error'] as const)('%s 的 thinking-only 封存尾段恰一份', (reason) => {
    seedLive('', '思考半截')
    const final = { ...assistantMsg('', 200), thinking: '思考半截' }
    emit({ method: 'run.failed', params: { sessionId: SID, reason, message: '结束', messages: [final] } })
    expect(messages()).toEqual([userMsg('问题', 100), final])
    expect(messages().filter((m) => m.type === undefined && m.thinking === '思考半截')).toHaveLength(1)
    expect(runtime().lastRunOutcome).toBe(reason === 'aborted' ? 'stopped' : 'failed')
  })

  it('权威快照里的两个同文段保留两个实例，不能用内容相等去重', () => {
    seedLive('相同段落')
    const first = assistantMsg('相同段落', 200)
    const second = { ...first, id: 'a-second', timestamp: 210 }
    emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: [first, second]
    } })
    expect(messages()).toEqual([userMsg('问题', 100), first, second])
  })

  it('中止快照替换工具卡并收挂起审批，正文与 cancelled 痕迹均只留一份', async () => {
    seedLive('工具前正文')
    const pending = { requestId: 'approval-1', toolName: 'write', toolKind: 'write', summary: 'write(a)' }
    useChatStore.setState((state) => patchBucket(state, SID, (bucket) => ({
      ...bucket,
      messages: [...bucket.messages, { id: 'tool-1', type: 'tool', name: 'write', toolKind: 'write', summary: 'write(a)', status: 'running' }],
      pendingApprovals: [pending]
    })))
    await useChatStore.getState().abort()
    const final: ChatMessage = {
      ...assistantMsg('工具前正文', 200),
      toolCalls: [{ callId: 'tool-1', name: 'write', kind: 'write', summary: 'write(a)', status: 'blocked', resultSummary: '已停止' }]
    }
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止', messages: [final] } })
    expect(messages().filter((m) => m.type === undefined && m.content === '工具前正文')).toHaveLength(1)
    expect(messages().filter((m) => m.type === 'tool')).toEqual([expect.objectContaining({ id: 'tool-1', status: 'blocked' })])
    expect(messages().filter((m) => m.type === 'approval')).toEqual([expect.objectContaining({ id: 'approval-1', status: 'cancelled' })])
    expect(useChatStore.getState().bySession[SID]!.pendingApprovals).toEqual([])
  })

  it('完成先收口会消费停止窗口和旧操作错误，结果保持 completed', async () => {
    seedLive()
    await useChatStore.getState().abort()
    useChatStore.setState((state) => patchBucket(state, SID, (bucket) => ({
      ...bucket, runtime: { ...bucket.runtime, lastError: '旧操作错误' }
    })))
    emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('完成', 200)] } })
    expect(runtime()).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'completed', lastError: null })
  })

  it('已经终态后再点停止不发请求，也不重新打开停止窗口', async () => {
    seedLive()
    emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('完成', 200)] } })
    await Promise.resolve()
    engineRequest.mockClear()
    await useChatStore.getState().abort()
    expect(engineRequest).not.toHaveBeenCalled()
    expect(runtime()).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'completed', lastError: null })
  })

  it.each(['submit', 'continueGeneration'] as const)('下一次 %s 清理上一 run 的停止结果与错误', async (action) => {
    seedLive()
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } })
    useChatStore.setState((state) => patchBucket(state, SID, (bucket) => ({
      ...bucket, runtime: { ...bucket.runtime, lastError: '旧操作错误', stopping: true, truncated: true }
    })))
    if (action === 'submit') await useChatStore.getState().submit('下一问')
    else await useChatStore.getState().continueGeneration()
    expect(runtime()).toMatchObject({ running: true, stopping: false, lastRunOutcome: null, lastError: null, truncated: false })
  })

  it('continue 请求拒绝明确落 failed，不残留上次 stopped', async () => {
    seedLive()
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } })
    engineRequest.mockRejectedValueOnce(new Error("Error invoking remote method 'engine:request': Error: 无法续写"))
    await useChatStore.getState().continueGeneration()
    expect(runtime()).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'failed', lastError: '无法续写' })
  })

  it('abort IPC 拒绝撤本次停止窗口，但实际 run 仍 live 并展示操作错误', async () => {
    seedLive()
    engineRequest.mockRejectedValueOnce(new Error("Error invoking remote method 'engine:request': Error: 停止请求失败"))
    await expect(useChatStore.getState().abort()).resolves.toBeUndefined()
    expect(runtime()).toMatchObject({ running: true, stopping: false, lastRunOutcome: null, lastError: '停止请求失败' })
    expect(messages()[1]).toMatchObject({ content: '半截' })
  })

  it('aborted:false 关闭停止窗口，但不制造 stopped 或结束实际 run', async () => {
    seedLive()
    engineRequest.mockResolvedValueOnce({ aborted: false })
    await useChatStore.getState().abort()
    expect(runtime()).toMatchObject({ running: true, stopping: false, lastRunOutcome: null })
  })

  it.each(['reject', 'not-aborted'] as const)('上一 run 晚到的 %s 不会撤销下一 run 的新停止请求', async (settlement) => {
    seedLive()
    const oldResponse = deferred<{ aborted: boolean }>()
    engineRequest.mockImplementationOnce(() => oldResponse.promise)
    const oldAbort = useChatStore.getState().abort()
    emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('完成', 200)] } })
    await useChatStore.getState().submit('下一问')
    const currentResponse = deferred<{ aborted: boolean }>()
    engineRequest.mockImplementationOnce(() => currentResponse.promise)
    const currentAbort = useChatStore.getState().abort()
    if (settlement === 'reject') oldResponse.reject(new Error('旧请求失败'))
    else oldResponse.resolve({ aborted: false })
    await oldAbort
    expect(runtime()).toMatchObject({ running: true, stopping: true, lastRunOutcome: null, lastError: null })
    currentResponse.resolve({ aborted: true })
    await currentAbort
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '当前已停止', messages: [] } })
    expect(runtime()).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'stopped', lastError: null })
  })

  it('同一 run 的旧 abort 拒绝不撤销更新一次的停止请求', async () => {
    seedLive()
    const first = deferred<{ aborted: boolean }>()
    engineRequest.mockImplementationOnce(() => first.promise)
    const oldAbort = useChatStore.getState().abort()
    await useChatStore.getState().abort()
    first.reject(new Error('旧请求失败'))
    await oldAbort
    expect(runtime()).toMatchObject({ running: true, stopping: true, lastError: null })
  })

  it('终态后晚到的 abort 拒绝不改 completed 或添加错误', async () => {
    seedLive()
    const response = deferred<{ aborted: boolean }>()
    engineRequest.mockImplementationOnce(() => response.promise)
    const aborting = useChatStore.getState().abort()
    emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('完成', 200)] } })
    response.reject(new Error('过期错误'))
    await aborting
    expect(runtime()).toMatchObject({ running: false, stopping: false, lastRunOutcome: 'completed', lastError: null })
  })

  it('删除会话后旧 abort 拒绝不能复活桶', async () => {
    seedLive()
    const response = deferred<{ aborted: boolean }>()
    engineRequest.mockImplementationOnce(() => response.promise)
    const aborting = useChatStore.getState().abort()
    await useChatStore.getState().deleteSession(SID)
    response.reject(new Error('过期错误'))
    await aborting
    expect(useChatStore.getState().bySession[SID]).toBeUndefined()
  })

  it('切换到 B 后 A 的中止只更新 A，切回仍保留 stopped', async () => {
    seedLive()
    await useChatStore.getState().abort()
    const other = { ...emptyBucket(), messages: [userMsg('B问题', 300)], runtime: { ...emptyBucket().runtime, running: true } }
    useChatStore.setState((state) => ({ bySession: { ...state.bySession, other }, activeSessionId: 'other' }))
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止', messages: [assistantMsg('半截', 200)] } })
    expect(useChatStore.getState().bySession.other).toBe(other)
    await useChatStore.getState().selectSession(SID)
    expect(useChatStore.getState().activeSessionId).toBe(SID)
    expect(runtime().lastRunOutcome).toBe('stopped')
  })

  it('手动压缩操作失败可以显示错误，但不重写上一 run 的完成结果', async () => {
    seedLive()
    emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('完成', 200)] } })
    engineRequest.mockRejectedValueOnce(new Error('无法压缩'))
    await useChatStore.getState().compactNow()
    expect(runtime()).toMatchObject({ lastRunOutcome: 'completed', lastError: '无法压缩' })
  })
})

// ———— projectDefaultMode（F6 项目级默认权限，createSession 解析链一环） ————

describe('运行请求回包的身份隔离', () => {
  function pendingRequest() {
    let reject!: (reason: Error) => void
    const promise = new Promise<unknown>((_resolve, fail) => { reject = fail })
    return { promise, reject }
  }

  it.each(['submit', 'continueGeneration'] as const)('%s 已停止后晚到的拒绝不改终态，也不再抛给输入回填', async (action) => {
    seedMessages([userMsg('旧问题', 100), assistantMsg('旧前缀', 200)])
    const old = pendingRequest()
    engineRequest.mockImplementationOnce(() => old.promise)
    const request = (action === 'submit'
      ? useChatStore.getState().submit('本次问题')
      : useChatStore.getState().continueGeneration()).then(() => 'resolved', () => 'rejected')
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } })
    const before = useChatStore.getState().bySession[SID]!
    old.reject(new Error('旧请求晚到拒绝'))
    expect(await request).toBe('resolved')
    expect(useChatStore.getState().bySession[SID]).toBe(before)
    expect(before.runtime).toMatchObject({ running: false, lastRunOutcome: 'stopped', lastError: null })
  })

  it.each(['submit', 'continueGeneration'] as const)('%s 旧拒绝不能清下一轮排队的delta或撤下一轮消息', async (action) => {
    vi.useFakeTimers()
    try {
      seedMessages([userMsg('旧问题', 100), assistantMsg('旧前缀', 200)])
      const old = pendingRequest()
      engineRequest.mockImplementationOnce(() => old.promise)
      const request = (action === 'submit'
        ? useChatStore.getState().submit('本次问题')
        : useChatStore.getState().continueGeneration()).then(() => 'resolved', () => 'rejected')
      emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止' } })
      await useChatStore.getState().submit('新问题')
      emit({ method: 'message.delta', params: { sessionId: SID, messageId: 'new', kind: 'text', delta: '新尾字' } })
      const before = useChatStore.getState().bySession[SID]!
      old.reject(new Error('旧请求晚到拒绝'))
      expect(await request).toBe('resolved')
      expect(useChatStore.getState().bySession[SID]).toBe(before)
      vi.advanceTimersByTime(30)
      expect(messages().at(-1)).toMatchObject({ content: '新尾字' })
      expect(messages().some((m) => m.type === undefined && m.content === '新问题')).toBe(true)
      expect(useChatStore.getState().bySession[SID]!.runtime).toMatchObject({ running: true, lastRunOutcome: null, lastError: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['submit', 'continueGeneration'] as const)('删除后 %s 的拒绝不能复活会话桶', async (action) => {
    seedMessages([userMsg('旧问题', 100)])
    const old = pendingRequest()
    engineRequest.mockImplementationOnce(() => old.promise)
    const request = (action === 'submit'
      ? useChatStore.getState().submit('本次问题')
      : useChatStore.getState().continueGeneration()).then(() => 'resolved', () => 'rejected')
    await useChatStore.getState().deleteSession(SID)
    old.reject(new Error('已删除请求'))
    expect(await request).toBe('resolved')
    expect(useChatStore.getState().bySession[SID]).toBeUndefined()
  })

  it('准备期压缩被删会话后的迟到拒绝不复活桶，也不改其它会话', async () => {
    seedMessages([userMsg('旧问题', 100), assistantMsg('旧前缀', 200)])
    const old = pendingRequest()
    engineRequest.mockImplementationOnce(() => old.promise)
    const compacting = useChatStore.getState().compactNow()
    await useChatStore.getState().deleteSession(SID)
    const other = { ...emptyBucket(), messages: [userMsg('其它会话', 300)] }
    useChatStore.setState({ activeSessionId: 'other', bySession: { other } })
    old.reject(new Error('会话已结束，压缩未启动'))
    await compacting
    expect(useChatStore.getState().bySession[SID]).toBeUndefined()
    expect(useChatStore.getState().bySession.other).toBe(other)
  })

  it('当次submit被拒只撤自己的乐观user，不删除后到的无关消息，并继续向调用方报错', async () => {
    seedMessages([userMsg('旧问题', 100)])
    const current = pendingRequest()
    engineRequest.mockImplementationOnce(() => current.promise)
    const request = useChatStore.getState().submit('本次问题').then(() => 'resolved', () => 'rejected')
    const later = assistantMsg('后到消息', 500)
    useChatStore.setState((state) => patchBucket(state, SID, (bucket) => ({
      ...bucket, messages: [...bucket.messages, later]
    })))
    current.reject(new Error('当前提交被拒'))
    expect(await request).toBe('rejected')
    expect(messages()).toEqual([userMsg('旧问题', 100), later])
    expect(useChatStore.getState().bySession[SID]!.runtime).toMatchObject({ running: false, lastRunOutcome: 'failed', lastError: '当前提交被拒' })
  })
})

describe('回合终态按用户消息身份保留', () => {
  const outcomes = () => useChatStore.getState().bySession[SID]!.turnOutcomes
  const first = userMsg('写一个1000字文章', 100)

  function seedTurn(content?: string): void {
    seedMessages([first, ...(content === undefined ? [] : [{
      id: 'streaming', role: 'assistant' as const, content, timestamp: 200
    }])])
    useChatStore.setState((state) => patchBucket(state, SID, (bucket) => ({
      ...bucket, runtime: { ...bucket.runtime, running: true }
    })))
  }

  it.each([false, true])('停止时有正文=%s，下一次提交与完成都不丢旧结果', async (hasAnswer) => {
    seedTurn(hasAnswer ? '已经生成的半截' : undefined)
    await useChatStore.getState().abort()
    const partial = assistantMsg('已经生成的半截', 200)
    emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: hasAnswer ? [partial] : []
    } })
    expect(outcomes()).toEqual({ [first.id]: 'stopped' })

    await useChatStore.getState().submit('你好')
    const nextUser = messages().at(-1)!
    expect(outcomes()).toEqual({ [first.id]: 'stopped' })
    expect(useChatStore.getState().bySession[SID]!.runtime).toMatchObject({ running: true, lastRunOutcome: null })

    emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('你好呀', 400)] } })
    expect(outcomes()).toEqual({ [first.id]: 'stopped', [nextUser.id]: 'completed' })
    expect(messages().filter((message) => message.type === undefined && message.content === '已经生成的半截'))
      .toHaveLength(hasAnswer ? 1 : 0)
    expect(messages()[0]).toBe(first)
  })

  it('失败结果不因下一次提交被擦掉', async () => {
    seedTurn('尚未完成')
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'error', message: '连接中断' } })
    expect(outcomes()).toEqual({ [first.id]: 'failed' })
    await useChatStore.getState().submit('换一个问题')
    expect(outcomes()).toEqual({ [first.id]: 'failed' })
  })

  it('同文提问使用不同user.id分别记录，后一次成功不覆盖前一次停止', async () => {
    seedTurn()
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止', messages: [] } })
    await useChatStore.getState().submit(first.content)
    const repeatedUser = messages().at(-1)!
    expect(repeatedUser.id).not.toBe(first.id)
    emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('这次完成', 400)] } })
    expect(outcomes()).toEqual({ [first.id]: 'stopped', [repeatedUser.id]: 'completed' })
  })

  it('continue仍属于同一user，最终结果可以覆盖该回合但不新增身份', async () => {
    seedTurn('截断前缀')
    emit({ method: 'run.failed', params: {
      sessionId: SID, reason: 'aborted', message: '已停止', messages: [assistantMsg('截断前缀', 200)]
    } })
    await useChatStore.getState().continueGeneration()
    expect(outcomes()).toEqual({ [first.id]: 'stopped' })
    expect(messages().filter((message) => message.type === undefined && message.role === 'user')).toEqual([first])
    emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('截断前缀与新尾部', 400)] } })
    expect(outcomes()).toEqual({ [first.id]: 'completed' })
  })

  it('continue请求拒绝把已知user记为failed，不沿用先前stopped', async () => {
    seedTurn()
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止', messages: [] } })
    engineRequest.mockRejectedValueOnce(new Error('末条不允许续写'))
    await useChatStore.getState().continueGeneration()
    expect(outcomes()).toEqual({ [first.id]: 'failed' })
    expect(useChatStore.getState().bySession[SID]!.runtime.lastError).toBe('末条不允许续写')
  })

  it.each(['stopped', 'completed'] as const)('submit拒绝撤自己的user，不把上一%s回合改为failed', async (oldOutcome) => {
    seedTurn()
    if (oldOutcome === 'stopped') {
      emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止', messages: [] } })
    } else {
      emit({ method: 'run.completed', params: { sessionId: SID, messages: [assistantMsg('已完成', 200)] } })
    }
    engineRequest.mockRejectedValueOnce(new Error('当前提交被拒'))
    await expect(useChatStore.getState().submit('这条没有受理')).rejects.toThrow('当前提交被拒')
    expect(outcomes()).toEqual({ [first.id]: oldOutcome })
    expect(messages().filter((message) => message.type === undefined && message.role === 'user')).toEqual([first])
  })

  it('A后台停止只记录A，B完成及切回都保留各自的结果', async () => {
    seedTurn()
    const otherUser = { ...userMsg('B的问题', 300), id: 'b-user' }
    const other = { ...emptyBucket(), messages: [otherUser], runtime: { ...emptyBucket().runtime, running: true } }
    useChatStore.setState((state) => ({ bySession: { ...state.bySession, other }, activeSessionId: 'other' }))
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止', messages: [] } })
    expect(outcomes()).toEqual({ [first.id]: 'stopped' })
    expect(useChatStore.getState().bySession.other).toBe(other)
    emit({ method: 'run.completed', params: { sessionId: 'other', messages: [assistantMsg('B完成', 400)] } })
    expect(useChatStore.getState().bySession.other!.turnOutcomes).toEqual({ [otherUser.id]: 'completed' })
    await useChatStore.getState().selectSession(SID)
    expect(outcomes()).toEqual({ [first.id]: 'stopped' })
  })

  it('删除回收全部回合结果，同id重新水合不带旧元数据', async () => {
    seedTurn()
    emit({ method: 'run.failed', params: { sessionId: SID, reason: 'aborted', message: '已停止', messages: [] } })
    expect(outcomes()).toEqual({ [first.id]: 'stopped' })
    await useChatStore.getState().deleteSession(SID)
    expect(useChatStore.getState().bySession[SID]).toBeUndefined()
    engineRequest.mockResolvedValueOnce({ messages: [first], todos: [] })
    await useChatStore.getState().selectSession(SID)
    expect(outcomes()).toEqual({})
  })

  it('首次历史水合的结果未知，不从半截正文推断stopped', async () => {
    engineRequest.mockResolvedValueOnce({ messages: [first, assistantMsg('只有半句话', 200)], todos: [] })
    await useChatStore.getState().selectSession(SID)
    expect(outcomes()).toEqual({})
    expect(useChatStore.getState().bySession[SID]!.runtime.lastRunOutcome).toBeNull()
    expect(emptyBucket().turnOutcomes).toEqual({})
  })
})

describe('projectDefaultMode', () => {
  it('projectId 直配命中（defaultPermissionMode 有值才返回）', () => {
    useProjectStore.setState({
      projects: [
        { id: 'p1', name: 'A', cwds: ['C:/ws/a'], createdAt: 0, defaultPermissionMode: 'autonomous' },
        { id: 'p2', name: 'B', cwds: ['C:/ws/b'], createdAt: 0 }
      ]
    })
    expect(projectDefaultMode('p1')).toBe('autonomous')
    expect(projectDefaultMode('p2')).toBeUndefined()
    expect(projectDefaultMode('nope')).toBeUndefined()
  })

  it('cwd 前缀归属：命中 / 边界不误配 / 项目外 / 反斜杠归一', () => {
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'A', cwds: ['C:\\ws\\a'], createdAt: 0, defaultPermissionMode: 'auto' }]
    })
    expect(projectDefaultMode(undefined, 'C:\\WS\\A')).toBe('auto') // 大小写+斜杠归一
    expect(projectDefaultMode(undefined, 'c:/ws/a/sub/dir')).toBe('auto') // 子路径命中
    expect(projectDefaultMode(undefined, 'C:/ws/a-x')).toBeUndefined() // 前缀不补分隔符不误配
    expect(projectDefaultMode(undefined, 'C:/elsewhere')).toBeUndefined()
  })
})
