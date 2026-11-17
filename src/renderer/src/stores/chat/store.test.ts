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
  engineRequest.mockReset().mockResolvedValue([])
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

  it('run.failed 带分段终态：已完成轮替换流式区（usage 落账，指示器停止后即真实值）', () => {
    // 流式态：user + 占位 + running 工具卡（abort 场景：一轮已完成、下一轮被打断）
    seedMessages([
      userMsg('u1', 100),
      { id: 't1', type: 'tool', name: 'read', toolKind: 'read', summary: 'read(a)', status: 'running', startedAt: 150 },
      { id: 'streaming', role: 'assistant', content: '半截', timestamp: 200 }
    ])
    // 走 store 的真实写入姿势（patchBucket 兜底建桶），免手搓 Partial 索引
    useChatStore.setState((state) =>
      patchBucket(state, SID, (bucket) => ({ ...bucket, runtime: { ...bucket.runtime, stopping: true } }))
    )
    emit({ method: 'run.failed', params: { sessionId: SID, message: '已中止', messages: [usageMsg(1)] } })
    const list = messages()
    // 引擎已完成轮的 usage 落进消息流；被截断的半截正文续在其后（封存保留）
    const withUsage = list.find((m): m is ChatMessage => m.type === undefined && m.usage !== undefined)
    expect(withUsage?.usage?.input).toBe(100)
    expect(list.some((m) => m.type === undefined && m.content === '半截')).toBe(true)
    expect(useChatStore.getState().bySession[SID]?.runtime.running).toBe(false)
    expect(useChatStore.getState().bySession[SID]?.runtime.lastError).toBeNull() // 停止不是错误
  })
})

// ———— projectDefaultMode（F6 项目级默认权限，createSession 解析链一环） ————

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
