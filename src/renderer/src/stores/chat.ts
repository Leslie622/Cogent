/**
 * 聊天数据状态：会话列表、各会话消息、流式累积。
 * 数据源头是引擎事件流（onEngineEvent），store 是事件与 UI 之间的缓冲；
 * 初载（load）拉会话列表，选中会话时按需拉历史消息。
 */
import { create } from 'zustand'
import type { ChatMessage } from '@/env.d'

/** sessionId → 消息列表（含流式中的 assistant 消息）；Record 值按"可能缺"对待（Partial 语义） */
type MessagesBySession = Partial<Record<string, ChatMessage[]>>

interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

interface ChatState {
  sessions: SessionMeta[]
  activeSessionId: string | null
  /** sessionId → 消息列表（含流式中的 assistant 消息） */
  messagesBySession: MessagesBySession
  /** 当前是否在流式回复中（发送按钮态/停止按钮切换） */
  running: boolean
  /** 最近一次 run.failed 的错误文案（会话尾部错误条） */
  lastError: string | null
  /** 最近一次回复是否被 token 上限截断（stopReason=length，会话尾部提示条） */
  truncated: boolean

  /** 初载：拉会话列表；无会话时建一个（首屏即可直接发消息） */
  load: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  createSession: () => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  submit: (text: string, model?: string, thinkingLevel?: string) => Promise<void>
  abort: () => Promise<void>
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  running: false,
  lastError: null,
  truncated: false,

  load: async () => {
    let sessions = (await window.cogent.engineRequest('session.list', {})).map((s) => ({ ...s }))
    if (sessions.length === 0) {
      await get().createSession()
      sessions = (await window.cogent.engineRequest('session.list', {})).map((s) => ({ ...s }))
    }
    set({ sessions })
    if (get().activeSessionId === null && sessions.length > 0) {
      await get().selectSession(sessions[0].id)
    }
  },

  selectSession: async (sessionId) => {
    set({ activeSessionId: sessionId, lastError: null })
    // 按需拉历史（内存会话，切换时重拉一次；storage 落地后改为本地缓存）
    if (get().messagesBySession[sessionId] === undefined) {
      const { messages } = await window.cogent.engineRequest('session.messages', { sessionId })
      set((state) => ({ messagesBySession: { ...state.messagesBySession, [sessionId]: messages } }))
    }
  },

  createSession: async () => {
    const summary = await window.cogent.engineRequest('session.create', {})
    set((state) => ({
      sessions: [{ ...summary }, ...state.sessions],
      activeSessionId: summary.id,
      messagesBySession: { ...state.messagesBySession, [summary.id]: [] },
      lastError: null
    }))
  },

  deleteSession: async (sessionId) => {
    await window.cogent.engineRequest('session.delete', { sessionId })
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId)
      const messagesBySession = { ...state.messagesBySession }
      delete messagesBySession[sessionId]
      const activeSessionId =
        state.activeSessionId === sessionId ? (sessions[0]?.id ?? null) : state.activeSessionId
      return { sessions, messagesBySession, activeSessionId }
    })
  },

  submit: async (text, model, thinkingLevel) => {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    // 乐观上屏用户消息；assistant 回复由引擎事件流驱动
    const userMessage: ChatMessage = {
      id: `u-${crypto.randomUUID()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    }
    set((state) => ({
      running: true,
      lastError: null,
      truncated: false,
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: [...(state.messagesBySession[sessionId] ?? []), userMessage]
      }
    }))
    await window.cogent.engineRequest('agent.submit', { sessionId, text, model, thinkingLevel })
  },

  abort: async () => {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    await window.cogent.engineRequest('agent.abort', { sessionId })
  }
}))

/**
 * 引擎事件订阅：App 挂载时接一次，把事件流转译为 store 更新。
 * 放在 store 文件里保持"事件 → 状态"的转译集中一处，组件只读状态。
 */
export function bindEngineEvents(): () => void {
  return window.cogent.onEngineEvent((event) => {
    // 帧形状 = RpcEvent { jsonrpc, method, params }：业务载荷在 params 里（不是顶层！）
    const state = useChatStore.getState()
    const method = event.method
    const params = event.params as Record<string, unknown>
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
    if (!sessionId) return

    switch (method) {
      case 'message.delta': {
        const messages = state.messagesBySession[sessionId] ?? []
        // 流式累积进最后一条 assistant 消息；首条 delta 时占位消息尚不存在，先建
        const last = messages.at(-1)
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (last !== undefined && last.role === 'assistant' && last.id === 'streaming') {
          useChatStore.setState({
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: [...messages.slice(0, -1), { ...last, content: last.content + delta }]
            }
          })
        } else {
          useChatStore.setState({
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: [...messages, { id: 'streaming', role: 'assistant', content: delta, timestamp: Date.now() }]
            }
          })
        }
        return
      }
      case 'run.completed': {
        const messages = state.messagesBySession[sessionId] ?? []
        // 用引擎回传的最终消息替换流式占位（id 从 'streaming' 变为真实 id）
        const finalMessage = params.message as ChatMessage | undefined
        const finalMessages =
          finalMessage !== undefined
            ? [...messages.filter((m) => m.id !== 'streaming'), finalMessage]
            : messages.filter((m) => m.id !== 'streaming')
        const truncated = params.stopReason === 'length'
        useChatStore.setState((s) => ({
          running: false,
          truncated,
          messagesBySession: { ...s.messagesBySession, [sessionId]: finalMessages },
          // 首条消息后标题已在引擎侧生成；刷新会话列表反映标题变化
          sessions: s.sessions.map((session) =>
            session.id === sessionId ? { ...session, updatedAt: Date.now() } : session
          )
        }))
        void refreshSessionTitle(sessionId)
        return
      }
      case 'run.failed': {
        const messages = (state.messagesBySession[sessionId] ?? []).filter((m) => m.id !== 'streaming')
        useChatStore.setState({
          running: false,
          truncated: false,
          lastError: typeof params.message === 'string' ? params.message : '未知错误',
          messagesBySession: { ...state.messagesBySession, [sessionId]: messages }
        })
        return
      }
      // tool.* / approval.*：审批流落地后接入，先忽略
      default:
        return
    }
  })
}

/** run.completed 后回查一次会话列表，让"首条消息生成标题"反映到侧栏 */
async function refreshSessionTitle(sessionId: string): Promise<void> {
  const sessions = await window.cogent.engineRequest('session.list', {})
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      const fresh = sessions.find((s) => s.id === session.id)
      return fresh ? { ...session, title: fresh.title, updatedAt: fresh.updatedAt } : session
    })
  }))
  void sessionId
}
