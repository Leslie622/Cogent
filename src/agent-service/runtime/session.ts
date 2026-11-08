/**
 * 会话运行时 —— pi Agent 的托管层，路线第 2 项的落点。
 *
 * 职责：
 * - 每会话一个 pi Agent 实例（transcript 隔离在 Agent.state.messages）；
 * - 用户文本（agent.submit）→ agent.prompt()，pi 事件流转译为协议事件
 *   （notify 回调注入，本文件不直接碰 stdout）；
 * - 模型目录（models.list）来自 pi 内置 catalog（builtinModels()）。
 *
 * 边界纪律：
 * - 只依赖 pi-* 与 protocol，零 Electron import（目录即边界）；
 * - handler 内信任协议类型，不做二次防御（约定.md §1.3，边界校验在 dispatch 入口）。
 */
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { MutableModels } from '@earendil-works/pi-ai'
import { ProtocolError, RpcErrorCode } from '../../protocol'
import type {
  ChatMessage,
  CustomProviderDef,
  ModelSummary,
  ProviderOverrideDef,
  ProtocolEvents,
  SessionSummary
} from '../../protocol'
import type { CredentialRegistry } from './credentials'
import { CustomProviderRegistry } from './custom-providers'

/** 引擎事件出口的类型别名：runtime 通过它上报事件，不关心传输层 */
export type Notify = <E extends keyof ProtocolEvents>(
  method: E,
  params: ProtocolEvents[E]
) => void

interface Session {
  summary: SessionSummary
  agent: Agent
}

/** 会话内 streaming 消息的累积缓冲（delta 拼出最终文本，agent_end 时落一条 ChatMessage） */
interface StreamingState {
  messageId: string
  text: string
  /** 思考缓冲（thinking_delta 累积；正文与思考是同一条 assistant 消息的两路） */
  thinking: string
  /** pi 停止原因（turn_end 时记录；length = 输出被 token 上限截断） */
  stopReason?: string
}

/** 首条消息截断为会话标题的长度上限 */
const TITLE_MAX_CHARS = 24
const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_PROVIDER = 'anthropic'

export class SessionManager {
  private sessions = new Map<string, Session>()
  private streaming = new Map<string, StreamingState>()
  private models: MutableModels
  private customProviders: CustomProviderRegistry
  private nextId = 1

  constructor(
    private credentials: CredentialRegistry,
    private notify: Notify
  ) {
    // pi 内置全部 provider 的模型目录；凭据解析经 Agent.getApiKey 查我们的内存表
    this.models = builtinModels()
    this.customProviders = new CustomProviderRegistry(this.models)
    this.customProviders.snapshotBuiltin()
  }

  /** 自定义 provider / 内置 baseUrl 覆盖的全量同步（providers.custom.sync 委托） */
  syncCustomProviders(defs: CustomProviderDef[], overrides: ProviderOverrideDef[]): number {
    return this.customProviders.sync(defs, overrides)
  }

  // ———— 会话 CRUD ————

  create(title?: string): SessionSummary {
    const now = Date.now()
    const summary: SessionSummary = {
      id: `s-${this.nextId++}`,
      title: title?.trim() || '新会话',
      createdAt: now,
      updatedAt: now
    }
    this.sessions.set(summary.id, { summary, agent: this.createAgent() })
    return summary
  }

  list(): SessionSummary[] {
    return Array.from(this.sessions.values(), (s) => s.summary)
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.agent.abort()
    this.sessions.delete(sessionId)
    this.streaming.delete(sessionId)
    return true
  }

  /** 会话消息转录（session.messages 响应）：pi Message[] → ChatMessage[] */
  messages(sessionId: string): ChatMessage[] {
    const session = this.requireSession(sessionId)
    return this.toChatMessages(session.agent.state.messages)
  }

  // ———— 模型目录 ————

  /** pi catalog → 协议模型摘要（UI 下拉数据源；key 配置状态在 credentials.list 单独查） */
  listModels(): ModelSummary[] {
    return this.models.getModels().map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens
    }))
  }

  /** 某模型的 provider 是否已配 key（renderer 据此置灰下拉项） */
  isProviderConfigured(modelId: string): boolean {
    const model = this.models.getModels().find((m) => m.id === modelId)
    return model !== undefined && this.credentials.has(model.provider)
  }

  // ———— Agent 主链路 ————

  /**
   * 提交用户输入。同步校验（会话存在、会话空闲、模型已知）后立即受理返回，
   * LLM 循环异步执行、进度经事件流推送 —— 协议刻意把"长任务"设计为事件驱动：
   * LLM 循环以分钟计，请求-响应会挂死宿主。
   *
   * 为什么校验必须同步 throw（→ dispatch 转错误响应帧）：dispatch 的 try/catch
   * 只包住 handler 的同步段，异步拒绝会变成 unhandledRejection 直接崩掉引擎
   * 进程（全部会话随之丢失）——此前 `void sessions.submit(...)` 正是踩了这一坑。
   */
  submit(sessionId: string, text: string, model?: string, thinkingLevel?: string): void {
    const session = this.requireSession(sessionId)
    // pi 约定同一 Agent 同时只跑一个 prompt（agent.js prompt 入口对 activeRun 抛错）。
    // 在受理入口显式拒绝成协议错误，而不是放它落进异步段崩进程
    if (session.agent.state.isStreaming) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, `会话正在回复中，请先停止或等待完成: ${sessionId}`)
    }
    if (model) {
      const target = this.models.getModel(DEFAULT_PROVIDER, model) ?? this.models.getModels().find((m) => m.id === model)
      if (!target) throw new Error(`未知模型: ${model}`)
      session.agent.state.model = target
    }
    if (thinkingLevel) {
      session.agent.state.thinkingLevel = thinkingLevel as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    }

    // 首条用户消息命名会话（会话列表可读性；title 命中后不再覆盖）
    if (session.summary.title === '新会话') {
      session.summary.title = text.trim().slice(0, TITLE_MAX_CHARS) || session.summary.title
    }
    session.summary.updatedAt = Date.now()

    this.notify('run.started', { sessionId })
    this.streaming.set(sessionId, { messageId: `m-${crypto.randomUUID()}`, text: '', thinking: '' })
    // prompt() 的运行期失败（流错误/中止）由 pi 事件流转译为 run.failed
    // （handleRunFailure → agent_end，见 pi-agent-integration.md §2.3），不会走到这层；
    // catch 只兜"受理检查通过后、pi 尚未发出任何事件前"的启动窗口拒绝 ——
    // 外部世界失败是常态（约定.md 1.1），必须转成 run.failed 给 UI 一个终态
    void session.agent.prompt(text).catch((error: unknown) => {
      this.streaming.delete(sessionId)
      this.notify('run.failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
    })
  }

  abort(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.agent.abort()
    return true
  }

  /** 进程退出前统一收尾（引擎随宿主关闭，无需异步等待） */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.agent.abort()
    this.sessions.clear()
    this.streaming.clear()
  }

  // ———— 内部 ————

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    return session
  }

  private createAgent(): Agent {
    const model = this.models.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL)
    if (!model) throw new Error(`默认模型不可用: ${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`)

    const agent = new Agent({
      initialState: {
        systemPrompt: 'You are Cogent, a helpful desktop agent.',
        model,
        thinkingLevel: 'off'
      },
      // streamFn 走 Models 集合：auth 解析、provider 分发、重试都由 pi-ai 承担
      streamFn: this.models.streamSimple.bind(this.models),
      // 每轮请求前从内存表解析 key（agent-loop.js:275；支持运行中换 key）
      getApiKey: (provider: string) => this.credentials.get(provider)
    })

    agent.subscribe((event) => this.translateEvent(agent, event))
    return agent
  }

  /** pi 事件 → 协议事件的单向转译（无状态副作用于 pi 对象本身） */
  private translateEvent(agent: Agent, event: AgentEvent): void {
    const sessionId = this.findSessionId(agent)
    if (!sessionId) return

    switch (event.type) {
      case 'message_update': {
        // 正文/思考两路增量各自转发（kind 分流）；toolcall 的 UI 呈现是后续路线项
        const delta = event.assistantMessageEvent
        if (delta.type !== 'text_delta' && delta.type !== 'thinking_delta') return
        const kind = delta.type === 'thinking_delta' ? ('thinking' as const) : ('text' as const)
        const streaming = this.streaming.get(sessionId)
        if (!streaming) return
        if (kind === 'thinking') streaming.thinking += delta.delta
        else streaming.text += delta.delta
        this.notify('message.delta', {
          sessionId,
          messageId: streaming.messageId,
          kind,
          delta: delta.delta
        })
        return
      }
      case 'turn_end': {
        // 记录停止原因：length = 输出被 token 上限截断（agent_end 事件本身不带此信息）
        if (event.message.role === 'assistant') {
          const streaming = this.streaming.get(sessionId)
          if (streaming) streaming.stopReason = event.message.stopReason
        }
        return
      }
      case 'agent_end': {
        const streaming = this.streaming.get(sessionId)
        this.streaming.delete(sessionId)
        const session = this.sessions.get(sessionId)
        if (!session) return
        session.summary.updatedAt = Date.now()

        // pi 约定：失败/中止在 Agent.state.errorMessage 留痕（stream error 也汇于此）
        if (agent.state.errorMessage) {
          this.notify('run.failed', { sessionId, message: agent.state.errorMessage })
          return
        }
        this.notify('run.completed', {
          sessionId,
          // 思考/正文任一非空都落消息（只有思考没有正文的极端截断也可见）
          message: streaming && (streaming.text || streaming.thinking)
            ? {
                id: streaming.messageId,
                role: 'assistant',
                content: streaming.text,
                thinking: streaming.thinking || undefined,
                timestamp: Date.now()
              }
            : undefined,
          stopReason: streaming?.stopReason
        })
        return
      }
      // agent_start / message_start|end：协议暂无对应事件，转译为空
      default:
        return
    }
  }

  /** Agent 实例反查会话 id（事件回调只带 agent 引用） */
  private findSessionId(agent: Agent): string | undefined {
    for (const [id, session] of this.sessions) {
      if (session.agent === agent) return id
    }
    return undefined
  }

  /** pi Message[] → ChatMessage[]：只取 user/assistant 的纯文本内容 */
  private toChatMessages(messages: AgentMessage[]): ChatMessage[] {
    const result: ChatMessage[] = []
    for (const message of messages) {
      // pi Message 联合类型按 role 收窄；system 消息是 prompt 载体，不对 UI 暴露
      if (message.role === 'user') {
        result.push({
          id: `u-${message.timestamp}`,
          role: 'user',
          content: typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
          timestamp: message.timestamp
        })
      } else if (message.role === 'assistant') {
        // 思考块拼整段挂 thinking（历史回查与流式结束态共用此映射）；正文仍取 text 块
        const thinking = message.content
          .map((block) => (block.type === 'thinking' ? block.thinking : ''))
          .join('')
        result.push({
          id: `a-${result.length}`,
          role: 'assistant',
          content: message.content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join(''),
          thinking: thinking || undefined,
          timestamp: Date.now()
        })
      }
    }
    return result
  }
}
