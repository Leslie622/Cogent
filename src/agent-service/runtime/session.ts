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
import type { AgentEvent, AgentMessage, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { MutableModels, Usage } from '@earendil-works/pi-ai'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProtocolError, RpcErrorCode } from '../../protocol'
import type {
  ChatMessage,
  CustomProviderDef,
  InspectEntryDetail,
  InspectEntrySummary,
  MessageUsage,
  ModelSummary,
  PermissionMode,
  ProviderOverrideDef,
  ProtocolEvents,
  SessionSummary,
  ToolCallRecord
} from '../../protocol'
import type { CredentialRegistry } from './credentials'
import { CustomProviderRegistry } from './custom-providers'
import { SessionInspector } from './inspector'
import type { ProjectRegistry } from './project'
import type { InspectStore, StorageDriver } from '../storage'
import { buildTools, toolMeta } from '../tools'

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
 * 系统提示词装配（工作区上下文注入 + 多根化 2026-11-09；工具段 2026-11-10，
 * D2 修订后恒有工具）：基础人设 + 工作区声明（多目录，首个为主根；无绑定时无
 * 此段）+ 环境块（每根一行含 git 分支）+ 各根 AGENTS.md + 工具使用段。
 * 这是"工作区对模型生效"的第①通道（文字声明）—— 模型没有 cwd 概念，相对路径
 * 指哪全靠这里讲清（四通道模型见计划 §0）。
 */
function buildSystemPrompt(boundRoots: string[], toolRoots: string[]): string {
  let prompt = 'You are Cogent, a helpful desktop agent.'

  if (boundRoots.length > 0) {
    const declared =
      boundRoots.length === 1
        ? boundRoots[0]
        : `${boundRoots.map((r, i) => `${i + 1}. ${r}`).join('\n')}（首个为主根）`
    prompt += `\n\n# 工作区\n你在用户的本地工作区中工作：${declared}` +
      '\n用户消息里的相对路径（文件/目录）都相对这些根目录解析；未指明时优先主根。'

    // 环境块（Claude Code 手法）：平台 + 每根目录与 git 分支（直读 .git/HEAD，
    // 不 spawn 子进程 —— Windows 上免 git 依赖；非仓库/解析失败省略分支尾）
    prompt += `\n\n# 环境\n- 平台: ${process.platform}`
    for (const root of boundRoots) {
      const branch = readGitBranch(root)
      prompt += `\n- 工作区: ${root}${branch !== null ? `（Git 分支: ${branch}）` : ''}`
    }

    // 各根 AGENTS.md（项目给模型的指令，只读消费；存在才拼、每根限长）
    for (const root of boundRoots) {
      const agentsFile = join(root, 'AGENTS.md')
      if (!existsSync(agentsFile)) continue
      try {
        const content = readFileSync(agentsFile, 'utf-8')
        const trimmed = content.length > AGENTS_MD_MAX_CHARS
          ? `${content.slice(0, AGENTS_MD_MAX_CHARS)}\n\n[AGENTS.md 已截断]`
          : content
        const label =
          boundRoots.length > 1 ? `工作区指令（${root} 的 AGENTS.md）` : '工作区指令（AGENTS.md）'
        prompt += `\n\n# ${label}\n${trimmed}`
      } catch (error) {
        // 读失败不挡会话创建：指令文件是增益不是必需品（外部世界失败是常态）
        process.stderr.write(`[agent-service] AGENTS.md 读取失败（跳过 ${root}）: ${(error as Error).message}\n`)
      }
    }
  }

  // 工具段（D2 修订：任何会话都有只读工具，无绑定会话以主目录为基；write
  // 批次 2 加入）。讲清有什么、路径规则（读相对基根/绝对不限 —— 对齐 Claude
  // Code 只读默认全盘允许；写限工作区根内 + 先审批）。不解释参数（工具 schema
  // 自描述，模型读 description 比提示词转述更准）
  const bound = boundRoots.length > 0
  const base =
    bound
      ? '相对路径相对工作区主根解析'
      : `相对路径相对用户主目录（${toolRoots[0]}）解析`
  prompt +=
    '\n\n# 工具\n' +
    '你可以调用工具：read（读单个文件，带行号）、glob（按通配模式找文件）、' +
    'grep（按正则全文搜索）、write（整文件写入，须在可写根内，执行前可能需要用户批准）。' +
    '先用 glob/grep 定位、再用 read 读内容。\n' +
    `${base}；读取的绝对路径不限位置，写入只能在${bound ? '工作区根目录内' : '用户主目录内'}。`
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

/**
 * 会话内 run 的流式累积状态（工具循环段化，计划 D6）。
 * 一个 run 在 pi 里是多轮循环：assistant(text/toolCall) → toolResult →
 * assistant(text)…。段化模型：**轮内缓冲**（delta 累积 + 本轮工具记录）在
 * turn_end 封存成一段 ChatMessage；`segments` 按发生序收集全部段 ——
 * run.completed 的 messages 即它（text 段与工具卡交错保真），message 是
 * 全段聚合（老宿主兼容）。
 */
interface StreamingState {
  messageId: string
  /** 已封存的段（turn_end 时 push） */
  segments: ChatMessage[]
  /** 当前轮正文缓冲（text_delta 累积；turn_end 清空） */
  text: string
  /** 当前轮思考缓冲（thinking_delta 累积；正文与思考是同一轮的两路） */
  thinking: string
  /** 当前轮的工具调用记录（tool_execution_start 建条，end 时补结果；turn_end 随段带走） */
  tools: ToolCallRecord[]
  /** pi 停止原因（turn_end 时记录；length = 输出被 token 上限截断） */
  stopReason?: string
  /** token 用量（turn_end 各轮累加；见 accumulateUsage 的口径注释） */
  usage?: MessageUsage
  /** 模型耗时毫秒（各轮 durationMs 之和；pi 未计时的轮次按缺省跳过，不含工具执行时间） */
  durationMs?: number
  /** 模型 id（末轮记录） */
  model?: string
}

/**
 * 工具结果 → 一行摘要（tool.completed 事件与 ToolCallRecord.resultSummary 共用）。
 * 取 result.content 的文本块拼接（模型 facing 的结果即用户可读的结果），截 200
 * 字符 —— 摘要服务"一眼看懂发生了什么"，全文模型已在循环里消费过。
 */
function summarizeToolResult(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  const text = content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
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
  /**
   * Agent → sessionId 反查表：pi 事件回调只带 agent 引用，逐事件线性扫 sessions
   * 是流式热路径（每个 delta 一次 O(N)）——建 Agent 时登记、删除时撤销，O(1) 直取
   */
  private agentIndex = new Map<Agent, string>()
  private streaming = new Map<string, StreamingState>()
  /**
   * 挂起中的审批（D4/D5）：approval.request 发出 → beforeToolCall 的 Promise 悬着
   * 等 approval.respond。value 存 sessionId（会话删除/退出时按会话批量收尾 ——
   * 不 resolve 则 pi 的 await 永悬、该 run 永不结束）。
   */
  private pendingApprovals = new Map<
    string,
    { sessionId: string; resolve: (result: BeforeToolCallResult) => void }
  >()
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
    // 损坏（截断/手改/旧版本形状）逐文件隔离：报错 + 改名 .corrupt 旁置 + 继续
    // 恢复其余会话 —— 单文件损坏若任其炸构造器，引擎进程拒启 = 全部会话陪葬，
    // 这超出了约定.md §1.1「报错而非静默重建」的立法本意（可见性保留：stderr
    // 诊断 + 旁置文件可查，且该会话确实不加载 = 不静默重建）
    for (const id of this.storage.ids(SESSION_COLLECTION)) {
      try {
        const doc = asStoredSession(this.storage.get(SESSION_COLLECTION, id), id)
        this.sessions.set(doc.summary.id, { summary: doc.summary, transcript: doc.transcript })
      } catch (error) {
        this.storage.quarantine(SESSION_COLLECTION, id)
        process.stderr.write(
          `[agent-service] 会话文档损坏已隔离（sessions/${id}.json → .corrupt）: ${(error as Error).message}\n`
        )
      }
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

  /**
   * 工具的基根（D2 修订）：绑定根，无绑定时兜底用户主目录 —— 桌面应用语境下
   * "launch cwd" 的等价物。保证**任何会话都有只读工具**（主流共识：读几乎
   * 不设限，Claude Code 的 Read/Glob/Grep 默认全盘允许；无绑定会话零工具
   * 比所有主流产品都严，2026-11-10 用户驳回）。写类工具的**限界根**沿用
   * 同一列表（批次 2 消费：无根写主目录也要过审批）。
   */
  private toolRoots(session: Session): string[] {
    const roots = this.workspaceRoots(session)
    return roots.length > 0 ? roots : [homedir()]
  }

  /** 自定义 provider / 内置 baseUrl 覆盖的全量同步（providers.custom.sync 委托） */
  syncCustomProviders(defs: CustomProviderDef[], overrides: ProviderOverrideDef[]): number {
    return this.customProviders.sync(defs, overrides)
  }

  // ———— 会话 CRUD ————

  create(
    params: { title?: string; cwd?: string; projectId?: string; permissionMode?: PermissionMode } = {}
  ): SessionSummary {
    const now = Date.now()
    // UUID 而非自增序号：自增在持久化后重启必然撞号（旧盘 s-1 vs 新会话 s-1）
    const summary: SessionSummary = {
      id: crypto.randomUUID(),
      title: params.title?.trim() || '新会话',
      createdAt: now,
      updatedAt: now,
      ...(params.cwd !== undefined && { cwd: params.cwd }),
      ...(params.projectId !== undefined && { projectId: params.projectId }),
      // 「完全访问」的物化通道（第 5 步）：新聊天页 toggle 的选择随会话落定；
      // 缺省不带 = ask（协议缺省语义，旧宿主不破）
      ...(params.permissionMode !== undefined && { permissionMode: params.permissionMode })
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
    // 挂起审批先收尾再拆会话：resolve block 让 pi 的 await 落地、run 正常走完
    // 收尾路径（agent.abort 后的事件流转译要能找到会话，先 settle 后删）
    this.settleApprovals(sessionId, '会话已删除')
    if (session.agent) this.agentIndex.delete(session.agent)
    this.sessions.delete(sessionId)
    this.streaming.delete(sessionId)
    this.storage.delete(SESSION_COLLECTION, sessionId)
    // 观测记录随会话清理（聊天转录同生共死，不留孤儿文件）
    this.inspectStore.delete(sessionId)
    return true
  }

  /**
   * 会话消息转录（session.messages 响应）：pi Message[] → ChatMessage[]。
   * 只读路径不实例化 Agent：Agent 存在时取它的实时 state.messages（运行中含
   * 进行时消息），否则直接投影持久转录（transcript 是回合边界同步过的真源）——
   * 为读消息建一个带 hooks/订阅的完整 Agent 是纯浪费
   */
  messages(sessionId: string): ChatMessage[] {
    const session = this.requireSession(sessionId)
    return this.toChatMessages(session.agent ? session.agent.state.messages : session.transcript)
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
  listModels(): { models: ModelSummary[]; defaultModel: { provider: string; id: string } } {
    return {
      defaultModel: { provider: DEFAULT_PROVIDER, id: DEFAULT_MODEL },
      models: this.models.getModels().map((m) => ({
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
    this.streaming.set(sessionId, {
      messageId: `m-${crypto.randomUUID()}`,
      segments: [],
      text: '',
      thinking: '',
      tools: []
    })
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
    for (const sessionId of this.sessions.keys()) this.settleApprovals(sessionId, '引擎退出')
    this.sessions.clear()
    this.agentIndex.clear()
    this.streaming.clear()
  }

  // ———— 审批（计划-工具系统与审批.md 第 4 步，D4/D5）————

  /**
   * 宿主裁决回流：resolve 挂起中的 beforeToolCall Promise。
   * 唔配对 requestId（已裁决过 / abort 已收尾 / 不存在）→ InvalidParams ——
   * 双击允许钮、裁决与中止竞态都属于此类，显式报错而非静默成功。
   */
  respondApproval(requestId: string, approved: boolean): { ok: true } {
    const pending = this.pendingApprovals.get(requestId)
    if (pending === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `审批请求不存在或已被裁决: ${requestId}`)
    }
    this.pendingApprovals.delete(requestId)
    pending.resolve(approved ? { block: false } : { block: true, reason: '用户拒绝了本次操作' })
    return { ok: true }
  }

  /** 会话级权限切换（「完全访问」按钮）：beforeToolCall 每次触发时读活值，运行中切换即生效 */
  setPermission(sessionId: string, mode: PermissionMode): SessionSummary {
    const session = this.requireSession(sessionId)
    session.summary.permissionMode = mode
    this.persist(sessionId)
    return { ...session.summary }
  }

  /** 某会话的全部挂起审批以 block 收尾（删除/退出兜底；abort 走 signal listener，D5） */
  private settleApprovals(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.sessionId !== sessionId) continue
      this.pendingApprovals.delete(requestId)
      pending.resolve({ block: true, reason })
    }
  }

  // ———— 内部 ————

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new ProtocolError(RpcErrorCode.InternalError, `会话不存在: ${sessionId}`)
    return session
  }

  /**
   * 惰性重建 pi Agent：首次使用（submit/abort）才实例化并灌持久转录。
   * 恢复的会话若启动即全量实例化，会话多了启动就慢、且不使用的会话白占内存。
   * initialState.messages 带完整历史 → 下一轮请求模型可见全部上下文（保真恢复）。
   * （messages() 不走这里：只读路径直接投影 transcript，不建 Agent —— 见其注释。）
   * 工具集与 Agent 同批构建（roots 相同；kind/摘要等元数据走 tools/ 的静态表，
   * 与实例解耦 —— 历史回查投影不依赖活实例）。
   */
  private ensureAgent(session: Session): Agent {
    if (session.agent) return session.agent
    // 记录器经 thunk 惰性解析：hooks 只在 prompt() 期间触发，那时 submit 已建好
    // 记录器，载入观测文件的时机正确
    const agent = this.createAgent(session, () => this.ensureInspector(session))
    session.agent = agent
    this.agentIndex.set(agent, session.summary.id)
    return agent
  }

  private createAgent(session: Session, getInspector: () => SessionInspector): Agent {
    const boundRoots = this.workspaceRoots(session)
    const toolRoots = this.toolRoots(session)
    const model = this.models.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL)
    if (!model) throw new Error(`默认模型不可用: ${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`)
    const tools = buildTools(toolRoots)

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(boundRoots, toolRoots),
        model,
        thinkingLevel: 'off',
        messages: session.transcript,
        tools: tools.map((t) => t.tool)
      },
      // 审批拦截（D4 判定矩阵：ToolKind × permissionMode）。pi 时序：
      // tool_execution_start 事件先于此钩子发出（宿主的 running 工具卡先行），
      // 钩子挂起 = 卡停在执行前；block 后 pi 补发 tool_execution_end(isError)
      // —— 卡自然翻成 error 态，流式段化与历史回查两条投影路径无需特判。
      // mode 读 session.summary 的活引用（运行中切「完全访问」即生效）
      beforeToolCall: async (context, signal) => {
        const meta = toolMeta(context.toolCall.name)
        // 未知名字兜底 read：与事件转译同口径（pi 只执行注册过的工具，未知 =
        // 注册表 bug，stderr 已在转译层留诊断，这里按无害的只读放行）
        const kind = meta?.kind ?? 'read'
        if (kind === 'read') return undefined
        const mode = session.summary.permissionMode ?? 'ask'
        if (mode === 'auto') return undefined
        if (mode === 'plan') {
          return { block: true, reason: 'plan（只读）模式下写类工具被禁止' }
        }
        // ask：发审批请求并挂起（D5：无超时 —— 用户不点就一直等，宿主输入框
        // 变停止钮可 abort；signal abort 兜底 resolve，否则中止后 Promise 永悬）
        const requestId = `appr-${crypto.randomUUID()}`
        const sessionId = session.summary.id
        return new Promise<BeforeToolCallResult>((resolve) => {
          // 先登记再发事件：respondApproval 走这张表找 resolver，时序上不存在
          // 「事件未到、respond 先行」的窗口（宿主是收到事件才可能裁决）
          this.pendingApprovals.set(requestId, { sessionId, resolve })
          this.notify('approval.request', {
            sessionId,
            requestId,
            toolName: context.toolCall.name,
            kind,
            summary: meta !== undefined ? meta.summarize(context.args) : `${context.toolCall.name}(?)`
          })
          signal?.addEventListener('abort', () => {
            // 已被 respondApproval 消费则不动（用户裁决与中止竞态，先到先得）
            if (this.pendingApprovals.delete(requestId)) {
              resolve({ block: true, reason: '已中止' })
            }
          })
        })
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
          // 覆写轮结束时刻：pi 的 assistant timestamp = 流打开那一刻（pi-ai
          // 各方言在 stream open 构造 partial 时打的 Date.now()），而 UI 的
          // 「已工作」墙钟口径是轮结束 —— 不覆写则漏掉整个末轮流式输出段
          // （实测 live 计时 2.7s、终态只报 1.4s 的分歧根源）。连消息体一起
          // 改：event.message 即转录真源里的对象，不改历史回查退回轮开始口径；
          // 轮已收尾 pi 不再读该字段（prompt 序列化不携带）
          event.message.timestamp = Date.now()
          const streaming = this.streaming.get(sessionId)
          if (streaming) {
            streaming.stopReason = event.message.stopReason
            streaming.usage = accumulateUsage(streaming.usage, projectUsage(event.message.usage))
            streaming.durationMs = sumOptional(streaming.durationMs, event.message.durationMs)
            streaming.model = event.message.model
            // 段封存（计划 D6）：本轮 text/thinking + 本轮工具调用 → 一段
            // ChatMessage（段内 usage 是本轮自己的，非全 run 累计 —— 分段后
            // 每段的统计行各自成立）。三缓冲全空的轮不落段（pi 每轮至少有
            // text 或 toolCall 之一，此分支实际只挡极端 provider 怪癖）
            if (streaming.text !== '' || streaming.thinking !== '' || streaming.tools.length > 0) {
              streaming.segments.push({
                // id 带 run 级前缀：段序号只在 run 内唯一，同会话多 run 会撞
                // （宿主把段直接铺进消息列表作 React key）
                id: `${streaming.messageId}-${streaming.segments.length}`,
                role: 'assistant',
                content: streaming.text,
                thinking: streaming.thinking || undefined,
                toolCalls: streaming.tools.length > 0 ? streaming.tools.map((t) => ({ ...t })) : undefined,
                usage: projectUsage(event.message.usage),
                durationMs: event.message.durationMs,
                model: event.message.model,
                timestamp: event.message.timestamp
              })
            }
            streaming.text = ''
            streaming.thinking = ''
            streaming.tools = []
          }
          // 观测快照取 turn_end 终态消息（usage/stopReason/diagnostics 齐全）
          this.sessions.get(sessionId)?.inspector?.turnCompleted(event.message)
        }
        return
      }
      case 'tool_execution_start': {
        this.sessions.get(sessionId)?.inspector?.toolStarted(event.toolName, event.args)
        const streaming = this.streaming.get(sessionId)
        if (!streaming) return
        // kind/摘要取静态元数据表（与 buildTools 同源；不依赖会话工具实例 ——
        // 事件路径上两者必然一致，表查询天然覆盖历史工具名）
        const meta = toolMeta(event.toolName)
        if (meta === undefined) {
          // pi 只执行注册过的工具，未知名字 = 引擎注册表与循环不一致的 bug：
          // 事件流不炸、stderr 留诊断、呈现按只读兜底（fail-visible，不静默）
          process.stderr.write(`[agent-service] 未注册的工具名出现在执行事件: ${event.toolName}\n`)
        }
        const record: ToolCallRecord = {
          callId: event.toolCallId,
          name: event.toolName,
          kind: meta?.kind ?? 'read',
          summary: meta !== undefined ? meta.summarize(event.args) : `${event.toolName}(?)`,
          status: 'ok',
          // 工具时长区间起点（UI 聚合「模型 Xs · 工具 Ys」分解用）
          startedAt: Date.now()
        }
        streaming.tools.push(record)
        this.notify('tool.started', {
          sessionId,
          callId: event.toolCallId,
          name: event.toolName,
          kind: record.kind,
          summary: record.summary
        })
        return
      }
      case 'tool_execution_end': {
        this.sessions.get(sessionId)?.inspector?.toolCompleted(
          event.toolName,
          event.result,
          event.isError,
          event.durationMs
        )
        const streaming = this.streaming.get(sessionId)
        if (!streaming) return
        const summary = summarizeToolResult(event.result)
        const record = streaming.tools.find((t) => t.callId === event.toolCallId)
        if (record !== undefined) {
          record.status = event.isError ? 'error' : 'ok'
          record.resultSummary = summary
          // 区间终点（与 startedAt 同为引擎打点；历史回查路径另从 toolResult
          // 消息重建，两条来源同一形状）
          record.endedAt = Date.now()
        }
        this.notify('tool.completed', {
          sessionId,
          callId: event.toolCallId,
          isError: event.isError,
          summary
        })
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

        // 观测快照吃结构类型（顶层 text/thinking）—— 段化后顶层缓冲已清空，
        // 传各段聚合值（口径 = 拼接后总字符，与旧实现一致）
        if (streaming) {
          session.inspector?.runCompleted({
            text: streaming.segments.map((s) => s.content).join(''),
            thinking: streaming.segments.map((s) => s.thinking ?? '').join(''),
            usage: streaming.usage,
            durationMs: streaming.durationMs,
            model: streaming.model,
            stopReason: streaming.stopReason
          })
        }
        this.notify('run.completed', {
          sessionId,
          // 分段终态（优先消费）：text 段与工具段按发生序 —— 交错保真的代价是
          // 一 run 多条消息，宿主用它整体替换流式占位（含流式期插入的工具卡）
          messages: streaming && streaming.segments.length > 0 ? streaming.segments : undefined,
          // 聚合兼容形态（老宿主只读 message）：全段拼接。思考/正文任一非空
          // 都落消息（只有思考没有正文的极端截断也可见）；usage 三件套是
          // turn_end 的逐轮累计（计费口径，见 accumulateUsage）
          message:
            streaming && streaming.segments.some((s) => s.content || s.thinking)
              ? {
                  id: streaming.messageId,
                  role: 'assistant',
                  content: streaming.segments.map((s) => s.content).filter((c) => c !== '').join('\n\n'),
                  thinking:
                    streaming.segments.some((s) => s.thinking)
                      ? streaming.segments.map((s) => s.thinking ?? '').join('\n\n')
                      : undefined,
                  toolCalls: streaming.segments.some((s) => (s.toolCalls ?? []).length > 0)
                    ? streaming.segments.flatMap((s) => s.toolCalls ?? [])
                    : undefined,
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

  /** Agent 实例反查会话 id（事件回调只带 agent 引用；O(1) 查反查表，见 agentIndex） */
  private findSessionId(agent: Agent): string | undefined {
    return this.agentIndex.get(agent)
  }

  /**
   * pi Message[] → ChatMessage[]：取 user/assistant 的纯文本内容 + assistant
   * 用量三件套 + 工具调用投影。system 消息（prompt 载体）与 toolResult 消息
   * （配对进 toolCalls）不单独产出 —— 工具结果对 UI 是工具卡的尾部信息，
   * 不是独立消息（对模型才回灌成消息）。
   */
  private toChatMessages(messages: AgentMessage[]): ChatMessage[] {
    // toolCallId → 执行结果（状态 + 摘要 + 起止）：转录里 toolResult 消息跟在
    // 发起它的 assistant 消息之后；先扫一遍建索引，投影时 O(1) 配对。
    // 起止重建自 pi 转录原生字段（timestamp = 结果创建时刻 ≈ 执行终点，
    // durationMs 反推起点）—— 历史回查与流式打点两条来源同一形状，重启不漂移
    const results = new Map<
      string,
      { isError: boolean; text: string; startedAt?: number; endedAt?: number }
    >()
    for (const message of messages) {
      if (message.role === 'toolResult') {
        results.set(message.toolCallId, {
          isError: message.isError,
          text: summarizeToolResult({ content: message.content }),
          endedAt: message.timestamp,
          startedAt: message.durationMs !== undefined ? message.timestamp - message.durationMs : undefined
        })
      }
    }

    const result: ChatMessage[] = []
    for (const message of messages) {
      // pi Message 联合类型按 role 收窄
      if (message.role === 'user') {
        result.push({
          // 位置式 id（同 assistant 的 a-N 手法）：timestamp 在同一毫秒内可撞
          // （React key 重复），投影位置在单写者下稳定且跨加载不变
          id: `u-${result.length}`,
          role: 'user',
          content: typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
          timestamp: message.timestamp
        })
      } else if (message.role === 'assistant') {
        // 思考块拼整段挂 thinking（历史回查与流式结束态共用此映射）；正文仍取 text 块
        const thinking = message.content
          .map((block) => (block.type === 'thinking' ? block.thinking : ''))
          .join('')
        // 工具调用块 → ToolCallRecord（kind/摘要取静态元数据表；状态/结果摘要
        // 由 toolResult 配对 —— 历史工具卡与流式期事件路径同一形状）
        const toolCalls: ToolCallRecord[] = []
        for (const block of message.content) {
          if (block.type !== 'toolCall') continue
          const meta = toolMeta(block.name)
          const paired = results.get(block.id)
          toolCalls.push({
            callId: block.id,
            name: block.name,
            kind: meta?.kind ?? 'read',
            summary: meta !== undefined ? meta.summarize(block.arguments) : `${block.name}(?)`,
            status: paired?.isError ? 'error' : 'ok',
            resultSummary: paired?.text,
            startedAt: paired?.startedAt,
            endedAt: paired?.endedAt
          })
        }
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
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          // 真实请求时间戳（pi AssistantMessage.timestamp = 请求开始时刻）；
          // 此前取 Date.now() 在恢复历史时会漂移成回查时刻
          timestamp: message.timestamp
        })
      }
    }
    return result
  }
}
