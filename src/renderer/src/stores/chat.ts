/**
 * 聊天数据状态：会话列表、各会话消息、流式累积。
 * 数据源头是引擎事件流（onEngineEvent），store 是事件与 UI 之间的缓冲；
 * 初载（load）拉会话列表，选中会话时按需拉历史消息。
 *
 * 运行态分域（2026-11-10，架构审查修复）：running/lastError/truncated 一律按
 * sessionId 分域（同 console store 的 runningBySession 手法）。此前是全局单例：
 * 会话 A 流式中切到 B 发消息，A 完成会把全局 running 置 false → B 的停止钮
 * 错变发送；反向则 B 的输入框被 A 的 running 锁死；错误/截断文案也会串会话。
 * 组件侧用 selectRunning / selectLastError / selectTruncated 取活动会话的视图。
 */
import { create } from 'zustand'
import type { ChatMessage, SessionSummary } from '@/env.d'
import { useHomeStore } from '@/stores/home'

/** sessionId → 消息列表（含流式中的 assistant 消息）；Record 值按"可能缺"对待（Partial 语义） */
type MessagesBySession = Partial<Record<string, ChatMessage[]>>

/** 引擎 SessionSummary 的 renderer 侧直接镜像（env.d.ts），不再本地重复声明 */
export type { SessionSummary }

export interface ChatState {
  sessions: SessionSummary[]
  activeSessionId: string | null
  /** sessionId → 消息列表（含流式中的 assistant 消息） */
  messagesBySession: MessagesBySession
  /** sessionId → 是否流式中（发送/停止钮切换；分域防跨会话互踩） */
  runningBySession: Partial<Record<string, boolean>>
  /** sessionId → 最近一次 run.failed 的错误文案（会话尾部错误条） */
  lastErrorBySession: Partial<Record<string, string>>
  /** sessionId → 最近一次回复是否被 token 上限截断（stopReason=length） */
  truncatedBySession: Partial<Record<string, boolean>>
  /** 初载失败的原因（引擎不可用等；App 横幅呈现）。null = 正常 */
  loadError: string | null

  /** 初载：拉会话列表并选中最近会话。空列表（首装/全部已归档）不自动建会话，
      落"新聊天"着陆页、发送时由 submit 按需物化 —— 会话只随用户动作产生 */
  load: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  /** 建会话并设为活动，返回新会话 id（submit 按需物化后直取，不回读状态判空） */
  createSession: (params?: { cwd?: string; projectId?: string }) => Promise<string>
  deleteSession: (sessionId: string) => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  archive: (sessionId: string, archived: boolean) => Promise<void>
  submit: (text: string, model?: string, thinkingLevel?: string, provider?: string) => Promise<void>
  abort: () => Promise<void>
}

/** 活动会话是否流式中（组件订阅用；返回原始值，selector 引用稳定） */
export function selectRunning(state: ChatState): boolean {
  return state.activeSessionId !== null && state.runningBySession[state.activeSessionId] === true
}

/** 活动会话的最近错误文案（无 = null） */
export function selectLastError(state: ChatState): string | null {
  if (state.activeSessionId === null) return null
  return state.lastErrorBySession[state.activeSessionId] ?? null
}

/** 活动会话的最近回复是否被截断 */
export function selectTruncated(state: ChatState): boolean {
  return state.activeSessionId !== null && state.truncatedBySession[state.activeSessionId] === true
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  runningBySession: {},
  lastErrorBySession: {},
  truncatedBySession: {},
  loadError: null,

  // 初载不自动建会话：归档是回收站语义，"活跃列表空"有两种含义 —— 首装，或
  // 用户归档了全部会话（合法终态）。原"列表空就建一个"在后者每次重启都复活
  // 一个幽灵"新会话"（用户归档两个会话后重启"还在"的元凶；且 StrictMode 双
  // 挂载下 load 并发跑两遍会各建一个，盘上留下 13ms 双胞胎）。空列表统一落
  // "新聊天"着陆页，会话改由用户动作物化（点新聊天 = startNew，发首条消息
  // = submit 按需建）
  // 失败落 loadError（引擎不可用时 App 横幅呈现 + 重试），不再裸抛成
  // unhandled rejection
  load: async () => {
    try {
      const sessions = await window.cogent.engineRequest('session.list', {})
      set({ sessions, loadError: null })
      if (get().activeSessionId === null && sessions.length > 0) {
        await get().selectSession(sessions[0].id)
        // 视图态对齐（修"重启后已有内容的会话还挂着信息区"）：load 自动选中了
        // 最近会话，home store 若还停在默认 kind:'new'，就会出现"对话内容 +
        // 选择项目信息条"同屏的错排 —— 选中即 chat 态
        useHomeStore.setState({ session: { kind: 'chat', chatId: sessions[0].id } })
      }
    } catch (error) {
      set({ loadError: error instanceof Error ? error.message : String(error) })
    }
  },

  selectSession: async (sessionId) => {
    set({ activeSessionId: sessionId })
    // 按需拉历史（盘上转录已持久化，切换时重拉一次拿最新；本地缓存优化属后续件）
    if (get().messagesBySession[sessionId] === undefined) {
      const { messages } = await window.cogent.engineRequest('session.messages', { sessionId })
      set((state) => ({ messagesBySession: { ...state.messagesBySession, [sessionId]: messages } }))
    }
  },

  createSession: async (params) => {
    const summary = await window.cogent.engineRequest('session.create', params ?? {})
    set((state) => ({
      sessions: [{ ...summary }, ...state.sessions],
      activeSessionId: summary.id,
      messagesBySession: { ...state.messagesBySession, [summary.id]: [] }
    }))
    return summary.id
  },

  /** 置顶/取消（引擎侧落 pinnedAt 并持久化）；同步更新列表内该会话的摘要 */
  setPinned: async (sessionId, pinned) => {
    const { summary } = await window.cogent.engineRequest('session.setPinned', { sessionId, pinned })
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? summary : s))
    }))
  },

  /** 归档/恢复（回收站语义）：引擎 session.list 已滤掉归档会话，本地把摘要移出
      列表（恢复动作在设置页归档视图，archive(chatId,false) 后经 load 语义回到
      主列表——这里恢复时不强拉列表，由调用方刷新）。归档**活动**会话时视图才落
      kind:'new'（须比对 chatId：侧栏可归档任意后台会话，无条件踢视图会把
      正打开的对话误拉到新聊天着陆页） */
  archive: async (sessionId, archived) => {
    await window.cogent.engineRequest('session.archive', { sessionId, archived })
    set((state) => ({
      sessions: archived ? state.sessions.filter((s) => s.id !== sessionId) : state.sessions,
      activeSessionId:
        archived && state.activeSessionId === sessionId ? null : state.activeSessionId
    }))
    const home = useHomeStore.getState().session
    if (archived && home.kind === 'chat' && home.chatId === sessionId) {
      useHomeStore.setState({ session: { kind: 'new' } })
    }
  },

  deleteSession: async (sessionId) => {
    await window.cogent.engineRequest('session.delete', { sessionId })
    const wasActive = get().activeSessionId === sessionId
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId)
      const messagesBySession = { ...state.messagesBySession }
      delete messagesBySession[sessionId]
      const runningBySession = { ...state.runningBySession }
      delete runningBySession[sessionId]
      const lastErrorBySession = { ...state.lastErrorBySession }
      delete lastErrorBySession[sessionId]
      const truncatedBySession = { ...state.truncatedBySession }
      delete truncatedBySession[sessionId]
      return {
        sessions,
        messagesBySession,
        runningBySession,
        lastErrorBySession,
        truncatedBySession,
        // 删除活动会话与归档同款落点：视图落"新聊天"（不再自动跳 sessions[0] ——
        // 旧行为不触发 selectSession，目标会话消息未拉取会白屏）
        activeSessionId: wasActive ? null : state.activeSessionId
      }
    })
    const home = useHomeStore.getState().session
    if (wasActive && home.kind === 'chat' && home.chatId === sessionId) {
      useHomeStore.setState({ session: { kind: 'new' } })
    }
  },

  submit: async (text, model, thinkingLevel, provider) => {
    // 无活动会话时按需物化：空列表着陆页（首装/全部归档后重启）直接发送。
    // 此前 activeSessionId 为 null 静默 return = 丢消息。projectId 取新聊天
    // 视图态 —— 会话与项目的绑定只在 session.create 时可定（同 ProjectPicker
    // 的串归属边界），chat 视图态不会有"活动会话为空"（archive/delete 已换落）
    const home = useHomeStore.getState().session
    const sessionId =
      get().activeSessionId ??
      (await get().createSession(
        home.kind === 'new' && home.projectId !== undefined ? { projectId: home.projectId } : undefined
      ))
    // 乐观上屏用户消息；assistant 回复由引擎事件流驱动
    const userMessage: ChatMessage = {
      id: `u-${crypto.randomUUID()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    }
    set((state) => ({
      runningBySession: { ...state.runningBySession, [sessionId]: true },
      lastErrorBySession: { ...state.lastErrorBySession, [sessionId]: undefined },
      truncatedBySession: { ...state.truncatedBySession, [sessionId]: undefined },
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: [...(state.messagesBySession[sessionId] ?? []), userMessage]
      }
    }))
    // provider 随 model 下发：同名模型被多家目录收录（azure 也收录 deepseek-v4-pro），
    // 只传 id 引擎全局查找有歧义（详见 protocol AgentSubmitParams.provider 注释）
    try {
      await window.cogent.engineRequest('agent.submit', { sessionId, text, model, thinkingLevel, provider })
    } catch (error) {
      // renderer→引擎边界（合法设防位）：引擎进程退出/未就绪时 main 拒绝在途请求，
      // 事件流的终态（run.failed）不会来 —— 必须自己收尾运行态，否则输入框永久
      // 锁死。乐观上屏的用户消息一并撤回（没提交成功，留着会在重发时出现双条），
      // 错误落该会话的错误条；rethrow 让调用方（send）回填输入框文本
      useChatStore.setState((state) => ({
        runningBySession: { ...state.runningBySession, [sessionId]: false },
        lastErrorBySession: {
          ...state.lastErrorBySession,
          [sessionId]: error instanceof Error ? error.message : String(error)
        },
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: (state.messagesBySession[sessionId] ?? []).slice(0, -1)
        }
      }))
      throw error
    }
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
 * 帧形状 = env.d.ts 的 EngineEvent 判别联合：switch(method) 自然窄化 params，
 * 不做 as + typeof 抽查 —— 那会把联合拆成 untyped record，类型系统从此拦不住
 * 取错字段（当初形状 bug 的成因，见约定.md §1.2-7）。
 */
export function bindEngineEvents(): () => void {
  return window.cogent.onEngineEvent((event) => {
    switch (event.method) {
      case 'message.delta': {
        const { sessionId, delta, kind } = event.params
        const isThinking = kind === 'thinking'
        // 函数式更新：delta 是逐 token 高频路径，不依赖"回调间无并发更新"的
        // 隐式前提（开头快照 + 非函数式 set 在事件合帧时会读到 stale state）
        useChatStore.setState((state) => {
          const messages = state.messagesBySession[sessionId] ?? []
          // 流式累积进最后一条 assistant 消息；首条 delta 时占位消息尚不存在，先建。
          // kind 分流：thinking 进思考缓冲、text 进正文（同一条消息的两路，引擎保证同 messageId）
          const last = messages.at(-1)
          const next =
            last !== undefined && last.role === 'assistant' && last.id === 'streaming'
              ? [
                  ...messages.slice(0, -1),
                  isThinking
                    ? { ...last, thinking: (last.thinking ?? '') + delta }
                    : { ...last, content: last.content + delta }
                ]
              : [
                  ...messages,
                  {
                    id: 'streaming',
                    role: 'assistant' as const,
                    content: isThinking ? '' : delta,
                    thinking: isThinking ? delta : undefined,
                    timestamp: Date.now()
                  }
                ]
          return { messagesBySession: { ...state.messagesBySession, [sessionId]: next } }
        })
        return
      }
      case 'run.completed': {
        const { sessionId, message, stopReason } = event.params
        useChatStore.setState((state) => {
          const messages = state.messagesBySession[sessionId] ?? []
          // 用引擎回传的最终消息替换流式占位（id 从 'streaming' 变为真实 id）
          const finalMessages =
            message !== undefined
              ? [...messages.filter((m) => m.id !== 'streaming'), message]
              : messages.filter((m) => m.id !== 'streaming')
          return {
            runningBySession: { ...state.runningBySession, [sessionId]: false },
            truncatedBySession: { ...state.truncatedBySession, [sessionId]: stopReason === 'length' },
            messagesBySession: { ...state.messagesBySession, [sessionId]: finalMessages },
            // 首条消息后标题已在引擎侧生成；updatedAt 顺带推进（排序口径）
            sessions: state.sessions.map((session) =>
              session.id === sessionId ? { ...session, updatedAt: Date.now() } : session
            )
          }
        })
        void refreshSessionTitle()
        return
      }
      case 'run.failed': {
        const { sessionId, message } = event.params
        useChatStore.setState((state) => ({
          runningBySession: { ...state.runningBySession, [sessionId]: false },
          truncatedBySession: { ...state.truncatedBySession, [sessionId]: false },
          lastErrorBySession: { ...state.lastErrorBySession, [sessionId]: message },
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: (state.messagesBySession[sessionId] ?? []).filter((m) => m.id !== 'streaming')
          }
        }))
        return
      }
      // tool.* / approval.*：审批流落地后接入，先忽略
      default:
        return
    }
  })
}

/** run.completed 后回查一次会话列表，让"首条消息生成标题"反映到侧栏 */
async function refreshSessionTitle(): Promise<void> {
  const sessions = await window.cogent.engineRequest('session.list', {})
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      const fresh = sessions.find((s) => s.id === session.id)
      return fresh ? { ...session, title: fresh.title, updatedAt: fresh.updatedAt } : session
    })
  }))
}
