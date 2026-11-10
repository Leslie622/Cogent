/**
 * 会话运行时 —— pi Agent 的托管层，路线第 2 项 + 存储落地（2026-11-09，
 * docs/计划-工作区与会话真实化.md 第 1 步）的落点。
 *
 * 职责：
 * - 每会话一个 pi Agent 实例（transcript 隔离在 Agent.state.messages）；
 * - 用户文本（agent.submit）→ agent.prompt()，pi 事件流转译为协议事件
 *   （notify 回调注入，本文件不直接碰 stdout）；
 * - 会话/转录持久化：回合边界（create/delete/agent_end）整文档落盘；
 *   启动时只恢复摘要，pi Agent 惰性重建（首次使用才实例化+灌转录）。
 *
 * 持久化决策（对比讨论见 docs/技术笔记/session-storage.md）：
 * - 落盘 = 存 pi 完整转录（AgentMessage[]），ChatMessage 只是读时投影 ——
 *   恢复要保真（思考块/将来 toolCall），投影是有损形态不可作存储格式；
 * - 写时机 = 回合边界而非逐 delta：LLM 流式一秒多拍，逐拍写盘是写放大；
 *   回合内崩溃丢当前回合（进程重启场景本就要重发），已完成回合永不丢；
 * - 落盘失败不崩引擎、不吞 run.completed：外部世界失败是常态（约定.md §1.1），
 *   用户回合已经成功，存储故障只记诊断 + 转录留内存待下次回合重写 ——
 *   这是"尽力落盘"语义；若把 run.completed 也判失败，等于让存储故障
 *   回滚一次成功的模型回复，得不偿失。
 *
 * 边界纪律：
 * - 只依赖 pi-* 与 protocol 与 ../storage，零 Electron import（目录即边界）；
 * - handler 内信任协议类型，不做二次防御（约定.md §1.3，边界校验在 dispatch 入口）。
 */
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { MutableModels, Usage } from '@earendil-works/pi-ai'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProtocolError, RpcErrorCode } from '../../protocol'
import type {
  ChatMessage,
  CustomProviderDef,
  InspectEntryDetail,
  InspectEntrySummary,
  MessageUsage,
  ModelSummary,
  ProviderOverrideDef,
  ProtocolEvents,
  SessionSummary
} from '../../protocol'
import type { CredentialRegistry } from './credentials'
import { CustomProviderRegistry } from './custom-providers'
import { SessionInspector } from './inspector'
import type { ProjectRegistry } from './project'
import type { InspectStore, StorageDriver } from '../storage'

/** 引擎事件出口的类型别名：runtime 通过它上报事件，不关心传输层 */
export type Notify = <E extends keyof ProtocolEvents>(
  method: E,
  params: ProtocolEvents[E]
) => void

/** 会话盘上文档形状：摘要 + 完整转录（pi AgentMessage[]，含 system/user/assistant） */
interface StoredSession {
  version: 1
  summary: SessionSummary
  transcript: AgentMessage[]
}

/**
 * 启动恢复时的盘上数据收窄（信任边界：磁盘旧数据可能被手改/属旧版本格式）。
 * 只校验本层依赖的三个字段（version/summary.id/transcript 是数组）；转录内层
 * 结构信任 pi 的写入（引擎自己落的盘，形状由 StoredSession 类型保证）。
 */
function asStoredSession(doc: unknown, id: string): StoredSession {
  if (typeof doc !== 'object' || doc === null) throw new Error(`会话文档形状不合法（sessions/${id}.json）`)
  const d = doc as Partial<StoredSession>
  if (d.version !== SESSION_FILE_VERSION || typeof d.summary?.id !== 'string' || !Array.isArray(d.transcript)) {
    throw new Error(`会话文档版本/形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  return d as StoredSession
}

/** 内存态会话：Agent 惰性 —— 恢复的会话在首次 submit/messages 时才重建实例 */
interface Session {
  summary: SessionSummary
  /** 持久转录（真源）；agent 存在时两者一致（agent_end 后同步） */
  transcript: AgentMessage[]
  /** pi Agent 实例；undefined = 尚未（重）建 —— 惰性重建的落点 */
  agent?: Agent
  /**
   * 运行时控制台记录器；undefined = 尚未使用 —— 惰性（同 Agent）：构造要读
   * inspect/<id>.jsonl 尾部（含详情，可达 MB 级），启动期全量恢复会话会白吃内存；
   * 首次 submit / inspect 读取时才建，seq/run 从落盘尾部接续
   */
  inspector?: SessionInspector
}

/** AGENTS.md 只读加载的长度上限（字符）——巨型指令文件不吃满上下文 */
const AGENTS_MD_MAX_CHARS = 16_000

/**
 * 系统提示词装配（工作区上下文注入 + 多根化 2026-11-09）：基础人设 +
 * 工作区声明（多目录，首个为主根）+ 环境块（每根一行含 git 分支）+
 * 各根 AGENTS.md。这是"工作区对模型生效"的第①通道（文字声明）——
 * 模型没有 cwd 概念，相对路径指哪全靠这里讲清（四通道模型见计划 §0）。
 */
function buildSystemPrompt(roots: string[]): string {
  let prompt = 'You are Cogent, a helpful desktop agent.'
  if (roots.length === 0) return prompt

  const declared =
    roots.length === 1
      ? roots[0]
      : `${roots.map((r, i) => `${i + 1}. ${r}`).join('\n')}（首个为主根）`
  prompt += `\n\n# 工作区\n你在用户的本地工作区中工作：${declared}` +
    '\n用户消息里的相对路径（文件/目录）都相对这些根目录解析；未指明时优先主根。'

  // 环境块（Claude Code 手法）：平台 + 每根目录与 git 分支（直读 .git/HEAD，
  // 不 spawn 子进程 —— Windows 上免 git 依赖；非仓库/解析失败省略分支尾）
  prompt += `\n\n# 环境\n- 平台: ${process.platform}`
  for (const root of roots) {
    const branch = readGitBranch(root)
    prompt += `\n- 工作区: ${root}${branch !== null ? `（Git 分支: ${branch}）` : ''}`
  }

  // 各根 AGENTS.md（项目给模型的指令，只读消费；存在才拼、每根限长）
  for (const root of roots) {
    const agentsFile = join(root, 'AGENTS.md')
    if (!existsSync(agentsFile)) continue
    try {
      const content = readFileSync(agentsFile, 'utf-8')
      const trimmed = content.length > AGENTS_MD_MAX_CHARS
        ? `${content.slice(0, AGENTS_MD_MAX_CHARS)}\n\n[AGENTS.md 已截断]`
        : content
      const label =
        roots.length > 1 ? `工作区指令（${root} 的 AGENTS.md）` : '工作区指令（AGENTS.md）'
      prompt += `\n\n# ${label}\n${trimmed}`
    } catch (error) {
      // 读失败不挡会话创建：指令文件是增益不是必需品（外部世界失败是常态）
      process.stderr.write(`[agent-service] AGENTS.md 读取失败（跳过 ${root}）: ${(error as Error).message}\n`)
    }
  }
  return prompt
}


/** git 当前分支：解析 <cwd>/.git/HEAD 的 ref: refs/heads/<branch>；非仓库/异常返回 null */
function readGitBranch(cwd: string): string | null {
  try {
    const head = join(cwd, '.git', 'HEAD')
    if (!existsSync(head)) return null
    const content = readFileSync(head, 'utf-8').trim()
    const match = /^ref: refs\/heads\/(.+)$/.exec(content)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** 会话内 streaming 消息的累积缓冲（delta 拼出最终文本，agent_end 时落一条 ChatMessage） */
interface StreamingState {
  messageId: string
  text: string
  /** 思考缓冲（thinking_delta 累积；正文与思考是同一条 assistant 消息的两路） */
  thinking: string
  /** pi 停止原因（turn_end 时记录；length = 输出被 token 上限截断） */
  stopReason?: string
  /** token 用量（turn_end 各轮累加；见 accumulateUsage 的口径注释） */
  usage?: MessageUsage
  /** 模型耗时毫秒（各轮 durationMs 之和；pi 未计时的轮次按缺省跳过，不含工具执行时间） */
  durationMs?: number
  /** 模型 id（末轮记录） */
  model?: string
}

/** pi Usage → 协议 MessageUsage：只投影 UI 所需（cost 明细不带，total 一项即总账） */
function projectUsage(usage: Usage): MessageUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    totalCost: usage.cost.total,
    // 显式存布尔而非透传 optional：pi 里缺省与 false 同为"估价"，归一后落盘形状稳定
    totalCostFromProvider: usage.cost.totalFromProvider ?? false
  }
}

/** optional 数值相加：双侧缺省保持缺省（"没报告" ≠ "报告了 0"） */
function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

/**
 * 用量累加（工具循环多轮时 turn_end 逐轮到达，当前无工具 = 恒单轮直通）。
 * 口径 = 各轮之和：每轮请求都携带全量上下文重发，端点账单就是逐轮相加，
 * 这也是"本次回答共消耗多少"的计费真相，而非只看末轮。
 */
function accumulateUsage(current: MessageUsage | undefined, add: MessageUsage): MessageUsage {
  if (!current) return add
  return {
    input: current.input + add.input,
    output: current.output + add.output,
    cacheRead: current.cacheRead + add.cacheRead,
    cacheWrite: current.cacheWrite + add.cacheWrite,
    reasoning: sumOptional(current.reasoning, add.reasoning),
    totalTokens: current.totalTokens + add.totalTokens,
    totalCost: sumOptional(current.totalCost, add.totalCost),
    // 成本口径跟随求和：任何一轮是估价，总和就只能是估价（缺省按估价参与 AND）
    totalCostFromProvider:
      (current.totalCostFromProvider ?? false) && (add.totalCostFromProvider ?? false)
  }
}

/** 盘上文档格式版本（将来字段演进据此迁移，同 credentials.json 的 version 手法） */
const SESSION_FILE_VERSION = 1/** 会话集合名（StorageDriver 顶层目录 ~/.cogent/sessions/） */
const SESSION_COLLECTION = 'sessions'
/** 首条消息截断为会话标题的长度上限 */
const TITLE_MAX_CHARS = 24
const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_PROVIDER = 'anthropic'

export class SessionManager {
  private sessions = new Map<string, Session>()
  private streaming = new Map<string, StreamingState>()
  private models: MutableModels
  private customProviders: CustomProviderRegistry
  /** 项目注册表（构造注入；submit/createAgent 时解析 projectId → 项目多根目录） */
  private projects: ProjectRegistry

  constructor(
    private credentials: CredentialRegistry,
    private storage: StorageDriver,
    private notify: Notify,
    projects: ProjectRegistry,
    private inspectStore: InspectStore
  ) {
    this.projects = projects
    // pi 内置全部 provider 的模型目录；凭据解析经 Agent.getApiKey 查我们的内存表
    this.models = builtinModels()
    this.customProviders = new CustomProviderRegistry(this.models)
    this.customProviders.snapshotBuiltin()
    // 启动恢复：只拉摘要（惰性重建，见 Session.agent / Session.inspector 注释）。
    // 磁盘损坏在驱动 get 处已 throw；形状不合法（老版本盘数据/手改）在此报错，
    // 静默跳过会丢用户会话（约定.md §1.1 持久化读取行）
    for (const id of this.storage.ids(SESSION_COLLECTION)) {
      const doc = asStoredSession(this.storage.get(SESSION_COLLECTION, id), id)
      this.sessions.set(doc.summary.id, { summary: doc.summary, transcript: doc.transcript })
    }
  }

  /**
   * 记录器惰性建（首用 = submit 或 inspect 读取）：落盘尾部做 seed（重启回看 +
   * seq/run 接续），append 钩子接 InspectStore —— 记录常开，与控制台开不开无关
   */
  private ensureInspector(session: Session): SessionInspector {
    if (session.inspector === undefined) {
      const sessionId = session.summary.id
      session.inspector = new SessionInspector(
        (entry) => this.notify('inspect.event', { sessionId, entry }),
        this.inspectStore.load(sessionId),
        (record) => this.inspectStore.append(sessionId, record)
      )
    }
    return session.inspector
  }

  /**
   * 会话的工作区根列表：自有 cwd + 归属项目的全部 cwds（主根在前）。
   * 多根化（2026-11-09）：跨仓库项目 = 一个项目多目录，模型要在声明里看见全部。
   * 顺序去重（同目录只声明一次）。
   */
  private workspaceRoots(session: Session): string[] {
    const roots: string[] = []
    if (session.summary.cwd !== undefined) roots.push(session.summary.cwd)
    if (session.summary.projectId !== undefined) {
      for (const cwd of this.projects.get(session.summary.projectId)?.cwds ?? []) {
        if (!roots.includes(cwd)) roots.push(cwd)
      }
    }
    return roots
  }

  /** 自定义 provider / 内置 baseUrl 覆盖的全量同步（providers.custom.sync 委托） */
  syncCustomProviders(defs: CustomProviderDef[], overrides: ProviderOverrideDef[]): number {
    return this.customProviders.sync(defs, overrides)
  }

  // ———— 会话 CRUD ————

  create(params: { title?: string; cwd?: string; projectId?: string } = {}): SessionSummary {
    const now = Date.now()
    // UUID 而非自增序号：自增在持久化后重启必然撞号（旧盘 s-1 vs 新会话 s-1）
    const summary: SessionSummary = {
      id: crypto.randomUUID(),
      title: params.title?.trim() || '新会话',
      createdAt: now,
      updatedAt: now,
      ...(params.cwd !== undefined && { cwd: params.cwd }),
      ...(params.projectId !== undefined && { projectId: params.projectId })
    }
    this.sessions.set(summary.id, { summary, transcript: [] })
    this.persist(summary.id)
    return summary
  }

  /**
   * 会话列表（session.list 响应）。默认滤掉已归档（archivedAt 有值）—— 归档是
   * 回收站语义，主列表 = 活跃会话；归档视图走 listArchived（设置页）。
   */
  list(): SessionSummary[] {
    return Array.from(this.sessions.values(), (s) => s.summary).filter((s) => s.archivedAt === undefined)
  }

  /** 已归档会话（设置页「已归档的聊天」数据源），按归档时间倒序（新归档在上） */
  listArchived(): SessionSummary[] {
    return Array.from(this.sessions.values(), (s) => s.summary)
      .filter((s) => s.archivedAt !== undefined)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  }

  setPinned(sessionId: string, pinned: boolean): SessionSummary {
    const session = this.requireSession(sessionId)
    // 存时间不存布尔：置顶分区按 pinnedAt 倒序，新置顶在上；取消 = 字段移除
    if (pinned) session.summary.pinnedAt = Date.now()
    else delete session.summary.pinnedAt
    this.persist(sessionId)
    return { ...session.summary }
  }

  /** 归档/恢复（回收站语义：archived=false = 恢复回活跃列表）。归档不中止进行中
      回复 —— 转录由事件流照常落盘，只是会话从主列表消失（agent_end 不受影响） */
  archive(sessionId: string, archived: boolean): SessionSummary {
    const session = this.requireSession(sessionId)
    if (archived) session.summary.archivedAt = Date.now()
    else delete session.summary.archivedAt
    this.persist(sessionId)
    return { ...session.summary }
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.agent?.abort()
    this.sessions.delete(sessionId)
    this.streaming.delete(sessionId)
    this.storage.delete(SESSION_COLLECTION, sessionId)
    // 观测记录随会话清理（聊天转录同生共死，不留孤儿文件）
    this.inspectStore.delete(sessionId)
    return true
  }

  /** 会话消息转录（session.messages 响应）：pi Message[] → ChatMessage[] */
  messages(sessionId: string): ChatMessage[] {
    const session = this.requireSession(sessionId)
    return this.toChatMessages(this.ensureAgent(session).state.messages)
  }

  // ———— 运行时控制台（inspect 域后端）————

  /** 观测条目摘要全量（inspect.entries 响应；时间线数据源） */
  inspectEntries(sessionId: string): InspectEntrySummary[] {
    const session = this.requireSession(sessionId)
    return this.ensureInspector(session).entries()
  }

  /** 单条观测详情（inspect.entry 响应）；不存在/被环形丢弃 = 客户端参数错 */
  inspectDetail(sessionId: string, seq: number): InspectEntryDetail {
    const session = this.requireSession(sessionId)
    const detail = this.ensureInspector(session).detail(seq)
    if (detail === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `观测记录不存在或已被滚动丢弃: seq ${seq}`)
    }
    return detail
  }

  // ———— 模型目录 ————

  /** pi catalog → 协议模型摘要（UI 下拉数据源；key 配置状态在 credentials.list 单独查） */
  listModels(): ModelSummary[] {
    return this.models.getModels().map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: m.reasoning,
      // pi 按端点标定的 thinkingLevelMap 判定真实可用档（含 'off'）——
      // UI 滑杆据此渲染/置灰，切模型据此 clamp，杜绝静默降级
      thinkingLevels: getSupportedThinkingLevels(m),
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      // 目录原生 vs 用户添加（默认模型 UI 锁 id 的判定源，见 isUserDefined 注释）
      userDefined: this.customProviders.isUserDefined(m.provider, m.id)
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
  submit(sessionId: string, text: string, model?: string, thinkingLevel?: string, provider?: string): void {
    const session = this.requireSession(sessionId)
    // 工作区复查（多根）：任一根目录被删/移动 → 显式报错（外部世界会变，
    // 静默继续 = 模型对不存在的目录输出幻觉操作）。同步 throw → dispatch 错误帧
    for (const root of this.workspaceRoots(session)) {
      if (!existsSync(root)) {
        throw new ProtocolError(RpcErrorCode.InvalidRequest, `工作区目录不存在或已被移动: ${root}`)
      }
    }
    const agent = this.ensureAgent(session)
    // pi 约定同一 Agent 同时只跑一个 prompt（agent.js prompt 入口对 activeRun 抛错）。
    // 在受理入口显式拒绝成协议错误，而不是放它落进异步段崩进程
    if (agent.state.isStreaming) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, `会话正在回复中，请先停止或等待完成: ${sessionId}`)
    }
    if (model) {
      // provider 双键限定优先：同名模型会被多家目录收录（azure 目录也有
      // deepseek-v4-pro），id 单键全局查找按注册序撞 azure 那份 → "Provider
      // is not configured: azure"。UI 选择时的 provider 原样下发即可消歧；
      // 未带 provider 的老宿主保持旧解析序（默认 provider 优先 → 全局 id）
      const target = provider !== undefined
        ? this.models.getModel(provider, model)
        : this.models.getModel(DEFAULT_PROVIDER, model) ?? this.models.getModels().find((m) => m.id === model)
      if (!target) throw new Error(`未知模型: ${model}`)
      agent.state.model = target
    }
    if (thinkingLevel) {
      agent.state.thinkingLevel = thinkingLevel as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    }

    // 首条消息命名会话（恢复的旧会话标题已命名，不会覆盖）
    if (session.summary.title === '新会话') {
      session.summary.title = text.trim().slice(0, TITLE_MAX_CHARS) || session.summary.title
    }
    session.summary.updatedAt = Date.now()
    this.persist(sessionId)

    this.notify('run.started', { sessionId })
    this.ensureInspector(session).runStarted(text, agent.state.systemPrompt, agent.state.thinkingLevel)
    this.streaming.set(sessionId, { messageId: `m-${crypto.randomUUID()}`, text: '', thinking: '' })
    // prompt() 的运行期失败（流错误/中止）由 pi 事件流转译为 run.failed
    // （handleRunFailure → agent_end，见 pi-agent-integration.md §2.3），不会走到这层；
    // catch 只兜"受理检查通过后、pi 尚未发出任何事件前"的启动窗口拒绝 ——
    // 外部世界失败是常态（约定.md 1.1），必须转成 run.failed 给 UI 一个终态
    void agent.prompt(text).catch((error: unknown) => {
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
    this.ensureAgent(session).abort()
    return true
  }

  /** 进程退出前统一收尾（引擎随宿主关闭，无需异步等待） */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.agent?.abort()
    this.sessions.clear()
    this.streaming.clear()
  }

  // ———— 内部 ————

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new ProtocolError(RpcErrorCode.InternalError, `会话不存在: ${sessionId}`)
    return session
  }

  /**
   * 惰性重建 pi Agent：首次使用（submit/messages/abort）才实例化并灌持久转录。
   * 恢复的会话若启动即全量实例化，会话多了启动就慢、且不使用的会话白占内存。
   * initialState.messages 带完整历史 → 下一轮请求模型可见全部上下文（保真恢复）。
   */
  private ensureAgent(session: Session): Agent {
    if (session.agent) return session.agent
    // 记录器经 thunk 惰性解析：messages() 也会建 Agent（仅为读转录），此时不该
    // 顺带载入观测文件；hooks 只在 prompt() 期间触发，那时 submit 已建好记录器
    const agent = this.createAgent(session.transcript, this.workspaceRoots(session), () =>
      this.ensureInspector(session)
    )
    session.agent = agent
    return agent
  }

  private createAgent(history: AgentMessage[], roots: string[], getInspector: () => SessionInspector): Agent {
    const model = this.models.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL)
    if (!model) throw new Error(`默认模型不可用: ${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`)

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(roots),
        model,
        thinkingLevel: 'off',
        messages: history
      },
      // streamFn 走 Models 集合：auth 解析、provider 分发、重试都由 pi-ai 承担
      streamFn: this.models.streamSimple.bind(this.models),
      // 每轮请求前从内存表解析 key（agent-loop.js:275；支持运行中换 key）
      getApiKey: (provider: string) => this.credentials.get(provider),
      // 运行时控制台的接口层观测（pi 原生 hooks，零魔改）：
      // - onPayload：发送前一刻的厂商原生请求体（onPayload 契约 = 返回 undefined
      //   表示保留原载荷，这里纯观测故恒返回 undefined）；
      // - onResponse：响应头到达（体消费前）；
      // - onProviderStreamEvent：归一化前的原生 SSE 分片（高频，inspector 只攒引用）。
      // 记录器自身尽力而为（inspector.ts 头注释），不干扰请求主路径
      onPayload: (payload, model) => {
        getInspector().apiRequest(payload, model)
        return undefined
      },
      onResponse: (response) => getInspector().apiResponse(response),
      onProviderStreamEvent: (data) => getInspector().apiStreamChunk(data)
    })

    agent.subscribe((event) => this.translateEvent(agent, event))
    return agent
  }

  /**
   * 回合边界落盘（create/delete/agent_end 调用）：summary + 完整转录整文档覆盖写。
   * 尽力语义：失败只记诊断不抛 —— 调用点多在事件转译/回合收尾路径上，
   * 抛出去等于让存储故障炸掉一次成功回合；转录仍在内存，下次回合边界重写补上。
   */
  private persist(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const doc: StoredSession = {
      version: SESSION_FILE_VERSION,
      summary: session.summary,
      transcript: session.transcript
    }
    try {
      this.storage.put(SESSION_COLLECTION, sessionId, doc as unknown as Record<string, unknown>)
    } catch (error) {
      process.stderr.write(`[agent-service] 会话落盘失败（${sessionId}，下回合重试）: ${(error as Error).message}\n`)
    }
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
      case 'turn_start': {
        this.sessions.get(sessionId)?.inspector?.turnStarted()
        return
      }
      case 'turn_end': {
        // 记录停止原因与用量：length = 输出被 token 上限截断（agent_end 事件本身
        // 不带这些信息）；usage/durationMs/model 同样只在 turn_end 的 message 上
        // 到达 —— agent_end 只剩聚合态转录，此处不摘即永久丢失（协议事件不回头）
        if (event.message.role === 'assistant') {
          const streaming = this.streaming.get(sessionId)
          if (streaming) {
            streaming.stopReason = event.message.stopReason
            streaming.usage = accumulateUsage(streaming.usage, projectUsage(event.message.usage))
            streaming.durationMs = sumOptional(streaming.durationMs, event.message.durationMs)
            streaming.model = event.message.model
          }
          // 观测快照取 turn_end 终态消息（usage/stopReason/diagnostics 齐全）
          this.sessions.get(sessionId)?.inspector?.turnCompleted(event.message)
        }
        return
      }
      case 'tool_execution_start': {
        this.sessions.get(sessionId)?.inspector?.toolStarted(event.toolName, event.args)
        return
      }
      case 'tool_execution_end': {
        this.sessions.get(sessionId)?.inspector?.toolCompleted(
          event.toolName,
          event.result,
          event.isError,
          event.durationMs
        )
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
          session.inspector?.runFailed(agent.state.errorMessage)
          this.notify('run.failed', { sessionId, message: agent.state.errorMessage })
          return
        }

        // 回合成功的最终 assistant 消息进持久转录（pi 消息带真实 timestamp，
        // 投影/恢复共用此值）；失败/中止回合 pi 已把半截文本留进转录，
        // 这里同步一次保证盘上盘内一致（pi 语义：半截回复留存、后续请求可见）
        session.transcript = [...agent.state.messages]
        this.persist(sessionId)

        if (streaming) session.inspector?.runCompleted(streaming)
        this.notify('run.completed', {
          sessionId,
          // 思考/正文任一非空都落消息（只有思考没有正文的极端截断也可见）；
          // usage 三件套来自 turn_end 的逐轮累积（见 translateEvent turn_end 分支）
          message: streaming && (streaming.text || streaming.thinking)
            ? {
                id: streaming.messageId,
                role: 'assistant',
                content: streaming.text,
                thinking: streaming.thinking || undefined,
                usage: streaming.usage,
                durationMs: streaming.durationMs,
                model: streaming.model,
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

  /** pi Message[] → ChatMessage[]：取 user/assistant 的纯文本内容 + assistant 用量三件套投影 */
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
          // 用量三件套同投影：盘上 transcript 存 pi 完整消息（usage 是必有字段），
          // 历史会话与流式结束态同一套数据源，老会话 UI 上也可见统计
          usage: projectUsage(message.usage),
          durationMs: message.durationMs,
          model: message.model,
          // 真实请求时间戳（pi AssistantMessage.timestamp = 请求开始时刻）；
          // 此前取 Date.now() 在恢复历史时会漂移成回查时刻
          timestamp: message.timestamp
        })
      }
    }
    return result
  }
}
