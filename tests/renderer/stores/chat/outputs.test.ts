/** 真实产物事件与历史水合：旧revision、删桶迟到、流式期间水合均按owner处理。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '@/env.d'
import type { TurnOutputs } from '@shared/outputs'
import { emptyBucket, useChatStore } from '@/stores/chat/store'
import { bindEngineEvents } from '@/stores/chat/events'
import { useHomeStore } from '@/stores/home'
const doc: TurnOutputs = { version: 1, sessionId: 's1', turnId: 't1', revision: 3, state: 'ready', declared: true, active: [], published: [] }
let emit: (event: EngineEvent) => void
const request = vi.fn<(method: string) => Promise<unknown>>()
beforeEach(() => {
  useChatStore.setState({ activeSessionId: 's1', bySession: { s1: emptyBucket() } })
  window.cogent = { engineRequest: request, onEngineEvent: (handler: (event: EngineEvent) => void) => { emit = handler; return () => {} } } as unknown as typeof window.cogent
  request.mockReset(); bindEngineEvents()
})
describe('产物状态水合', () => {
  it('迟到旧revision不覆盖新状态，删除后的事件不复活桶', () => {
    emit({ method: 'outputs.updated', params: doc })
    emit({ method: 'outputs.updated', params: { ...doc, revision: 2, state: 'running' } })
    expect(useChatStore.getState().bySession.s1!.outputs.t1!.state).toBe('ready')
    useChatStore.setState({ bySession: {} })
    emit({ method: 'outputs.updated', params: { ...doc, revision: 4 } })
    expect(useChatStore.getState().bySession.s1).toBeUndefined()
  })
  it('历史未返回前收到新事件，新快照优先；消息增量不会让历史产物整批丢失', async () => {
    useChatStore.setState({ bySession: {} })
    let finish!: (docs: TurnOutputs[]) => void
    request.mockImplementation((method) => method === 'session.messages' ? Promise.resolve({ messages: [] }) : new Promise((resolve) => { finish = resolve }))
    const select = useChatStore.getState().selectSession('s1')
    await vi.waitFor(() => expect(finish).toBeDefined())
    emit({ method: 'outputs.updated', params: { ...doc, revision: 4, state: 'running' } })
    useChatStore.setState((state) => ({ bySession: { ...state.bySession, s1: { ...state.bySession.s1!, messages: [{ id: 'a1', role: 'assistant', content: '新消息', timestamp: 0 }] } } }))
    finish([doc, { ...doc, turnId: 'older', revision: 1 }]); await select
    expect(useChatStore.getState().bySession.s1!.outputs.t1!.revision).toBe(4)
    expect(useChatStore.getState().bySession.s1!.outputs.older).toBeDefined()
  })
  it('旧桶历史在同名桶重建后返回也不能借身份写入', async () => {
    useChatStore.setState({ bySession: {} })
    let finish!: (docs: TurnOutputs[]) => void
    request.mockImplementation((method) => method === 'session.messages' ? Promise.resolve({ messages: [] }) : new Promise((resolve) => { finish = resolve }))
    const select = useChatStore.getState().selectSession('s1')
    await vi.waitFor(() => expect(finish).toBeDefined())
    useChatStore.setState({ bySession: { s1: emptyBucket() } })
    finish([doc]); await select
    expect(useChatStore.getState().bySession.s1!.outputs).toEqual({})
  })
  it('启动恢复不等待产物磁盘查询，先恢复真实聊天与草稿身份', async () => {
    useHomeStore.setState({ session: { kind: 'new', draftId: 'initial' } })
    useChatStore.setState({ activeSessionId: null, bySession: {} })
    let finish!: (docs: TurnOutputs[]) => void
    request.mockImplementation((method) => method === 'session.list'
      ? Promise.resolve([{ id: 's1', title: '原聊天', createdAt: 0, updatedAt: 0 }])
      : method === 'session.messages' ? Promise.resolve({ messages: [] })
      : new Promise((resolve) => { finish = resolve }))
    await useChatStore.getState().load()
    expect(useHomeStore.getState().session).toEqual({ kind: 'chat', chatId: 's1' })
    expect(useChatStore.getState().bySession.s1!.outputs).toEqual({})
    finish([doc]); await vi.waitFor(() => expect(useChatStore.getState().bySession.s1!.outputs.t1).toBeDefined())
  })
})
