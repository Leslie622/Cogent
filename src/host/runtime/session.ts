import { shutdownPiSession } from '../kernel/pi-lifecycle'
import { BusinessConfig } from './business-config'
/**
 * 会话运行时 —— pi AgentSession 的托管层。
 *
 * 职责：
 * - 每会话一个 pi AgentSession（经 kernel/pi-session-factory 装配，南缝唯一
 *   实现）；转录真源 = pi JSONL（message_end 逐条追加落盘），本层只管会话域
 *   summary（置顶/归档/项目绑定是 Cogent 的私域）。准备期中止且输入尚未交付时，
 *   本层经公开appendMessage/refreshContext补存原始user，不启动模型；
 * - 用户文本（agent.submit）→ pi.prompt()，pi 事件流转译为协议事件（notify
 *   回调注入，本文件不直接碰 stdout）；
 * - pi AgentSession 全托管运行期恢复：provider 自动重试、溢出压缩重试、阈值
 *   压缩都发生在 prompt() Promise 生命周期内；Cogent 侧的运行期逻辑只剩
 *   AUTO_CONTINUE 续写（贴线 maxTokens 截断时注入显式 user 续写指令，上限
 *   3 次）与审批挂起（链式 beforeToolCall，见 factory）。
 *
 * 终态纪律：进入pi生命周期后的 run.completed/run.failed 发射点在 **agent_settled**（pi
 * 在 _startRun 的 finally 里每轮 prompt 恰发一次）—— 它晚于全部内聚恢复/
 * 重试，天然的单一权威终态（单一发射点消解溢出/续写窗口的终态竞态）。
 * run 级中止读取该事件的 aborted；末条 assistant 已成功也不代表整个 run 正常结束。
 * 未启动pi、handled与准备拒绝由Host收口，只有拥有本次账本的链能发终态。
 *
 * 惰性纪律：恢复的会话启动只读 summary（v2 盘上文档），pi 内核与观测记录器
 * 都在首次使用（submit/compact/inspect 读取）时才建。
 *
 * 边界纪律：
 * - 本类实现 kernel/contract.ts 的 CogentKernel（南缝合同，决定 24），
 *   经 kernel/pi-session-factory 装配 pi AgentSession；
 * - 只依赖 pi-* 与 protocol 与 ../storage，零 Electron import（目录即边界）；
 * - handler 内信任协议类型，不做二次防御（约定.md §1.3，边界校验在 dispatch 入口）。
 */
import { SessionSearchService } from './search/service'
import type { SearchQuery, SearchPage } from '../../shared/session-search'
import { findPiTranscriptFile } from '../kernel/transcript'
import { toChatMessages, summarizeToolResult, tailToolResult, extractResultDiff, projectUsage, sumOptional, accumulateUsage } from './message-projection'
export { toChatMessages } from './message-projection'

import type { Agent, AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Api, AssistantMessage, Model, MutableModels } from '@earendil-works/pi-ai'
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime
} from '@earendil-works/pi-coding-agent'
import { resizeImage, formatDimensionNote } from '@earendil-works/pi-coding-agent'
import { assertAttachmentRequest, assertNewImageMessage } from './attachment-request-limits'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
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
  SessionSummary,
  TodoItem,
  ToolCallRecord,
  ToolKind
} from '../../protocol'
import {
  createAskTool,
  createEnterPlanTool,
  createSubmitPlanTool,
  createTodoTool,
  planSectionText,
  todosSectionText,
  type AskAnswers,
  type AskQuestion,
  type PlanRecord
} from './interact-tools'
import type { CredentialRegistry } from './credentials'
import { CustomProviderRegistry } from './custom-providers'
import { testModelConnectivity } from './model-connectivity'
import { SessionInspector, type TitleTrace } from './inspector'
import { SessionTitleConfig } from './session-title-config'
import { generateSessionTitle } from '../kernel/session-title'
import { McpConfigStore } from './mcp-config'
import { formatSkillsSection } from './skill-prompt'
import { SkillStore } from './skill-store'
import type { ProjectRegistry } from './project'
import type { ApprovalRegistry } from './approvals'
import type { CogentKernel, KernelNotifier } from '../kernel/contract'
import {
  createPiSession,
  PI_AGENT_DIR_NAME,
  readPiTranscript
} from '../kernel/pi-session-factory'
import { migrateLegacyTranscript, transcriptAuthority } from '../kernel/transcript-authority'
import type { InspectStore, StorageDriver } from '../storage'
import { toolMeta } from './tool-meta'
import { matchingWriteRoots } from './write-boundary'
import { AttachmentService } from './attachments'
import type { AttachmentRef, DirectoryRef } from '../../shared/attachments'
import type { FileContext, FileReference } from '../../shared/files'
import { AttachmentConfig } from './attachment-config'
import { createReadAttachmentTool } from './read-attachment'
import { OutputsService } from './outputs/service'
import { createReportOutputsTool, outputReceipt } from './outputs/tool'
import type { OutputOutcome } from '../../shared/outputs'
import { WorkspaceChangesService } from './changes/service'
import { asStoredSession, SESSION_COLLECTION, SESSION_FILE_VERSION, type StoredSession } from './session-storage'
import { buildSystemPrompt, estimateContext } from './session-prompt'
import {
  AUTO_CONTINUE_MESSAGE,
  AUTO_CONTINUE_PREFIX,
  buildDynamicSections,
  formatAttachmentsBlock,
  formatDirectoryReferencesBlock,
  renderPromptWithSections
} from './prompts'
import { projectModelSummaries } from './session-models'

/** 引擎事件出口的类型别名：runtime 通过它上报事件，不关心传输层（形状住在南缝合同） */
export type Notify = KernelNotifier

/** 内存态会话：pi 内核惰性 —— 恢复的会话在首次 submit/compact 时才装配 */
interface WorkspaceSnapshot { cwd: string; roots: string[] }
interface Session {
  /** 装配/运行共享的根快照，只有空闲项目交接会使其失效。 */
  workspace?: WorkspaceSnapshot
  /** 缺省为历史会话，不补发；消费标记在辅助 API 前落盘，崩溃恢复也不重复计费。 */
  autoTitle?: 'ready' | 'attempted'
  /** pi 转录目录锚点独立于可变项目根；不把新项目配置当旧工具 cwd。 */
  piCwd?: string
  summary: SessionSummary
  /** 任务清单（交互座 4c）：todo_write 全量替换维护；随会话文档持久化（todo_write 落笔即 persist） */
  todos: TodoItem[]
  /** 已批准计划（交互座 4c-3）：plan.respond(approved) 落账，cogent_plan 段每回合注入 */
  plan?: PlanRecord
  /** v1 旧盘的转录（pi 内核装配时一次性导入 pi 树，随后清引用；v2 会话无此字段 */
  legacyTranscript?: AgentMessage[]
  /** pi AgentSession；undefined = 尚未建 —— 惰性装配的落点 */
  pi?: AgentSession
  /** 装配 in-flight 去重（双 submit 并发各建一个会话树会分叉） */
  piBuilding?: Promise<AgentSession>
  /**
   * 运行时控制台记录器；undefined = 尚未使用 —— 惰性（同 pi 内核）：构造要读
   * inspect/<id>.jsonl 尾部（含详情，可达 MB 级），启动期全量恢复会话会白吃内存；
   * 首次 submit / inspect 读取时才建，seq/run 从落盘尾部接续
   */
  inspector?: SessionInspector
  /** 系统提示词缓存（首用现算；会话生命周期内不变 —— AGENTS.md 改动不热更） */
  systemPrompt?: string
}

/**
 * 续写注入消息(R6③,Claude Code 的 append 式续写取向):显式 user 消息让
 * 模型明确「从截断处接着写」—— pi 的无痕 finishTurn{continue} 续跑可能开
 * 新话题。带 [cogent:continue] 前缀:投影层据此跳过成泡并把相邻 assistant
 * 段合并(保真在转录,聚合在投影);LLM 侧原样可见(它是引出续文的正当
 * 提示)。上限 3 次 —— 连环 length 时闸住,升级 UI 动作条交还用户。
 * pi 内核对贴线 maxTokens 截断不做恢复（recoverableLength 只收输出被夹的
 * 场景），本机制与之互补不重叠。
 */
const AUTO_CONTINUE_LIMIT = 3

/**
 * 会话内 run 的流式累积状态（工具循环段化）。
 * 一个 run 在 pi 里是多轮循环：assistant(text/toolCall) → toolResult →
 * assistant(text)…。段化模型：**轮内缓冲**（delta 累积 + 本轮工具记录）在
 * turn_end 封存成一段 ChatMessage；`segments` 按发生序收集全部段 ——
 * run.completed 的 messages 即它（text 段与工具卡交错保真），message 是
 * 全段聚合（老宿主兼容）。
 * 生命周期：streaming 在 submit 受理时置位、**agent_settled**
 * 终态时清位 —— 覆盖 pi 内聚恢复（provider 重试/溢出压缩重试）与 AUTO_CONTINUE
 * 续写链的全窗口，也是 submit 忙判定的单一账本（见 submit）。
 */
interface StreamingState {
  workspace: WorkspaceSnapshot
  runId: string
  titleInput?: { text: string }
  finalization?: Promise<void>
  turnId?: string
  fileContext?: FileContext
  fileReferences: Map<string, FileReference[]>
  attachmentInput?: { inputId: string; text: string; attachments: AttachmentRef[]; directories?: DirectoryRef[]; bound: boolean }
  images?: import('@earendil-works/pi-ai').ImageContent[]
  attachmentPreparation?: AbortController
  messageId: string
  /** Host从受理起持有取消意图，早于pi建立自己的run控制器。 */
  stopRequested: boolean
  /** 手动续写保留旧回答；新增计费仍只进入segments/usage。 */
  baseSegments: ChatMessage[]
  /** 原始输入只在submit存在；尚未交付pi的早停仍须落入转录。 */
  input: { text: string; timestamp: number } | null
  inputDelivered: boolean
  disposition: 'handled' | 'queued' | 'started' | undefined
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

/** 首条消息截断为会话标题的长度上限 */
const TITLE_MAX_CHARS = 24
/** 拒绝附言截断上限（防长附言打爆工具结果，与截断纪律同源） */
const APPROVAL_MESSAGE_MAX_CHARS = 2_000
const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_PROVIDER = 'anthropic'

export class SessionManager implements CogentKernel {
  private changingProjects = new Set<string>()
  private shuttingDown = false
  readonly searchService: SessionSearchService
  private messageSources = new WeakMap<AgentMessage, string>()
  readonly titleSettings: SessionTitleConfig
  private titleTasks = new Map<string, {
    controller: AbortController; trace: TitleTrace; inspector: SessionInspector; owner: StreamingState; response?: AssistantMessage
  }>()
  readonly outputs: OutputsService
  readonly changes: WorkspaceChangesService
  private sessions = new Map<string, Session>()
  private deletionTasks = new Map<string, Promise<void>>()
  private streaming = new Map<string, StreamingState>()
  /**
   * 手动压缩进行中的会话（并发护栏）：pi.compact() 是 async RPC，窗口期
   * submit/continueSession 需同步拒绝（pi prompt 对压缩窗口的 throw 发生在
   * 异步段，落不到"受理即拒"的协议形态）。自动压缩（threshold/overflow）由
   * pi 在 prompt 生命周期内自管，不经此Map。对象身份保护迟到finally不释放新操作。
   */
  private compacting = new Map<string, { stopRequested: boolean }>()
  /**
   * length 续写剩余次数(按会话):submit/手动续写时重置为 3。
   * agent_settled(抑制终态)与 settleRun(注入续写)两处同读 —— 前者据此抑制
   * 终态(续写还会接着跑),后者据此决定是否注入续写消息并扣减
   */
  private continuationBudget = new Map<string, number>()
  /**
   * 挂起中的审批：approval.request 发出 → 链式 beforeToolCall 的
   * Promise 悬着等 approval.respond。value 存 sessionId（会话删除/退出时按会话
   * 批量收尾 —— 不 resolve 则 pi 的 await 永悬、该 run 永不结束）+ 工具类别
   * （respond 的 always='workspace' 落规则时要知道落哪类）
   * + 工具名（approval.decided 审计条目的主文案，钩子座 4d）。
   */
  private pendingApprovals = new Map<
    string,
    {
      sessionId: string
      kind: ToolKind
      toolName: string
      callId: string
      summary: string
      ruleRoots: string[]
      withinRoots: boolean
      resolve: (result: { block: boolean; reason?: string }) => void
    }
  >()
  /**
   * 挂起中的提问（交互座 4c-2，pendingApprovals 同款骨架）：ask_user 的
   * execute 悬着等 question.respond。三路收尾：respond（作答）/
   * signal abort（取消 —— abort 的兜底 resolve，防 Promise 永悬）/
   * settleInteractions（会话删除/退出批量收口）。
   */
  private pendingQuestions = new Map<
    string,
    { sessionId: string; questions: AskQuestion[]; resolve: (result: { answers: AskAnswers; cancelled?: boolean }) => void }
  >()
  /**
   * 挂起中的方案审批（交互座 4c-3，同款骨架）：submit_plan 的 execute 悬着等
   * plan.respond。value 带 plan 全文（批准时落 StoredSession.plan 的数据源 ——
   * 工具参数只在挂起点可见，respond 时已拿不到）。收尾三路同 pendingQuestions。
   */
  private pendingPlans = new Map<
    string,
    {
      sessionId: string
      plan: string
      resolve: (verdict: { approved: true; switchMode?: string } | { approved: false; message?: string }) => void
    }
  >()
  private models: MutableModels
  private customProviders: CustomProviderRegistry
  /** 项目注册表（构造注入；submit/buildPiSession 时解析 projectId → 项目多根目录） */
  private projects: ProjectRegistry
  /** 审批规则表（构造注入；审批 ask 判定前查「始终允许此工作区」） */
  private approvals: ApprovalRegistry
  /** MCP 客户端配置 store（构造注入；pi 会话装配时取快照，阶段 4a） */
  private mcpConfig: McpConfigStore
  /** pi 运行时（目录 + 鉴权 + 请求路由；构造注入，index.ts 建于启动期） */
  private modelRuntime: ModelRuntime
  /** Cogent Host 根（pi 域 <root>/pi 的父目录，装配 pi 会话树用） */
  private hostRoot: string
  readonly businessConfig: BusinessConfig
  readonly attachments: AttachmentService

  constructor(
    private credentials: CredentialRegistry,
    private storage: StorageDriver,
    private notify: Notify,
    projects: ProjectRegistry,
    approvals: ApprovalRegistry,
    mcpConfig: McpConfigStore,
    private readonly skillStore: SkillStore,
    private inspectStore: InspectStore,
    modelRuntime: ModelRuntime,
    hostRoot: string
  ) {
    this.projects = projects
    this.approvals = approvals
    this.mcpConfig = mcpConfig
    this.modelRuntime = modelRuntime
    this.hostRoot = hostRoot
    this.searchService = new SessionSearchService(hostRoot)
    this.titleSettings = new SessionTitleConfig(hostRoot)
    this.attachments = new AttachmentService(hostRoot)
    this.outputs = new OutputsService(hostRoot, (doc) => this.notify('outputs.updated', doc))
    this.changes = new WorkspaceChangesService(hostRoot, (summary) => this.notify('changes.updated', summary))
    // pi 内置全部 provider 的模型目录（UI 下拉 + submit 模型解析仍走它）；
    // pi 内核的请求路由走 modelRuntime —— custom provider 经 registerNativeProvider
    // 双注册（见 custom-providers.ts），内置 provider 的 key 经凭据 sink 进 runtime
    this.models = builtinModels()
    this.customProviders = new CustomProviderRegistry(this.models, modelRuntime)
    this.customProviders.snapshotBuiltin()
    this.businessConfig = new BusinessConfig(hostRoot)
    this.customProviders.sync(this.businessConfig.providers.providers, this.businessConfig.providers.overrides)
    // 启动恢复：只拉摘要（惰性装配，见 Session.pi / Session.inspector 注释）。
    // 损坏（截断/手改/旧版本形状）逐文件隔离：报错 + 改名 .corrupt 旁置 + 继续
    // 恢复其余会话 —— 单文件损坏若任其炸构造器，引擎进程拒启 = 全部会话陪葬，
    // 这超出了约定.md §1.1「报错而非静默重建」的立法本意（可见性保留：stderr
    // 诊断 + 旁置文件可查，且该会话确实不加载 = 不静默重建）
    for (const id of this.storage.ids(SESSION_COLLECTION)) {
      try {
        const stored = this.storage.get(SESSION_COLLECTION, id)
        const doc = asStoredSession(stored, id)
        if (stored?.deleted === true) {
          this.trackDeletion(id, this.cleanupDeleted(id, doc.piCwd ?? this.projectByIdOrCwd(doc.summary.cwd, doc.summary.projectId)?.cwds[0] ?? doc.summary.cwd ?? homedir()))
          continue
        }
        this.sessions.set(doc.summary.id, {
          summary: doc.summary,
          autoTitle: doc.autoTitle,
          piCwd: doc.piCwd,
          todos: doc.todos ?? [],
          ...(doc.plan !== undefined && { plan: doc.plan }),
          ...(doc.legacyTranscript !== undefined && { legacyTranscript: doc.legacyTranscript })
        })
      } catch (error) {
        this.storage.quarantine(SESSION_COLLECTION, id)
        process.stderr.write(
          `[host] 会话文档损坏已隔离（sessions/${id}.json → .corrupt）: ${(error as Error).message}\n`
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
    if (session.workspace !== undefined) return session.workspace.roots
    const roots: string[] = []
    if (session.summary.cwd !== undefined) roots.push(session.summary.cwd)
    if (session.summary.projectId !== undefined) {
      for (const cwd of this.projects.get(session.summary.projectId)?.cwds ?? []) {
        if (!roots.includes(cwd)) roots.push(cwd)
      }
    }
    return roots
  }

  private captureWorkspace(session: Session): WorkspaceSnapshot {
    if (session.workspace === undefined) {
      const roots = this.workspaceRoots(session)
      session.workspace = { cwd: roots[0] ?? homedir(), roots: [...roots] }
    }
    return session.workspace
  }

  assertProjectAvailable(projectId: string): void {
    if (this.changingProjects.has(projectId)) throw new ProtocolError(RpcErrorCode.InvalidRequest, '项目目录正在切换，请稍后重试')
  }

  private assertWorkspaceAvailable(session: Session): void {
    if (session.summary.projectId !== undefined) this.assertProjectAvailable(session.summary.projectId)
  }

  async updateProject(projectId: string, name: string, cwds: string[]): Promise<import('../../protocol').ProjectSummary> {
    this.assertProjectAvailable(projectId)
    const current = this.projects.get(projectId)
    if (current !== undefined && current.cwds.length === cwds.length && current.cwds.every((root, index) => root === cwds[index]))
      return this.projects.update(projectId, name, cwds)
    return this.replaceProjectRoots(projectId, () => this.projects.update(projectId, name, cwds))
  }

  async deleteProject(projectId: string): Promise<boolean> {
    this.assertProjectAvailable(projectId)
    if (this.projects.get(projectId) === undefined) return false
    return this.replaceProjectRoots(projectId, () => this.projects.delete(projectId))
  }

  /** 先预约所有归属会话，再等旧资源退出；失败不发布新根，释放后的实例可按旧根重建。 */
  private async replaceProjectRoots<T>(projectId: string, commit: () => T): Promise<T> {
    this.assertProjectAvailable(projectId)
    const affected = [...this.sessions.values()].filter(session => session.summary.projectId === projectId)
    if (affected.some(session => this.streaming.has(session.summary.id) || this.compacting.has(session.summary.id) || session.piBuilding !== undefined))
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '项目中的会话正在工作，请先停止或等待完成后再修改目录')
    this.changingProjects.add(projectId)
    try {
      for (const session of affected) {
        if (session.piCwd === undefined) {
          const candidate = { ...session, piCwd: this.transcriptCwd(session) }
          this.writeSession(candidate)
          session.piCwd = candidate.piCwd
        }
        this.cancelTitle(session.summary.id, '项目目录变更')
      }
      const results = await Promise.allSettled(affected.map(async session => {
        try { if (session.pi !== undefined) await shutdownPiSession(session.pi) }
        finally { session.pi = undefined; session.systemPrompt = undefined; session.workspace = undefined }
      }))
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      if (this.shuttingDown) throw new ProtocolError(RpcErrorCode.InvalidRequest, '引擎正在退出，项目目录未切换')
      return commit()
    } finally { this.changingProjects.delete(projectId) }
  }

  private transcriptCwd(session: Session): string {
    return session.piCwd ?? this.workspaceRoots(session).at(0) ?? homedir()
  }

  /**
   * 会话的项目归属（「允许，并切换为」的项目默认落位用）。无归属返回
   * undefined（只切当前会话，不落项目默认）。
   */
  private projectIdOf(session: Session): string | undefined {
    return this.projectByIdOrCwd(session.summary.cwd, session.summary.projectId)?.id
  }

  /**
   * 项目解析（projectId 优先，否则 cwd 前缀落进某项目 cwds = 同项目；与
   * renderer 新会话的项目默认链同口径）：resolve 归一 + 小写 + 补分隔符，
   * 只防 `work` 误配 `work-x`，跨盘符/大小写差异按命中处理（Windows 不敏感）。
   */
  private projectByIdOrCwd(cwd: string | undefined, projectId: string | undefined) {
    if (projectId !== undefined) {
      const project = this.projects.get(projectId)
      if (project !== undefined) return project
    }
    if (cwd === undefined) return undefined
    const normalized = resolve(cwd).toLowerCase()
    for (const project of this.projects.list()) {
      for (const root of project.cwds) {
        const r = resolve(root).toLowerCase()
        if (normalized === r || normalized.startsWith(r + sep)) return project
      }
    }
    return undefined
  }

  /**
   * 工具的基根：绑定根，无绑定时兜底用户主目录 —— 桌面应用语境下
   * "launch cwd" 的等价物。保证**任何会话都有只读工具**（主流共识：读几乎
   * 不设限，Claude Code 的 Read/Glob/Grep 默认全盘允许；无绑定会话零工具
   * 比所有主流产品都严，2026-11-10 用户驳回）。写类工具的**限界根**沿用
   * 同一列表（无根写主目录也要过审批）。
   */
  private toolRoots(session: Session): string[] {
    const roots = this.workspaceRoots(session)
    return roots.length > 0 ? roots : [homedir()]
  }

  /** 系统提示词惰性算 + 缓存（submit 的观测快照与 pi 装配共用同一份） */
  private ensureSystemPrompt(session: Session): string {
    this.captureWorkspace(session)
    session.systemPrompt ??= buildSystemPrompt(this.workspaceRoots(session), this.toolRoots(session))
    return session.systemPrompt
  }

  /** 自定义 provider / 内置 baseUrl 覆盖的全量同步（providers.custom.sync 委托） */
  syncCustomProviders(defs: CustomProviderDef[], overrides: ProviderOverrideDef[]): number {
    return this.businessConfig.setProviders({ providers: defs, overrides }, () => this.customProviders.prepare(defs, overrides))
  }

  // ———— 会话 CRUD ————

  create(
    params: {
      title?: string
      cwd?: string
      projectId?: string
      permissionMode?: PermissionMode
      planEnabled?: boolean
    } = {}
  ): SessionSummary {
    if (params.projectId !== undefined) this.assertProjectAvailable(params.projectId)
    const now = Date.now()
    // 模式缺省解析（F6）：直驱协议/其他宿主不带 permissionMode 时按项目默认
    // 兜底（renderer 走自己的同规则链，显式值优先两不冲突）。项目也没设 →
    // 不带字段 = ask（协议缺省语义，旧宿主不破）
    const defaultMode =
      params.permissionMode !== undefined
        ? params.permissionMode
        : this.projectByIdOrCwd(params.cwd, params.projectId)?.defaultPermissionMode ?? this.businessConfig.defaults.defaultPermissionMode
    // UUID 而非自增序号：自增在持久化后重启必然撞号（旧盘 s-1 vs 新会话 s-1）
    const summary: SessionSummary = {
      id: crypto.randomUUID(),
      title: params.title?.trim() || '新会话',
      ...(params.title?.trim() && { titleManual: true }),
      createdAt: now,
      updatedAt: now,
      ...(params.cwd !== undefined && { cwd: params.cwd }),
      ...(params.projectId !== undefined && { projectId: params.projectId }),
      permissionMode: defaultMode,
      ...(params.planEnabled === true && { planEnabled: true })
    }
    const session: Session = { summary, todos: [], ...(summary.titleManual !== true && { autoTitle: 'ready' }) }
    session.piCwd = this.transcriptCwd(session)
    // 显式创建只有摘要保存后才可被其他调用看见，磁盘失败由 RPC 边界返回。
    this.writeSession(session)
    this.sessions.set(summary.id, session)
    return summary
  }

  /**
   * 会话列表（session.list 响应）。默认滤掉已归档（archivedAt 有值）—— 归档是
   * 回收站语义，主列表 = 活跃会话；归档视图走 listArchived（设置页）。
   */
  list(): SessionSummary[] {
    return Array.from(this.sessions.values(), (s) => s.summary).filter((s) => s.archivedAt === undefined)
  }

  /** 已归档会话（设置页「归档」数据源），按归档时间倒序（新归档在上） */
  listArchived(): SessionSummary[] {
    return Array.from(this.sessions.values(), (s) => s.summary)
      .filter((s) => s.archivedAt !== undefined)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  }

  /** 重命名不改变最近活动顺序，也不装配 pi；先落盘再发布，保存失败不能假报成功。 */
  rename(sessionId: string, title: string): SessionSummary {
    const session = this.requireSession(sessionId)
    const summary = { ...session.summary, title, titleManual: true }
    this.writeSession({ ...session, summary, autoTitle: 'attempted' })
    this.cancelTitle(sessionId, '用户手动重命名')
    session.summary = summary
    session.autoTitle = 'attempted'
    this.notify('session.summaryChanged', { summary: { ...summary } })
    return { ...summary }
  }

  setPinned(sessionId: string, pinned: boolean): SessionSummary {
    const session = this.requireSession(sessionId)
    const summary = { ...session.summary }
    // 存时间不存布尔：置顶分区按 pinnedAt 倒序，新置顶在上；取消 = 字段移除
    if (pinned) summary.pinnedAt = Date.now()
    else delete summary.pinnedAt
    this.writeSession({ ...session, summary })
    session.summary = summary
    return { ...summary }
  }

  /** 归档/恢复（回收站语义：archived=false = 恢复回活跃列表）。归档不中止进行中
      回复 —— 转录由 pi 照常落盘，只是会话从主列表消失（agent_settled 不受影响） */
  archive(sessionId: string, archived: boolean): SessionSummary {
    const session = this.requireSession(sessionId)
    const summary = { ...session.summary }
    if (archived) summary.archivedAt = Date.now()
    else delete summary.archivedAt
    this.writeSession({ ...session, summary })
    session.summary = summary
    return { ...summary }
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    // 删除标记先提交；后续文件清理失败或进程崩溃，都不会在重启时复活。
    this.writeSession(session, true)
    this.cancelTitle(sessionId, '会话已删除')
    this.streaming.get(sessionId)?.attachmentPreparation?.abort()
    // pi 内核整拆（abort 全部运行中工作 + 拆钩，agent-session dispose 语义）
    const closing = session.pi ? shutdownPiSession(session.pi) : session.piBuilding?.then(pi => shutdownPiSession(pi)) ?? Promise.resolve()
    // 挂起审批/提问先收尾再拆会话：resolve 让挂起中的 await 落地、
    // run 正常走完收尾路径（事件转译要能找到会话，先 settle 后删）
    this.settleApprovals(sessionId, '会话已删除')
    this.settleInteractions(sessionId)
    this.sessions.delete(sessionId)
    this.streaming.delete(sessionId)
    this.compacting.delete(sessionId)
    this.trackDeletion(sessionId, closing.then(() => this.cleanupDeleted(sessionId, this.transcriptCwd(session))))
    return true
  }

  private trackDeletion(id: string, work: Promise<void>): void {
    this.deletionTasks.set(id, work)
    void work.catch(error => process.stderr.write(`[host] 删除已提交，清理待重试（${id}）: ${String(error)}\n`))
  }
  async deletionSettled(id: string): Promise<string | undefined> {
    try { await this.deletionTasks.get(id); this.deletionTasks.delete(id); return undefined }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }

  private async cleanupDeleted(sessionId: string, cwd: string): Promise<void> {
    const piFile = findPiTranscriptFile(cwd, this.hostRoot, sessionId)
    if (piFile !== undefined) rmSync(piFile, { force: true })
    this.inspectStore.delete(sessionId)
    const attachmentConfig = new AttachmentConfig(this.hostRoot)
    this.attachments.releaseSession(sessionId, id => attachmentConfig.references(id))
    await this.outputs.releaseSession(sessionId)
    await this.changes.releaseSession(sessionId)
    // 标记最后移除；任一清理失败仍有可恢复入口。
    this.storage.delete(SESSION_COLLECTION, sessionId)
  }

  /**
   * 会话消息转录（session.messages 响应）：pi 消息[] → ChatMessage[]。
   * 呈现口径恒走 pi JSONL 全量回查（factory readPiTranscript：影子区/多代
   * 压缩条全保留，采用保留式；pi 的 agent.state.messages 是**上下文口径**的
   * 裁剪投影，压缩后影子区消失，不能作历史呈现源）。pi JSONL 不存在时回落
 * v1 旧转录（未导入的历史会话）。运行中的半截流式消息不在 JSONL
 * （message_end 才落盘）—— 流式期宿主以事件流增量呈现为主，不受影响。
   */
  async search(query: SearchQuery): Promise<SearchPage> {
    const descriptors = Array.from(this.sessions.values(), (session) => ({
      summary: { ...session.summary }, cwd: this.transcriptCwd(session)
    }))
    const result = await this.searchService.search(query, descriptors)
    // 读取期间的删除与归档不可由迟到 worker 响应复活。
    result.items = result.items.filter((item) => {
      const current = this.sessions.get(item.session.id)
      if (current === undefined || (!query.includeArchived && current.summary.archivedAt !== undefined)) return false
      item.session = { ...current.summary }
      return true
    })
    return result
  }

  interactionSnapshot(sessionId: string) {
    return {
      approvals: [...this.pendingApprovals].filter(([, p]) => p.sessionId === sessionId).map(([requestId, p]) => ({ sessionId, requestId, callId: p.callId, toolName: p.toolName, kind: p.kind, summary: p.summary, outsideRoots: !p.withinRoots })),
      questions: [...this.pendingQuestions].filter(([, p]) => p.sessionId === sessionId).map(([requestId, p]) => ({ sessionId, requestId, questions: p.questions })),
      plans: [...this.pendingPlans].filter(([, p]) => p.sessionId === sessionId).map(([requestId, p]) => ({ sessionId, requestId, plan: p.plan }))
    }
  }

  snapshotMessages(sessionId: string): ChatMessage[] {
    const history = this.messages(sessionId), run = this.streaming.get(sessionId)
    if (!run) return history
    const userAt = history.findLastIndex(message => message.role === 'user' && message.turnId === run.turnId)
    const prefix = userAt >= 0 ? history.slice(0, userAt + 1) : [...history]
    if (userAt < 0 && run.input !== null) prefix.push({ id: run.turnId!, turnId: run.turnId, role: 'user', content: run.input.text, timestamp: run.input.timestamp,
      attachments: run.attachmentInput?.attachments, directories: run.attachmentInput?.directories })
    const segments = SessionManager.displaySegments(run)
    if (run.text !== '' || run.thinking !== '' || run.tools.length > 0) segments.push({
      id: run.messageId, role: 'assistant', turnId: run.turnId, content: run.text, thinking: run.thinking || undefined,
      toolCalls: run.tools.map(tool => ({ ...tool })), timestamp: Date.now()
    })
    return [...prefix, ...segments]
  }

  runtimeSnapshot(sessionId: string): { running: boolean; runId?: string; turnId?: string; activeMessageId?: string } {
    this.requireSession(sessionId)
    const run = this.streaming.get(sessionId)
    return { running: run !== undefined, ...(run && { runId: run.runId, turnId: run.turnId, activeMessageId: run.messageId }) }
  }

  messages(sessionId: string): ChatMessage[] {
    const session = this.requireSession(sessionId)
    const source: AgentMessage[] = transcriptAuthority(this.transcriptCwd(session), this.hostRoot, sessionId, session.legacyTranscript).messages
    const projected = toChatMessages(source)
    // 上下文明细按需现算挂"末条带 usage 的消息"（历史回查路径，重启/切换会话
    // 走这）：agent_settled 只把估算挂到事件侧 streaming 对象随 run.completed
    // 飞走，不进 pi 转录（pi 形状，塞协议字段会浑浊真源）—— 不现算的话明细
    // 只在运行当次可见，重启即丢（2026-11-11 用户报障）。
    // estimateContext 是纯转录函数，读时重算幂等、免盘上迁移，旧会话也由此
    // 直接有明细（免"无字段降级"）。挂点 = 从后往前首条带 usage 的 assistant，
    // 与指示器分子的读取序一致；纯工具段末条无正文本体的边角与事件路径同缺
    // （flattenSegments 不落本体），不另补。system 段：活会话取 pi
    // 当前渲染（含 pi 追加节），惰性回落自拼提示词（≈ 粗估）
    const roots = this.workspaceRoots(session)
    const systemPrompt =
      session.pi?.systemPrompt ??
      renderPromptWithSections(
        this.ensureSystemPrompt(session),
        roots[0] ?? homedir(),
        buildDynamicSections({
          permissionMode: session.summary.permissionMode ?? 'ask',
          planEnabled: session.summary.planEnabled === true,
          skillsSection: formatSkillsSection(this.skillStore.snapshotMany(roots).skills),
          todosSection: todosSectionText(session.todos),
          planSection: session.plan !== undefined ? planSectionText(session.plan) : null
        })
      )
    for (let i = projected.length - 1; i >= 0; i--) {
      const m = projected[i]
      if (m.role === 'assistant' && m.usage) {
        m.usage = { ...m.usage, contextEstimate: estimateContext(source, systemPrompt, session.pi?.agent.state.tools) }
        break
      }
    }
    return projected
  }

  /** 文件服务按明确回合取来源；历史回查不装配 pi，旧数据降级事实由调用方标明。 */
  fileContext(sessionId: string, turnId?: string): { context: Pick<FileContext, 'cwd' | 'roots' | 'platform'>; saved: boolean } {
    const session = this.requireSession(sessionId)
    const active = this.streaming.get(sessionId)
    const context = active?.turnId === turnId ? active?.fileContext : undefined
    const saved = context ?? (turnId === undefined ? undefined : readPiTranscript(this.transcriptCwd(session), this.hostRoot, sessionId)?.find((message) => message.fileContext?.turnId === turnId)?.fileContext)
    if (turnId !== undefined && saved === undefined) throw new Error('文件来源尚未保存或该回合不存在，请稍后重试')
    return saved === undefined ? { context: { cwd: this.workspaceRoots(session).at(0) ?? homedir(), roots: this.workspaceRoots(session), platform: process.platform }, saved: false } : { context: saved, saved: true }
  }

  /**
   * 当前任务清单（session.messages 的 todos 字段 / TodoStrip 打开会话的种子）。
   * 惰性会话零成本：清单在会话文档里（todo_write 落笔即 persist），不依赖 pi 装配。
   */
  todos(sessionId: string): TodoItem[] {
    return [...this.requireSession(sessionId).todos]
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

  /** 探测按双键取当前有效模型；被禁用的定义不旁路注册表，避免测到聊天用不到的配置。 */
  testModel(providerId: string, modelId: string): Promise<{ elapsedMs: number }> {
    const model = this.models.getModel(providerId, modelId)
    if (model === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `模型不存在或已禁用: ${providerId}/${modelId}`)
    }
    return testModelConnectivity(this.modelRuntime, model)
  }

  /** pi catalog → 协议模型摘要（UI 下拉数据源；key 配置状态在 credentials.list 单独查） */
  listModels(): { models: ModelSummary[]; defaultModel: { provider: string; id: string } } {
    return {
      defaultModel: { provider: DEFAULT_PROVIDER, id: DEFAULT_MODEL },
      models: projectModelSummaries(this.models.getModels(), (provider, id) => this.customProviders.isUserDefined(provider, id))
    }
  }

  /** 某模型的 provider 是否已配 key（renderer 据此置灰下拉项） */
  isProviderConfigured(modelId: string): boolean {
    const model = this.models.getModels().find((m) => m.id === modelId)
    return model !== undefined && this.credentials.has(model.provider)
  }

  // ———— Agent 主链路 ————
  //
  // 受理与执行的时序（owner 小图，涉及会话状态/异步链路，约定.md 硬规则 5）：
  //
  //   submit(同步段)          异步段（driveRun）                    终态（事件）
  //   ───────────────         ───────────────────────              ────────────
  //   requireSession          ensurePiSession（惰性+导入）          agent_settled
  //   根目录复查              setModel/setThinkingLevel             ├ aborted/errorMessage→run.failed
  //   busy 查 streaming/      pi.prompt(text)                      │   （pi 内聚恢复
  //     compacting            └→ pi 内聚：重试/溢出压缩             │    已全部消化完）
  //   模型目录解析(同步throw)     /阈值压缩（不外显）               ├ lengthContinuable
  //   标题/updatedAt/persist  settleRun：AUTO_CONTINUE              │   → 抑制（续写链接管）
  //   run.started             链（每段又是一个 prompt               └ 否则 → run.completed
  //   streaming.set           生命周期，逐段 agent_settled）
  //
  //   submit/continue在首await前预约StreamingState，manualcompact持有自己的操作对象。
  //   abort先记stopRequested；每个await后查owner，started回调补交pi取消。
  //   未prompt中止先保存user；handled无pi终态则Host收口；删除使旧owner失效。

  /**
   * 提交用户输入。同步校验（会话存在、会话空闲、模型已知）后立即受理返回，
   * LLM 循环异步执行、进度经事件流推送 —— 协议刻意把"长任务"设计为事件驱动：
   * LLM 循环以分钟计，请求-响应会挂死宿主。
   *
   * 为什么校验必须同步 throw（→ dispatch 转错误响应帧）：dispatch 的 try/catch
   * 只包住 handler 的同步段，异步拒绝会变成 unhandledRejection 直接崩掉引擎
   * 进程（全部会话随之丢失）——此前 `void sessions.submit(...)` 正是踩了这一坑。
   *
   * busy 判定（单一账本 = streaming map + 手动压缩集）：streaming 窗口覆盖
   * "受理→agent_settled 终态"全程，比 pi 的 isStreaming 更宽（后者在 pi 内聚
   * 恢复/续写链的 run 间隙会瞬时为 false，查它会放双 prompt 进同一个链）。
   */
  submit(sessionId: string, text: string, model?: string, thinkingLevel?: string, provider?: string,
    attachmentIds: string[] = [], inputId: string = crypto.randomUUID(), directories: DirectoryRef[] = []): { runId: string; turnId: string } {
    const session = this.requireSession(sessionId)
    this.assertWorkspaceAvailable(session)
    const workspace = this.captureWorkspace(session)
    // 工作区复查（多根）：任一根目录被删/移动 → 显式报错（外部世界会变，
    // 静默继续 = 模型对不存在的目录输出幻觉操作）。同步 throw → dispatch 错误帧
    for (const root of this.workspaceRoots(session)) {
      if (!existsSync(root)) {
        throw new ProtocolError(RpcErrorCode.InvalidRequest, `工作区目录不存在或已被移动: ${root}`)
      }
    }
    if (this.streaming.has(sessionId) || this.compacting.has(sessionId)) {
      // 文案不带 sessionId（渲染层 lastError 直出给用户看；定位信息走日志）
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '会话正在回复中，请先停止或等待完成')
    }
    let target: Model<Api> | undefined
    if (model) {
      // provider 双键限定优先：同名模型会被多家目录收录（azure 目录也有
      // deepseek-v4-pro），id 单键全局查找按注册序撞 azure 那份 → "Provider
      // is not configured: azure"。UI 选择时的 provider 原样下发即可消歧；
      // 未带 provider 的老宿主保持旧解析序（默认 provider 优先 → 全局 id）
      target = provider !== undefined
        ? this.models.getModel(provider, model)
        : this.models.getModel(DEFAULT_PROVIDER, model) ?? this.models.getModels().find((m) => m.id === model)
      if (!target) throw new Error(`未知模型: ${model}`)
    }

    const attachments = this.attachments.claim(attachmentIds, sessionId)
    const firstInput = session.autoTitle === 'ready'
    // 恢复的 ready 若已落过真实 user，则只消费资格，不能把下一条错当首条。
    const previousInput = firstInput && (session.legacyTranscript ?? readPiTranscript(
      this.transcriptCwd(session), this.hostRoot, sessionId
    ) ?? []).some((message) => message.role === 'user')
    if (firstInput) session.autoTitle = 'attempted'
    if (firstInput && !previousInput && session.summary.titleManual !== true) {
      session.summary.title = (text.trim() || [...attachments, ...directories].map((a) => a.name).join('、')).slice(0, TITLE_MAX_CHARS) || session.summary.title
    }
    session.summary.updatedAt = Date.now()
    let titleSaved = false
    // 辅助任务要求消费资格真实落盘；失败只影响标题，不能挡住主对话。
    if (firstInput) {
      try { this.writeSession(session); titleSaved = true }
      catch (error) { process.stderr.write(`[host] 自动标题资格保存失败（${sessionId}）: ${String(error)}\n`) }
    } else this.persist(sessionId)
    if (firstInput && !previousInput) this.notify('session.summaryChanged', { summary: { ...session.summary } })

    const runId = crypto.randomUUID()
    this.ensureInspector(session).runStarted(text, this.ensureSystemPrompt(session), thinkingLevel ?? 'off')
    const streaming: StreamingState = {
      workspace,
      runId,
      turnId: inputId,
      fileReferences: new Map(),
      messageId: `m-${crypto.randomUUID()}`,
      stopRequested: false,
      baseSegments: [],
      input: { text, timestamp: Date.now() },
      inputDelivered: false,
      disposition: undefined,
      segments: [],
      text: '',
      thinking: '',
      tools: []
    }
    const titlePolicy = this.titleSettings.get()
    if (firstInput && !previousInput && titleSaved && titlePolicy.enabled && session.summary.titleManual !== true) {
      streaming.titleInput = { text: Array.from([text, ...attachments.map((item) => item.name), ...directories.map((item) => item.name)].join('\n')).slice(0, 4_000).join('') }
    }
    if (attachments.length > 0 || directories.length > 0) streaming.attachmentInput = { inputId, text, attachments,
      ...(directories.length > 0 && { directories }), bound: false }
    this.streaming.set(sessionId, streaming)
    this.notify('run.started', { sessionId, runId, turnId: inputId, input: streaming.input! })
    this.outputs.begin(sessionId, inputId, streaming)
    this.changes.begin(sessionId, inputId, streaming, workspace.roots)
    this.continuationBudget.set(sessionId, AUTO_CONTINUE_LIMIT)
    // 异步段的三类失败（装配炸 / prompt 前置校验拒 / 续写链异常）都收口到
    // run.failed —— run.started 已发，宿主在等终态事件，不能让拒绝裸奔
    void this.driveRun(session, text, target, thinkingLevel, streaming).catch(async (error: unknown) => {
      // 终态已由 pi 事件收口或会话已删时，旧异步链不能再发第二份终态、更不能清新 run。
      if (this.streaming.get(sessionId) !== streaming) return
      if (streaming.attachmentInput !== undefined && session.pi !== undefined) this.saveUnstartedInput(session.pi, streaming)
      await this.finishRun(session, streaming, 'error', () => this.notify('run.failed', { runId: streaming.runId, turnId: streaming.turnId,
        sessionId,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error)
      }))
    })
    return { runId, turnId: inputId }
  }

  /** submit 异步段：装配 pi 内核 → 应用模型/思考档 → prompt → 续写链收尾 */
  private async driveRun(
    session: Session,
    text: string,
    model: Model<Api> | undefined,
    thinkingLevel: string | undefined,
    streaming: StreamingState
  ): Promise<void> {
    const pi = await this.ensurePiSession(session)
    if (this.finishPreparingRun(session, pi, streaming)) return
    if (model !== undefined) {
      // setModel 判等：pi 为每次调用落 model_change 条目（空消息），重复 set
      // 同一模型会在树里堆空条目 —— 压缩切点的「空条目回退」（findProjected-
      // CutPoint 末段把切点从 user 边界挪过空条目）会让 startsTurn 误判为
      // false → 本应整回合摘要的压缩被拆成 split-turn（实测：每回合 setModel
      // → 全部压缩走 turn-prefix 路径）。只在模型真变时调用
      // pi.model 是 getter（首回合前可能 undefined —— factory 的默认模型在
      // 目录查不到时 createAgentSession 不带 model）；显式收窄后判等
      const current = pi.model
      if (current === undefined || current.id !== model.id || current.provider !== model.provider) {
        await pi.setModel(model)
        if (this.finishPreparingRun(session, pi, streaming)) return
      } else {
        // 同名模型的本地能力/端点定义也可更新；只刷新公开 Agent 状态，不追加虚假的模型切换条目。
        pi.agent.state.model = model
      }
      // 思考预算跟随模型：预算是模型属性，切模型换预算。
      // pi 的预算消费在请求选项层（Agent.thinkingBudgets 逐 prompt 带进
      // streamFn 选项），setModel 不动它，此处直赋（字段公开，官方同款手法）
      pi.agent.thinkingBudgets = model.thinkingBudgets
    }
    if (thinkingLevel !== undefined && pi.thinkingLevel !== thinkingLevel) {
      // 'off' 合法：pi 原生档（关闭思考）；setThinkingLevel 会向模型能力
      // clamp（非能力档显式拒于 dispatch 入口的值域白名单，到不了这）。
      // 判等防每回合堆 thinking_level_change 空条目（同 setModel 注释）
      pi.setThinkingLevel(thinkingLevel as ThinkingLevel)
    }
    // /skill: 活展开：pi 内建展开查 loader 静态集（agent-session.ts:2319），
    // 与段落钩子的回合热刷新会脱节 —— 统一由 skillStore 用活快照展开
    if (this.finishPreparingRun(session, pi, streaming)) return
    let prompt = this.skillStore.expandSkillCommand(text, this.workspaceRoots(session))
    if (streaming.attachmentInput !== undefined) {
      const refs = streaming.attachmentInput.attachments
      const controller = new AbortController()
      streaming.attachmentPreparation = controller
      let prepared: Array<{ id: string; locator: string }>
      try { prepared = await this.attachments.prepareForSend('local', refs, controller.signal) }
      catch (error) { if (this.finishPreparingRun(session, pi, streaming)) return; throw error }
      if (this.finishPreparingRun(session, pi, streaming)) return
      const images: import('@earendil-works/pi-ai').ImageContent[] = []
      const lines: string[] = []
      const nativeCount = pi.model?.input.includes('image') === true ? refs.filter((ref) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(ref.mime)).length : 0
      assertNewImageMessage(nativeCount, pi.model)
      for (const [index, ref] of refs.entries()) {
        const nativeImage = pi.model?.input.includes('image') === true && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(ref.mime)
        if (nativeImage) {
          // pi 的 prompt 归一化会把解码失败降成 omitted 文本；先显式预检，不能让 UI 显示已发送而静默丢图。
          const processed = await resizeImage(readFileSync(prepared[index].locator), ref.mime, pi.model.inputLimits?.images?.resize)
          if (this.finishPreparingRun(session, pi, streaming)) return
          if (processed === null) throw new Error(`图片无法解码或缩放：${ref.name}。可重新附加或切换到分析工具。`)
          images.push({ type: 'image', data: processed.data, mimeType: processed.mimeType })
          const note = formatDimensionNote(processed)
          if (note !== undefined) lines.push(note)
        }
        lines.push(JSON.stringify({ id: ref.id, name: ref.name, mime: ref.mime, size: ref.size,
          path: prepared[index].locator, content: nativeImage ? '图片随消息发送' : '尚未读取；需要内容时调用 read_attachment' }))
      }
      streaming.images = images
      if (lines.length > 0) prompt += formatAttachmentsBlock(lines)
      const directories = streaming.attachmentInput.directories
      if (directories !== undefined) {
        // 目录保持实时引用，按需用现有工具访问；它不是项目根，也不授予额外写权限。
        prompt += formatDirectoryReferencesBlock(directories)
      }
    }
    await this.promptRun(session, pi, streaming, prompt)
    await this.settleRun(session, pi, streaming)
  }

  /** 本次准备链只认捕获的对象；删除/退出或旧终态之后不得继续起跑。 */
  private ownsRun(session: Session, streaming: StreamingState): boolean {
    return this.sessions.get(session.summary.id) === session && this.streaming.get(session.summary.id) === streaming
  }

  private saveUnstartedInput(pi: AgentSession, streaming: StreamingState): void {
    if (streaming.input === null || streaming.inputDelivered) return
    pi.sessionManager.appendMessage({ role: 'user', content: streaming.input.text, timestamp: streaming.input.timestamp })
    pi.refreshContext()
    streaming.inputDelivered = true
  }

  private static displaySegments(streaming: StreamingState): ChatMessage[] {
    // merge会原位并相邻文本；克隆片段，不能改写已保存的旧回答或重复累加其用量。
    const source = [...streaming.baseSegments, ...streaming.segments]
    const segments = SessionManager.mergeContinuedSegments(source.map((segment) => ({ ...segment })))
    // 费用按全部显示段求和，上下文估算只描述末次请求后的转录，不能随费用累加丢失。
    const contextEstimate = source.findLast((segment) => segment.usage !== undefined)?.usage?.contextEstimate
    const last = segments.findLast((segment) => segment.usage !== undefined)
    if (last?.usage !== undefined && contextEstimate !== undefined) last.usage = { ...last.usage, contextEstimate }
    return segments
  }

  /** 产物保存与模型结果分开记错；预约直到文件终态落定才释放。所有收口共用此门。 */
  private finishRun(session: Session, streaming: StreamingState, outcome: OutputOutcome, complete: () => void): Promise<void> {
    if (outcome === 'aborted' && this.titleTasks.get(session.summary.id)?.owner === streaming) this.cancelTitle(session.summary.id, '首轮已停止')
    if (streaming.finalization !== undefined) return streaming.finalization
    if (!this.ownsRun(session, streaming)) return Promise.resolve()
    const outputsEmpty = streaming.turnId === undefined || this.outputs.finishEmpty(session.summary.id, streaming.turnId, streaming)
    const changesEmpty = streaming.turnId === undefined || this.changes.finishEmpty(session.summary.id, streaming.turnId, streaming)
    if (outputsEmpty && changesEmpty) {
      this.streaming.delete(session.summary.id)
      complete()
      return Promise.resolve()
    }
    streaming.finalization = (async () => {
      if (streaming.turnId !== undefined && !outputsEmpty) {
        try { await this.outputs.finalize(session.summary.id, streaming.turnId, streaming, outcome) }
        catch (error) {
          if (this.ownsRun(session, streaming)) {
            try {
              const saved = await this.outputs.lastConfirmed(session.summary.id, streaming.turnId)
              if (saved !== undefined && this.ownsRun(session, streaming)) this.notify('outputs.updated', saved)
            } catch (readError) { process.stderr.write(`[outputs] 结算失败后回读确认版失败: ${readError instanceof Error ? readError.message : String(readError)}\n`) }
            if (this.ownsRun(session, streaming)) this.notify('outputs.error', { sessionId: session.summary.id, turnId: streaming.turnId, message: error instanceof Error ? error.message : String(error) })
          }
        }
      }
      if (streaming.turnId !== undefined && !changesEmpty) {
        try { await this.changes.finalize(session.summary.id, streaming.turnId, streaming, outcome) }
        catch (error) {
          if (this.ownsRun(session, streaming)) {
            this.notify('changes.error', { sessionId: session.summary.id, turnId: streaming.turnId, message: error instanceof Error ? error.message : String(error) })
          }
        }
      }
      if (!this.ownsRun(session, streaming)) return
      this.streaming.delete(session.summary.id)
      complete()
    })()
    return streaming.finalization
  }

  private finishPreparingRun(session: Session, pi: AgentSession, streaming: StreamingState): boolean {
    if (!this.ownsRun(session, streaming)) return true
    if (!streaming.stopRequested) return false
    this.saveUnstartedInput(pi, streaming)
    session.inspector?.runFailed('已停止')
    void this.finishRun(session, streaming, 'aborted', () => this.notify('run.failed', { runId: streaming.runId, turnId: streaming.turnId, sessionId: session.summary.id, reason: 'aborted', message: '已停止',
      messages: SessionManager.displaySegments(streaming) }))
    return true
  }

  /** RPC分派回调横跨input/auth与core启动，不在started里抛错破坏pi的finally。 */
  private async promptRun(session: Session, pi: AgentSession, streaming: StreamingState, text: string): Promise<void> {
    streaming.disposition = undefined
    // dispose会断开AgentSession自己的core监听，但它不能杀掉已进入的input异步准备。
    // 直接订阅公开Agent，仅守住本次第一次启动；先退订再取消，不能误伤settled后的新run。
    const unsubscribe = pi.agent.subscribe((event) => {
      if (event.type !== 'agent_start') return
      unsubscribe()
      if (!this.ownsRun(session, streaming) || streaming.stopRequested) void pi.abort()
    })
    let disposition: StreamingState['disposition']
    try {
      disposition = await pi.prompt(text, { images: streaming.inputDelivered ? undefined : streaming.images, preflightResult: (disposition) => {
        if (!this.ownsRun(session, streaming)) return
        streaming.disposition = disposition
        if (disposition === 'started' && streaming.stopRequested) void pi.abort()
      } }).then(() => streaming.disposition)
    } finally {
      unsubscribe()
    }
    if (!this.ownsRun(session, streaming)) return
    if (disposition === 'handled') {
      // handled没有agent_settled；调用已收敛后才允许补输入/释放本次预约。
      this.saveUnstartedInput(pi, streaming)
      if (this.finishPreparingRun(session, pi, streaming)) return
      session.inspector?.runCompleted({ text: '', thinking: '' })
      await this.finishRun(session, streaming, 'completed', () => this.notify('run.completed', { runId: streaming.runId, turnId: streaming.turnId, sessionId: session.summary.id, messages: SessionManager.displaySegments(streaming) }))
    }
  }

  /**
   * 末条是否为可续写的 length 截断(R6③):纯文本/思考被截且续写预算未尽。
   * **正文非空才续**:正文为空 = 输出预算被
   * 夹到趋零(room 耗尽),续写只会立即再截 —— 实测 20K 窗空回复连烧 11 次
   * 请求毫无产出。此时截断是「真没地方写」,正确出路是压缩腾地(动作条
   * 「立即压缩」),不是续写。agent_settled(抑制终态)与 settleRun(注入
   * 续写)两处同读,消费方扣减。
   */
  private lengthContinuable(agent: Agent, sessionId: string): boolean {
    if ((this.continuationBudget.get(sessionId) ?? 0) <= 0) return false
    const last = agent.state.messages.at(-1)
    return (
      last !== undefined &&
      last.role === 'assistant' &&
      last.stopReason === 'length' &&
      !last.content.some((block) => block.type === 'toolCall') &&
      last.content.some((block) => block.type === 'text' && block.text.trim() !== '')
    )
  }

  /**
   * prompt 落定后的续写链(R6③):pi.prompt resolve = 该轮生命周期全部结束
   * （provider 重试/溢出恢复已在内部消化）；此处只剩 AUTO_CONTINUE —— 可续写
   * 截断 → 注入显式 continue 消息再跑（新 prompt 生命周期），直到 run 以终态
   * （成功 / 失败 / 预算尽后的截断）落定。agent_settled 只在链不再续跑的
   * 那一轮发射终态（见其分支）。
   */
  private async settleRun(session: Session, pi: AgentSession, streaming: StreamingState): Promise<void> {
    const sessionId = session.summary.id
    for (;;) {
      if (streaming.finalization !== undefined) { await streaming.finalization; return }
      // run 级中止不一定改写末条 length 或 errorMessage；终态释放的是本次账本。
      // 捕获实例而非只查 has，避免旧 prompt 收尾时误认随后开始的新 run。
      if (this.streaming.get(sessionId) !== streaming) return
      if (this.finishPreparingRun(session, pi, streaming)) return
      if (streaming.disposition === 'queued') return
      if (!this.lengthContinuable(pi.agent, sessionId)) return
      this.continuationBudget.set(sessionId, (this.continuationBudget.get(sessionId) ?? 0) - 1)
      await this.promptRun(session, pi, streaming, AUTO_CONTINUE_MESSAGE)
    }
  }

  /**
   * 手动续写入口(session.continue,截断动作条「继续生成」):对末条 length
   * 截断注入显式 continue 消息再跑。与自动路同消息同链,预算重新给满
   * (用户点按钮 = 明确要继续);自动路的单 run 已收尾,这里是 UI 眼里的
   * 新一段(run.started + 新 streaming),完成后 run.completed 的 stopReason
   * 非 length 会自然熄掉宿主的截断提示。
   */
  async continueSession(sessionId: string): Promise<{ ok: true; runId?: string; turnId?: string }> {
    const session = this.requireSession(sessionId)
    this.assertWorkspaceAvailable(session)
    if (this.streaming.has(sessionId) || this.compacting.has(sessionId)) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '会话正在回复中，无法续写')
    }
    // 历史可能存在迁移冲突；读取失败须发生在预约之前，不能留下没有终态的运行。
    const previousUser = this.messages(sessionId).findLast(message => message.role === 'user')
    const workspace = this.captureWorkspace(session)
    const previousContext = previousUser?.fileContext
    if (previousContext !== undefined && (previousContext.cwd !== workspace.cwd || JSON.stringify(previousContext.roots) !== JSON.stringify(workspace.roots)))
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '项目目录已变化，请发送新消息开始新的回合')
    const turnId = previousUser?.turnId
    this.continuationBudget.set(sessionId, AUTO_CONTINUE_LIMIT)
    session.summary.updatedAt = Date.now()

    const streaming: StreamingState = {
      workspace,
      runId: crypto.randomUUID(),
      turnId,
      fileReferences: new Map(),
      messageId: `m-${crypto.randomUUID()}`,
      stopRequested: false,
      baseSegments: [],
      input: null,
      inputDelivered: false,
      disposition: undefined,
      segments: [],
      text: '',
      thinking: '',
      tools: []
    }
    this.streaming.set(sessionId, streaming)
    this.notify('run.started', { sessionId, runId: streaming.runId, turnId: streaming.turnId })
    try {
      const pi = await this.ensurePiSession(session)
      if (!this.ownsRun(session, streaming)) return { ok: true, runId: streaming.runId, turnId: streaming.turnId }
      // 显示转录保留压缩影子区，不能只用模型上下文裁剪后的旧回答做替换。
      const source = readPiTranscript(this.transcriptCwd(session), this.hostRoot, sessionId) ?? pi.agent.state.messages
      const projected = toChatMessages(source)
      const userAt = projected.findLastIndex((message) => message.role === 'user')
      streaming.turnId = projected[userAt]?.turnId
      streaming.fileContext = projected[userAt]?.fileContext
      if (streaming.turnId !== undefined) {
        this.outputs.begin(sessionId, streaming.turnId, streaming, true)
        this.changes.begin(sessionId, streaming.turnId, streaming, workspace.roots, true)
      }
      streaming.baseSegments = projected.slice(userAt + 1).filter((message) => message.role === 'assistant')
      if (this.finishPreparingRun(session, pi, streaming)) return { ok: true, runId: streaming.runId, turnId: streaming.turnId }
      const last = pi.agent.state.messages.at(-1)
      if (last === undefined || last.role !== 'assistant' || last.stopReason !== 'length') {
        throw new ProtocolError(RpcErrorCode.InvalidRequest, '末条回复不是输出截断，无需续写')
      }
      if (!last.content.some((block) => block.type === 'text' && block.text.trim() !== '')) {
        throw new ProtocolError(RpcErrorCode.InvalidRequest, '回复为空截断（输出预算已耗尽），续写无意义 —— 请先压缩上下文腾出空间')
      }
      await this.promptRun(session, pi, streaming, AUTO_CONTINUE_MESSAGE)
      await this.settleRun(session, pi, streaming)
    } catch (error) {
      // pi.prompt 前置拒绝（鉴权/压缩窗口竞态等）：run.started 已发，宿主等
      // 终态 —— 清 streaming 补发 run.failed 后把错误照常交给 dispatch 转错
      // 误响应帧（手动动作要双通道显式反馈）
      if (this.streaming.get(sessionId) === streaming) {
        await this.finishRun(session, streaming, 'error', () => this.notify('run.failed', { runId: streaming.runId, turnId: streaming.turnId,
          sessionId,
          reason: 'error',
          message: error instanceof Error ? error.message : String(error),
          ...(streaming.baseSegments.length > 0 && { messages: SessionManager.displaySegments(streaming) })
        }))
      }
      throw error
    }
    return { ok: true, runId: streaming.runId, turnId: streaming.turnId }
  }

  /**
   * 手动压缩入口（session.compact）→ pi AgentSession.compact()。
   * 无可压缩/刚压过以协议错误显式反馈（手动动作要明确结果；pi 的抛错文案
   * "Already compacted" / "Nothing to compact" 映射于此），失败原样上抛。
 * 压缩进度经 compaction_start/end 事件（转译层 → compaction.started/
 * completed）。
   */
  async compactSession(sessionId: string, instructions?: string): Promise<{ tokensBefore: number; tokensAfter: number }> {
    const session = this.requireSession(sessionId)
    this.assertWorkspaceAvailable(session)
    if (this.streaming.has(sessionId) || this.compacting.has(sessionId)) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '会话正在回复中，请等待完成后再压缩')
    }
    const operation = { stopRequested: false }
    this.compacting.set(sessionId, operation)
    try {
      const pi = await this.ensurePiSession(session)
      if (this.sessions.get(sessionId) !== session || this.compacting.get(sessionId) !== operation) {
        throw new ProtocolError(RpcErrorCode.InvalidRequest, '会话已结束，压缩未启动')
      }
      if (operation.stopRequested) throw new ProtocolError(RpcErrorCode.InvalidRequest, '压缩已中止')
      const result = await pi.compact(instructions)
      return {
        tokensBefore: result.tokensBefore,
        // pi 的后置估算缺省（极端：无 usage 锚点）时诚实回落 before 值 ——
        // 协议 tokensAfter 必填，宿主指示器按"未降"呈现
        tokensAfter: result.estimatedTokensAfter ?? result.tokensBefore
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/Already compacted|Nothing to compact/.test(message)) {
        // 映射前的原文留诊断（统一文案对宿主友好，排障要看 pi 的具体守卫）
        process.stderr.write(`[host] 手动压缩被拒（pi 原文）: ${message}\n`)
        throw new ProtocolError(RpcErrorCode.InvalidRequest, '会话无可压缩内容（刚压缩过或近期内容不足保留窗口）')
      }
      throw error
    } finally {
      if (this.compacting.get(sessionId) === operation) this.compacting.delete(sessionId)
    }
  }

  abort(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    const streaming = this.streaming.get(sessionId)
    const compacting = this.compacting.get(sessionId)
    if (session === undefined || (streaming === undefined && compacting === undefined)) return false
    if (this.titleTasks.get(sessionId)?.owner === streaming) this.cancelTitle(sessionId, '用户停止首轮')
    if (streaming !== undefined) { streaming.stopRequested = true; streaming.attachmentPreparation?.abort() }
    if (compacting !== undefined) compacting.stopRequested = true
    // pi.abort 是 async（等 run 收尾）；受理即返回（同步合同）。挂起审批经
    // signal listener 收尾（见 decideApproval），run 必然落地终态
    if (session.pi !== undefined) void session.pi.abort()
    return true
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const id of this.sessions.keys()) {
      this.abort(id)
      this.settleApprovals(id, '引擎退出')
      this.settleInteractions(id)
    }
    const work = [...this.sessions.values()].map(async session => {
      const pi = session.pi ?? await session.piBuilding
      if (pi) await shutdownPiSession(pi)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const drain = async () => {
      const results = await Promise.allSettled(work)
      for (const result of results) if (result.status === 'rejected') process.stderr.write(`[host] 会话退出失败: ${String(result.reason)}\n`)
      await Promise.all([...this.streaming.values()].flatMap(run => run.finalization ? [run.finalization] : []))
      await Promise.allSettled(this.deletionTasks.values())
      await this.outputs.drain()
      await this.changes.drain()
    }
    try {
      await Promise.race([drain(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('会话退出超过 5 秒，强制收尾')), 5_000) })])
    } finally { clearTimeout(timer); this.disposeAll() }
  }

  /** 进程退出前统一收尾（引擎随宿主关闭；pi dispose 内聚 abort 全部运行） */
  disposeAll(): void {
    this.shuttingDown = true
    this.searchService.dispose()
    for (const sessionId of this.titleTasks.keys()) this.cancelTitle(sessionId, '引擎退出')
    this.outputs.dispose()
    this.changes.dispose()
    for (const run of this.streaming.values()) run.attachmentPreparation?.abort()
    for (const session of this.sessions.values()) session.pi?.dispose()
    for (const sessionId of this.sessions.keys()) {
      this.settleApprovals(sessionId, '引擎退出')
      this.settleInteractions(sessionId)
    }
    this.sessions.clear()
    this.streaming.clear()
    this.compacting.clear()
  }

  // ———— 审批（docs/模块/审批与权限.mdD5）————

  /**
   * 宿主裁决回流：resolve 挂起中的审批 Promise（扩
   * message/always）。唔配对 requestId（已裁决过 / abort 已收尾 / 不存在）→
   * InvalidParams —— 双击允许钮、裁决与中止竞态都属于此类，显式报错而非静默成功。
   */
  respondApproval(
    requestId: string,
    approved: boolean,
    message?: string,
    always?: 'workspace',
    switchMode?: 'auto' | 'autonomous'
  ): { ok: true; summary?: SessionSummary } {
    const pending = this.pendingApprovals.get(requestId)
    if (pending === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `审批请求不存在或已被裁决: ${requestId}`)
    }
    const session = this.requireSession(pending.sessionId)
    // 持久裁决绑定请求时的边界。拒绝后保留 pending，宿主仍能裁决本次。
    if (always === 'workspace') {
      const roots = this.workspaceRoots(session)
      if (!pending.withinRoots || pending.ruleRoots.length === 0 ||
          roots.length !== pending.ruleRoots.length || roots.some((root) => !pending.ruleRoots.includes(root))) {
        throw new ProtocolError(RpcErrorCode.InvalidParams, '当前审批只能裁决本次，无法保存工作区规则')
      }
      // 允许本次 + 落工作区级规则（同 roots 集合幂等，见 ApprovalRegistry.add）
      this.approvals.add(pending.ruleRoots, pending.kind)
    }
    // 「允许，并切换为 X」（F6 定稿，zcode 同款）：本次放行 + 会话切模式 +
    // 记为项目默认（同一项目的新会话沿用）。无项目归属的会话只切当前会话
    let summary: SessionSummary | undefined
    if (switchMode !== undefined) {
      summary = this.setPermission(session.summary.id, switchMode)
      // 与 setPermission/setPlanMode 同款北向广播：审批面板切档是引擎侧改档，
      // 不广播则宿主权限钮不联动（session.summaryChanged 的统一语义）
      this.notify('session.summaryChanged', { summary })
      const projectId = this.projectIdOf(session)
      if (projectId !== undefined) this.projects.setDefaultPermissionMode(projectId, switchMode)
    }
    // 拒绝附言（「告诉模型接下来怎么做」）：进 block reason → pi 工具错误结果
    // 给模型。截断上限防打爆工具结果（与截断纪律同源）；加前缀让模型明确
    // 这是拒绝后的用户指示而非工具输出
    const denyReason =
      !approved && message !== undefined && message.trim() !== ''
        ? `用户拒绝了本次操作。用户指示：${message.trim().slice(0, APPROVAL_MESSAGE_MAX_CHARS)}`
        : '用户拒绝了本次操作'
    this.pendingApprovals.delete(requestId)
    pending.resolve(approved ? { block: false } : { block: true, reason: denyReason })
    // 审计对的 decided 半边（钩子座 4d）：与 approval.asked 同 requestId 配对，
    // 三种用户裁决分词（放行也留痕的 zcode 口径）
    this.ensureInspector(session).approvalDecided({
      toolName: pending.toolName,
      requestId,
      verdict: approved ? (always === 'workspace' ? 'always-workspace-user' : 'user-allow') : 'user-deny',
      ...(!approved ? { reason: denyReason } : {})
    })
    return { ok: true, ...(summary !== undefined && { summary }) }
  }

  /**
   * 会话级权限切换（权限模式菜单）：summary 记账 + 落盘；审批判定读活值
   * （decideApproval 每次现读 summary.permissionMode），运行中切换即生效。
   * 提示词层通告由 factory 的 before_agent_start 扩展每轮现读活 mode 设
   * cogent_permission 节 —— 本方法只管记账，不碰提示词。
   */
  setPermission(sessionId: string, mode: PermissionMode): SessionSummary {
    const session = this.requireSession(sessionId)
    const summary = { ...session.summary, permissionMode: mode }
    this.writeSession({ ...session, summary })
    session.summary = summary
    this.notify('session.summaryChanged', { summary })
    return summary
  }

  /**
   * 计划模式开关（正交于权限档）：UI 计划钮/菜单开关项与 enter_plan 工具
   * 共用此路 —— 记账 + 落盘 + 北向广播一次完成。enabled 只翻 planEnabled，
   **不碰 permissionMode**（开关关闭后原档自动恢复，无需回退档）。
   */
  setPlanMode(sessionId: string, enabled: boolean): SessionSummary {
    const session = this.requireSession(sessionId)
    const summary = { ...session.summary }
    if (enabled) summary.planEnabled = true
    else delete summary.planEnabled
    this.writeSession({ ...session, summary })
    session.summary = summary
    this.notify('session.summaryChanged', { summary })
    return summary
  }

  /**
   * 工具调用裁决（链式 beforeToolCall 的桥端，判定矩阵：ToolKind ×
   * permissionMode；zcode 对齐）。边界语义：
   * - **auto / autonomous 完全放行**（含工作区外写 —— 主流的"完全访问/
   *   自主"名副其实：Claude Code bypassPermissions / Codex danger-full-access
   *   同款）；
   * - **plan 拦**写/exec；
   * - **ask**：exec 与**根内**写先查「始终允许」规则（规则 = 根内信任记忆，
   *   永不覆盖越界）；未命中与**越界写**都弹面板 —— 人是最终裁决者；
   * - 越界写弹面板时带 outsideRoots 标记（宿主据此隐藏「始终允许此工作区」）。
   * mode 读 session.summary 活引用（运行中切换即生效）。ask 挂起：async
   * 未返回前工具不执行（pi 官方阻塞语义）；signal abort 兜底 resolve
   * （否则中止后 Promise 永悬、run 永不结束）。
   */
  private async prepareToolChanges(
    session: Session,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<{ block: boolean; reason?: string }> {
    const streaming = this.streaming.get(session.summary.id)
    if (streaming?.turnId === undefined) return { block: false }
    if (signal?.aborted) return { block: true, reason: '已中止' }
    const cwd = streaming.fileContext?.cwd ?? streaming.workspace.cwd
    try {
      await this.changes.beforeTool(session.summary.id, streaming.turnId, streaming, toolName, args, cwd, signal)
      return { block: false }
    } catch (error) {
      if (signal?.aborted) return { block: true, reason: '已中止' }
      process.stderr.write(`[changes] 写前捕获失败（${toolName}）: ${error instanceof Error ? error.message : String(error)}\n`)
      return { block: false }
    }
  }

  private decideApproval(
    session: Session,
    toolName: string,
    callId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<{ block: boolean; reason?: string }> {
    const meta = toolMeta(toolName)
    // 未知名字兜底 read：与事件转译同口径（pi 只执行注册过的工具，未知 =
    // 注册表 bug，stderr 已在转译层留诊断，这里按无害的只读放行）
    const kind = meta?.kind ?? 'read'
    // 审计纪律（钩子座 4d）：read 类不经审批域，零条目；其余每条判定路径
    // 都落 approval.decided（放行也留痕），ask 路径另有 approval.asked 成对
    const audit = this.ensureInspector(session)
    if (kind === 'read') return Promise.resolve({ block: false })
    // 计划开关短路优先于档位放行（zcode permission/service.ts:148 同序）：
    // 「完全访问 + 计划开着」= 只读 —— 开关语义不受档位影响
    if (session.summary.planEnabled === true) {
      audit.approvalDecided({ toolName, verdict: 'plan' })
      return Promise.resolve({ block: true, reason: '计划模式（只读）下写类与执行类工具被禁止' })
    }
    const mode = session.summary.permissionMode ?? 'ask'
    if (mode === 'auto') {
      audit.approvalDecided({ toolName, verdict: 'auto' })
      return this.prepareToolChanges(session, toolName, args, signal)
    }
    // 写类根内判定（软边界瘦身为"规则适用域"）：越界与否不再决定放拦，
    // 只决定 ask 是否可吃「始终允许」规则 —— 信任记忆的范围 = 根内写
    const roots = this.workspaceRoots(session)
    const isFileWrite = kind === 'write' || kind === 'edit'
    const targetRoots = isFileWrite && typeof args.path === 'string'
      ? matchingWriteRoots(args.path, this.captureWorkspace(session).cwd, roots.length > 0 ? roots : [homedir()])
      : []
    const withinRoots = !isFileWrite || targetRoots.length > 0
    // 自主模式（已定稿）：文件写信任放行（不限根内 —— 越界也放，F6 定稿），
    // exec 等风险类照旧走询问（落到下方 ask 流程）
    if (mode === 'autonomous' && (kind === 'write' || kind === 'edit')) {
      audit.approvalDecided({ toolName, verdict: 'autonomous' })
      return this.prepareToolChanges(session, toolName, args, signal)
    }
    // 写类只匹配覆盖本次目标的已授权根，新增根不会沿用旧根的规则。
    if (roots.length > 0 && withinRoots && this.approvals.allows(isFileWrite ? targetRoots : roots, kind)) {
      audit.approvalDecided({ toolName, verdict: 'always-workspace' })
      return this.prepareToolChanges(session, toolName, args, signal)
    }
    // 弹审批面板并挂起（无超时 —— 用户不点就一直等，宿主输入框变停止
    // 钮可 abort；signal abort 兜底 resolve）
    const requestId = `appr-${crypto.randomUUID()}`
    const sessionId = session.summary.id
    const summary = meta !== undefined ? meta.summarize(args) : `${toolName}(?)`
    return new Promise<{ block: boolean; reason?: string }>((resolve) => {
      // 先登记再发事件：respondApproval 走这张表找 resolver，时序上不存在
      // 「事件未到、respond 先行」的窗口（宿主是收到事件才可能裁决）
      this.pendingApprovals.set(requestId, { sessionId, kind, toolName, callId, summary, ruleRoots: roots, withinRoots, resolve })
      audit.approvalAsked({ requestId, toolName, kind, summary, mode, outsideRoots: !withinRoots })
      this.notify('approval.request', {
        sessionId,
        requestId,
        callId,
        toolName,
        kind,
        summary,
        ...(!withinRoots && { outsideRoots: true })
      })
      signal?.addEventListener('abort', () => {
        // 已被 respondApproval 消费则不动（用户裁决与中止竞态，先到先得）
        if (this.pendingApprovals.delete(requestId)) {
          audit.approvalDecided({ toolName, verdict: 'aborted', requestId })
          resolve({ block: true, reason: '已中止' })
        }
      })
    }).then((verdict) => verdict.block ? verdict : this.prepareToolChanges(session, toolName, args, signal))
  }

  /** 某会话的全部挂起审批以 block 收尾（删除/退出兜底；abort 走 signal listener） */
  private settleApprovals(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.sessionId !== sessionId) continue
      this.pendingApprovals.delete(requestId)
      // 兜底收尾也落审计（尽力语义：非抛查找 —— 会话已出表时跳过记录，
      // resolve 必须照常发生，审计不许拦兜底收尾）
      const target = this.sessions.get(sessionId)
      if (target !== undefined) {
        this.ensureInspector(target).approvalDecided({ toolName: pending.toolName, requestId, verdict: 'settled', reason })
      }
      pending.resolve({ block: true, reason })
    }
  }

  // ———— 交互座提问（4c-2，respondApproval 同款骨架） ——

  /**
   * 宿主作答回流：resolve 挂起中的 ask_user Promise。唔配对 requestId
   *（已答过 / abort 已收尾 / 不存在）→ InvalidParams（双击提交、作答与
   * 中止竞态，显式报错防静默成功）。answers 长度不做强校验：缺项按跳过
   * 处理（formatAskResult 的空串分支），宿主少传不炸。
   */
  respondQuestion(requestId: string, answers: AskAnswers): { ok: true } {
    const pending = this.pendingQuestions.get(requestId)
    if (pending === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `提问请求不存在或已被回答: ${requestId}`)
    }
    this.pendingQuestions.delete(requestId)
    pending.resolve({ answers })
    return { ok: true }
  }

  /** 某会话的全部挂起提问以取消收尾（删除/退出兜底；abort 走桥内 signal listener） */
  private settleInteractions(sessionId: string): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.sessionId !== sessionId) continue
      this.pendingQuestions.delete(requestId)
      pending.resolve({ answers: [], cancelled: true })
    }
    // 挂起中的方案审批同批收口（拒绝语义：会话都没了，批准无从谈起）
    for (const [requestId, pending] of this.pendingPlans) {
      if (pending.sessionId !== sessionId) continue
      this.pendingPlans.delete(requestId)
      pending.resolve({ approved: false })
    }
  }

  /**
   * 方案裁决回流（交互座 4c-3）：批准 → 关计划开关（permissionMode 不动，
   * 原档自动恢复）+ StoredSession.plan 落账（cogent_plan 段源，新批准覆盖
   * 旧值）+ 放行工具；拒绝 → 开关保持开（修订重提的语义前提），反馈（可空）
   * 进工具结果。返回批准后的摘要（拒绝时缺省）。
   */
  respondPlan(requestId: string, approved: boolean, message?: string): { ok: true; summary?: SessionSummary } {
    const pending = this.pendingPlans.get(requestId)
    if (pending === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `方案请求不存在或已被裁决: ${requestId}`)
    }
    let summary: SessionSummary | undefined
    if (approved) {
      const session = this.requireSession(pending.sessionId)
      const candidate = { ...session.summary }
      delete candidate.planEnabled
      const plan = { plan: pending.plan, approvedAt: Date.now() }
      this.writeSession({ ...session, summary: candidate, plan })
      session.summary = candidate
      session.plan = plan
      summary = { ...session.summary }
      this.notify('session.summaryChanged', { summary })
    }
    this.pendingPlans.delete(requestId)
    const trimmed = message?.trim()
    pending.resolve(
      approved
        ? { approved: true }
        : { approved: false, ...(trimmed !== undefined && trimmed !== '' && { message: trimmed }) }
    )
    return { ok: true, ...(summary !== undefined && { summary }) }
  }

  /** 标题不占 streaming；任务对象独立存活到主回合之后，所有写回都核对同一 owner。 */
  private startTitle(session: Session, streaming: StreamingState): void {
    const input = streaming.titleInput
    streaming.titleInput = undefined
    if (input === undefined || streaming.stopRequested || session.summary.titleManual === true) return
    const sessionId = session.summary.id
    const model = session.pi!.model as Model<Api> | undefined
    if (model === undefined) {
      process.stderr.write(`[host] 自动标题未启动（${sessionId}）：首条输入没有有效模型\n`)
      return
    }
    const inspector = this.ensureInspector(session)
    const trace = inspector.titleStarted({ provider: model.provider, id: model.id }, input.text,
      [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some((price) => price > 0))
    const task = { controller: new AbortController(), trace, inspector, owner: streaming, response: undefined as AssistantMessage | undefined }
    this.titleTasks.set(sessionId, task)
    // 从这里开始是模型 API/磁盘的辅助任务边界，失败只记录诊断，不翻译为主回合失败。
    void (async () => {
      const title = await generateSessionTitle(this.modelRuntime, structuredClone(model), input.text,
        task.controller.signal, (message) => { task.response = message })
      if (this.titleTasks.get(sessionId) !== task || this.sessions.get(sessionId) !== session || session.summary.titleManual === true) return
      const summary = { ...session.summary, title }
      this.writeSession({ ...session, summary })
      session.summary = summary
      this.notify('session.summaryChanged', { summary: { ...summary } })
      inspector.titleFinished(trace, 'completed', title, task.response)
    })().catch((error: unknown) => {
      if (this.titleTasks.get(sessionId) !== task) return
      const reason = error instanceof Error ? error.message : String(error)
      inspector.titleFinished(trace, 'failed', reason, task.response)
      process.stderr.write(`[host] 自动标题失败（${sessionId}）: ${reason}\n`)
    }).finally(() => { if (this.titleTasks.get(sessionId) === task) this.titleTasks.delete(sessionId) })
  }

  private cancelTitle(sessionId: string, reason: string): void {
    const task = this.titleTasks.get(sessionId)
    if (task === undefined) return
    this.titleTasks.delete(sessionId)
    task.controller.abort(new Error(reason))
    task.inspector.titleFinished(task.trace, 'cancelled', reason, task.response)
  }

  // ———— pi 内核装配（惰性） ————

  /**
   * 惰性装配 pi AgentSession：首次使用（submit/compact/continue）才建并
   * 导入旧转录。恢复的会话若启动即全量装配，会话多了启动就慢、且不使用的
   * 会话白占内存（DefaultResourceLoader 读盘 + 扩展装载 + 会话树投影）。
   * piBuilding 去重：并发首用（双 submit）共享同一次装配 —— 各建一个会话树
   * 会让 pi 的 appendMessage 双写分叉。
   */
  private ensurePiSession(session: Session): Promise<AgentSession> {
    if (session.pi !== undefined) return Promise.resolve(session.pi)
    if (session.piBuilding !== undefined) return session.piBuilding
    const building = this.buildPiSession(session).then(async (pi) => {
      // 装配本身不一定支持取消；删除/退出后归还的实例只能回收，不得挂回旧会话。
      if (this.sessions.get(session.summary.id) !== session) {
        await shutdownPiSession(pi)
        return pi
      }
      session.pi = pi
      session.piBuilding = undefined
      return pi
    })
    session.piBuilding = building
    // 失败后清 in-flight 标记（否则装配失败永久卡死该会话的后续首用）
    building.catch(() => {
      if (session.piBuilding === building) session.piBuilding = undefined
    })
    return building
  }

  private async buildPiSession(session: Session): Promise<AgentSession> {
    const sessionId = session.summary.id
    const workspace = this.captureWorkspace(session)
    const boundRoots = workspace.roots
    // MCP 快照（Pi-meme 快照语义）：pi 内核装配时定格 user+project 合并结果，
    // 之后改配置不影响本会话（新会话生效）。诊断（项目级越权条目等）不拦装配
    // —— 坏条目已在快照里剔除，MCP 是增益面，stderr 留痕即可
    const mcpSnapshot = this.mcpConfig.snapshot(boundRoots[0] ?? homedir())
    if (mcpSnapshot.errors.length > 0) {
      process.stderr.write(`[host] MCP 配置诊断（会话 ${sessionId}）: ${mcpSnapshot.errors.join('；')}\n`)
    }
    // 技能座（4b）：发现诊断装配期留痕一次（此后随 skills.list 回 UI；
    // 清单本身每回合活算 = 热刷新，诊断不拦装配 —— 技能是增益面）
    const skillDiagnostics = this.skillStore.snapshotMany(boundRoots).errors
    if (skillDiagnostics.length > 0) {
      process.stderr.write(`[host] 技能目录诊断（会话 ${sessionId}）: ${skillDiagnostics.join('；')}\n`)
    }
    if (session.legacyTranscript !== undefined) {
      migrateLegacyTranscript(this.transcriptCwd(session), this.hostRoot, sessionId, session.legacyTranscript)
      this.writeSession({ ...session, legacyTranscript: undefined })
      session.legacyTranscript = undefined
    }
    const { session: pi } = await createPiSession({
      // pi 的 cwd = 工作区主根（无绑定时主目录兜底，同 toolRoots 语义）：
      // 项目发现（.gitignore/AGENTS.md）与会话目录编码都锚在它上；
      // 工具集 = pi 内置（tool-meta 的 COGENT_TOOL_NAMES，shell 按平台）
      cwd: workspace.cwd,
      transcriptCwd: this.transcriptCwd(session),
      hostRoot: this.hostRoot,
      sessionId,
      onUserEntry: (entryId, cwd) => {
        // 装配期间导入的是历史条目，当前回合的输入由接管后的 pi 保存。
        if (session.pi === undefined) return undefined
        const run = this.streaming.get(sessionId)
        if (run === undefined || run.input === null || run.fileContext !== undefined) return undefined
        const fileContext: FileContext = { version: 1, turnId: run.turnId!, userEntryId: entryId, cwd, roots: [...run.workspace.roots], platform: process.platform }
        run.fileContext = fileContext
        session.piCwd ??= this.transcriptCwd(session)
        this.persist(sessionId)
        this.startTitle(session, run)
        const input = run.attachmentInput
        if (input === undefined || input.bound) return { fileContext }
        input.bound = true
        return { fileContext, attachment: { version: 1, inputId: input.inputId, text: input.text, attachments: input.attachments,
          ...(input.directories !== undefined && { directories: input.directories }) } }
      },
      onFileReferences: (callId, refs) => { this.streaming.get(sessionId)?.fileReferences.set(callId, refs) },
      modelRuntime: this.modelRuntime,
      systemPrompt: this.ensureSystemPrompt(session),
      // 自定义段每回合活算（factory 的 before_agent_start 钩子消费）：权限
      // 通告读活 mode（运行中切档下一轮生效）；skills/todos/plan 快照无缓存
      //（UI 改动与手动改文件都下一回合生效 = 回合边界热刷新）
      sections: (sessionAssetsSection) =>
        buildDynamicSections({
          permissionMode: session.summary.permissionMode ?? 'ask',
          planEnabled: session.summary.planEnabled === true,
          skillsSection: formatSkillsSection(this.skillStore.snapshotMany(boundRoots).skills),
          todosSection: todosSectionText(session.todos),
          planSection: session.plan !== undefined ? planSectionText(session.plan) : null,
          sessionAssetsSection
        }),
      onSystemPromptRendered: (rendered) => {
        session.inspector?.systemPromptRendered(rendered)
      },
      // 交互座（4c）：todo_write 落笔 → 会话状态 + 持久化 + 北向事件；
      // ask_user 挂起 → question.asked → respond/abort/settle 三路收尾；
      // plan 闭环 → enter_plan 开关 + submit_plan 挂起审批（plan.respond）
      customTools: [
        createReportOutputsTool((callId, declarations, cwd, signal) => {
          const run = this.streaming.get(sessionId)!
          const context = run.fileContext!
          return this.outputs.stage(sessionId, { ...context, cwd }, run, callId, declarations, signal)
        }),
        createReadAttachmentTool({ service: this.attachments, sessionId, hostRoot: this.hostRoot,
          bindings: new AttachmentConfig(this.hostRoot).media(), mcp: mcpSnapshot }),
        createTodoTool({
          updateTodos: (todos) => {
            session.todos = todos
            this.persist(sessionId)
            this.notify('todos.updated', { sessionId, todos })
          }
        }),
        createAskTool({
          ask: (questions: AskQuestion[], signal) =>
            new Promise<{ answers: AskAnswers; cancelled?: boolean }>((resolve) => {
              const requestId = `ask-${crypto.randomUUID()}`
              this.pendingQuestions.set(requestId, { sessionId, questions, resolve })
              this.notify('question.asked', {
                sessionId,
                requestId,
                questions: questions.map((q) => ({
                  question: q.question,
                  ...(q.header !== undefined && q.header !== '' && { header: q.header }),
                  options: q.options.map((o) => ({ label: o.label, ...(o.description !== undefined && o.description !== '' && { description: o.description }) })),
                  ...(q.multiSelect === true && { multiSelect: true })
                }))
              })
              signal?.addEventListener('abort', () => {
                // 已被 respondQuestion 消费则不动（作答与中止竞态，先到先得）
                if (this.pendingQuestions.delete(requestId)) {
                  resolve({ answers: [], cancelled: true })
                }
              })
            })
        }),
        createEnterPlanTool({
          enterPlan: () => {
            // 幂等：已开着照走 setPlanMode（记账 + 持久化 + 广播同一路，无副作用差异）
            this.setPlanMode(sessionId, true)
          }
        }),
        createSubmitPlanTool(
          {
            submitPlan: (plan, signal) =>
              new Promise<{ approved: true } | { approved: false; message?: string }>((resolve) => {
                const requestId = `plan-${crypto.randomUUID()}`
                this.pendingPlans.set(requestId, { sessionId, plan, resolve })
                this.notify('plan.requested', { sessionId, requestId, plan })
                signal?.addEventListener('abort', () => {
                  // 已被 respondPlan 消费则不动（裁决与中止竞态，先到先得）
                  if (this.pendingPlans.delete(requestId)) {
                    resolve({ approved: false })
                  }
                })
              })
          },
          // 活开关读引用（未开启时 submit_plan 拒绝的判定源；运行中切换即时生效）
          () => session.summary.planEnabled === true
        )
      ],
      settleOutput: async (callId, successful) => {
        const doc = await this.outputs.settle(sessionId, callId, successful)
        return doc === undefined ? undefined : outputReceipt(doc)
      },
      outputReminder: () => {
        const run = this.streaming.get(sessionId)
        return run?.turnId === undefined ? Promise.resolve(undefined) : this.outputs.reminder(sessionId, run.turnId)
      },
      approval: {
        decide: (toolName, toolCallId, args, signal) =>
          this.decideApproval(session, toolName, toolCallId, args, signal)
      },
      onMessageCommitted: (message, sourceId) => {
        if (session.pi === undefined) return
        this.messageSources.set(message, sourceId)
        // 续写指令和纯工具/思考消息没有正文节点，不能覆盖上一条可见消息的来源。
        if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(AUTO_CONTINUE_PREFIX)) return
        if (message.role === 'assistant' && !message.content.some((block) => block.type === 'text' && block.text !== '')) return
        const run = this.streaming.get(sessionId)
        if (run?.turnId !== undefined && (message.role === 'user' || message.role === 'assistant')) {
          this.notify('message.source', { sessionId, turnId: run.turnId, role: message.role, sourceId })
        }
      },
      onEvent: (event) => this.translateEvent(session, event),
      observe: (agent) => this.attachInspector(agent, session),
      // MCP 座（4a）：server 日志落 pi 域（与 fd/rg 同目录族），写回通道见 store
      mcp: {
        snapshot: mcpSnapshot,
        logPath: join(this.hostRoot, PI_AGENT_DIR_NAME, 'mcp.log'),
        updateConfig: (entry, patch) => this.mcpConfig.applyPatch(entry, patch)
      }
    })

    // 删除/退出会使等待装配的owner失效，旧转录也不能在这里被重新导入；
    // ensurePiSession的唯一接收点会dispose此实例。
    if (this.sessions.get(sessionId) !== session) return pi

    return pi
  }

  /**
   * 观测三钩挂载（factory 的 observe 回调）：**链式包裹**而非直赋 —— sdk.ts
   * 构造 Agent 时已占用三钩做扩展事件桥（before_provider_request 等），
   * 直赋会拆掉 pi 的接线。请求原钩子变换后检查额度，再记录实际载荷；透传返回值（onPayload
   * 契约 = 返回 undefined 保留原载荷 / 变换后载荷）。
   */
  private attachInspector(agent: Agent, session: Session): void {
    const inspector = (): SessionInspector => this.ensureInspector(session)
    const prevPayload = agent.onPayload
    agent.onPayload = async (payload, model) => {
      const transformed = await prevPayload?.(payload, model)
      const effective = transformed === undefined ? payload : transformed
      assertAttachmentRequest(effective, model)
      inspector().apiRequest(effective, model)
      return transformed
    }
    const prevResponse = agent.onResponse
    agent.onResponse = (response, model) => {
      inspector().apiResponse(response)
      return prevResponse?.(response, model)
    }
    const prevStream = agent.onProviderStreamEvent
    agent.onProviderStreamEvent = (data, model) => {
      inspector().apiStreamChunk(data)
      return prevStream?.(data, model)
    }
  }

  // ———— 内部 ————

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new ProtocolError(RpcErrorCode.InternalError, `会话不存在: ${sessionId}`)
    return session
  }

  /**
   * 会话域落盘（summary 变更点调用）：v2 文档只含 summary —— 转录真源在 pi
   * JSONL（pi 自己逐条追加），本层不碰。尽力语义：失败只记诊断不抛 ——
   * 调用点多在受理/收尾路径上，抛出去等于让存储故障炸掉一次成功回合；
   * summary 仍在内存，下次变更点重写补上。准备期中止输入另经pi公开转录API保存，
   * 不混入此会话域文档。
   */
  private persist(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      this.writeSession(session)
    } catch (error) {
      process.stderr.write(`[host] 会话落盘失败（${sessionId}，下次变更重试）: ${(error as Error).message}\n`)
    }
  }

  /** 共用文档形状；显式保存操作直接调用，回合内的尽力落盘由 persist 翻译失败。 */
  private writeSession(session: Session, deleted = false): void {
    const doc: StoredSession = {
      ...(deleted && { deleted: true }),
      // 惰性导入前元数据操作不能擦掉 v1 唯一转录；真正导入 pi 后才写 v2。
      version: session.legacyTranscript === undefined ? SESSION_FILE_VERSION : 1,
      ...(session.legacyTranscript !== undefined && { transcript: session.legacyTranscript }),
      summary: session.summary,
      ...(session.autoTitle !== undefined && { autoTitle: session.autoTitle }),
      ...(session.piCwd !== undefined && { piCwd: session.piCwd }),
      // 空清单不落字段（旧文档形状不变；清单事件本身就是"清空"的真相源）
      ...(session.todos.length > 0 && { todos: session.todos }),
      ...(session.plan !== undefined && { plan: session.plan })
    }
    this.storage.put(SESSION_COLLECTION, session.summary.id, doc as unknown as Record<string, unknown>)
  }

  /**
   * 相邻纯文本段合并：auto-continue 的 length 段 + 续写段 →
   * 单段（正文无缝拼接、思考拼接、工具卡拼接、用量/耗时相加）。无相邻对
   * 返回原数组引用（热路径零拷贝）。相邻判定只看"段是否带工具卡"—— 带
   * 工具卡的段不并（截断只发生在纯文本/思考尾部，工具段与后续段的交错是
   * 正常形态）。
   */
  private static mergeContinuedSegments(segments: ChatMessage[]): ChatMessage[] {
    let merged: ChatMessage[] | undefined
    for (let i = 0; i < segments.length; i++) {
      // i=0 无前段;其后取"已并结果末位 ?? 原数组前一位"(尚未发生合并时两者同源)
      const prev: ChatMessage | undefined = i > 0 ? (merged?.at(-1) ?? segments[i - 1]) : undefined
      const cur = segments[i]
      const adjacent =
        prev !== undefined &&
        prev.role === 'assistant' &&
        cur.role === 'assistant' &&
        (prev.toolCalls ?? []).length === 0 &&
        (cur.toolCalls ?? []).length === 0
      if (!adjacent) {
        ;(merged ??= [...segments.slice(0, i)]).push(cur)
        continue
      }
      if (merged === undefined) merged = segments.slice(0, i)
      const offset = prev.content.length
      if (cur.sources !== undefined) prev.sources = [...(prev.sources ?? []), ...cur.sources.map((source) => ({ ...source, start: source.start + offset, end: source.end + offset }))]
      prev.content += cur.content
      if (cur.thinking) prev.thinking = (prev.thinking ?? '') + cur.thinking
      // 相邻门保证双方都无工具卡,这里只并正文/思考/账目
      if (cur.usage !== undefined) prev.usage = accumulateUsage(prev.usage, cur.usage)
      prev.durationMs = sumOptional(prev.durationMs, cur.durationMs)
      prev.model = cur.model
    }
    return merged ?? segments
  }

  /**
   * pi 事件 → 协议事件的单向转译（onEvent 闭包按会话直连，无实例查表）。
   * 事件面 = AgentSessionEvent：核心 AgentEvent（message_update、turn_*、
   * tool_execution_* 等）同源直转；会话层事件里 agent_settled（终态）与
   * compaction_start/end（压缩）有协议对应，其余（queue_update、auto_retry_*、
   * session_info_changed 等）暂无协议消费面，落 default（需要时再扩展协议）。
   */
  private translateEvent(session: Session, event: AgentSessionEvent): void {
    const sessionId = session.summary.id
    if (this.sessions.get(sessionId) !== session) return

    switch (event.type) {
      case 'message_end': {
        const streaming = this.streaming.get(sessionId)
        if (streaming !== undefined && event.message.role === 'user') streaming.inputDelivered = true
        return
      }
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
        session.inspector?.turnStarted()
        return
      }
      case 'turn_end': {
        // 记录停止原因与用量：length = 输出被 token 上限截断；usage/durationMs/
        // model 同样只在 turn_end 的 message 上到达 —— 终态（agent_settled）只剩
        // 聚合态转录，此处不摘即永久丢失（协议事件不回头）
        if (event.message.role === 'assistant') {
          const streaming = this.streaming.get(sessionId)
          if (streaming) {
            streaming.stopReason = event.message.stopReason
            streaming.usage = accumulateUsage(streaming.usage, projectUsage(event.message.usage))
            streaming.durationMs = sumOptional(streaming.durationMs, event.message.durationMs)
            streaming.model = event.message.model
            // 段封存：本轮 text/thinking + 本轮工具调用 → 一段
            // ChatMessage（段内 usage 是本轮自己的，非全 run 累计 —— 分段后
            // 每段的统计行各自成立）。三缓冲全空的轮不落段（pi 每轮至少有
            // text 或 toolCall 之一，此分支实际只挡极端 provider 怪癖）。
            // 段时间戳取 event.message.timestamp：pi 的
            // assistant timestamp = 请求打开时刻，与历史回查路径（树里的同一
            // 消息）完全一致 —— 气泡 HH:MM / 时长起点重启前后不漂移（不取
            // 轮结束墙钟：那样流式期与重载后能差出整个回合时长）
            if (streaming.text !== '' || streaming.thinking !== '' || streaming.tools.length > 0) {
              streaming.segments.push({
                // id 带 run 级前缀：段序号只在 run 内唯一，同会话多 run 会撞
                // （宿主把段直接铺进消息列表作 React key）
                id: `${streaming.messageId}-${streaming.segments.length}`,
                role: 'assistant',
                turnId: streaming.turnId,
                fileContext: streaming.fileContext,
                content: streaming.text,
                sources: this.messageSources.has(event.message) ? [{ id: this.messageSources.get(event.message)!, start: 0, end: streaming.text.length }] : undefined,
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
            // 轮终实报落地：工具循环每轮 turn_end 发一份本轮
            // usage —— 上下文指示器 run 内实时跟随（此前只随 run.completed
            // 落账，多轮工具的 run 全程冻结在 run 前的值，中途触发的压缩
            // 看起来"远未到线"）。终态后 segments 内 usage 为准
            this.notify('context.updated', { sessionId, usage: projectUsage(event.message.usage) })
          }
          // 观测快照取 turn_end 终态消息（usage/stopReason/diagnostics 齐全）
          session.inspector?.turnCompleted(event.message)
        }
        return
      }
      case 'tool_execution_start': {
        session.inspector?.toolStarted(event.toolName, event.args)
        const streaming = this.streaming.get(sessionId)
        if (!streaming) return
        // kind/摘要取静态元数据表（与 buildTools 同源；不依赖会话工具实例 ——
        // 事件路径上两者必然一致，表查询天然覆盖历史工具名）
        const meta = toolMeta(event.toolName)
        if (meta === undefined) {
          // pi 只执行注册过的工具，未知名字 = 引擎注册表与循环不一致的 bug：
          // 事件流不炸、stderr 留诊断、呈现按只读兜底（fail-visible，不静默）
          process.stderr.write(`[host] 未注册的工具名出现在执行事件: ${event.toolName}\n`)
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
      case 'tool_execution_update': {
        // 工具流式进度（当前消费者 = bash 的 OutputAccumulator 快照，100ms 节流
        // 已在工具内做了，这里只透传）。快照语义（整段替换非增量），UI 直接渲染；
        // 文本取尾部 2000 字符 —— 比 resultSummary 的 200 字符宽（bash 直播窗
        // 要看得见量），又比accumulator 全量快照窄（100ms 一帧不搬 50KB）
        const streaming = this.streaming.get(sessionId)
        if (!streaming) return
        const text = tailToolResult(event.partialResult)
        if (text === '') return
        this.notify('tool.progress', {
          sessionId,
          callId: event.toolCallId,
          text
        })
        return
      }
      case 'tool_execution_end': {
        session.inspector?.toolCompleted(
          event.toolName,
          event.result,
          event.isError,
          event.durationMs
        )
        const streaming = this.streaming.get(sessionId)
        if (!streaming) return
        if (!event.isError && (event.toolName === 'write' || event.toolName === 'edit') && streaming.turnId !== undefined) this.outputs.wrote(sessionId, streaming.turnId)
        const summary = summarizeToolResult(event.result)
        const diff = extractResultDiff(event.result)
        const record = streaming.tools.find((t) => t.callId === event.toolCallId)
        const fileRefs = [...streaming.fileReferences].filter(([id]) => id === event.toolCallId || id.startsWith(event.toolCallId + '/')).flatMap(([, refs]) => refs)
        if (record !== undefined) {
          if (fileRefs.length > 0) record.fileRefs = fileRefs
          record.status = event.isError ? 'error' : 'ok'
          record.resultSummary = summary
          if (diff !== undefined) record.diff = diff
          // 区间终点（与 startedAt 同为引擎打点；历史回查路径另从 toolResult
          // 消息重建，两条来源同一形状）
          record.endedAt = Date.now()
        }
        this.notify('tool.completed', {
          sessionId,
          callId: event.toolCallId,
          isError: event.isError,
          summary,
          ...(fileRefs.length > 0 && { fileRefs }),
          diff
        })
        return
      }
      case 'compaction_start': {
        // pi 压缩启动（manual = session.compact；threshold/overflow = pi 自动路，
        // 后者发生在 run 生命周期内，宿主据此可呈"压缩中"状态）
        const operation = this.compacting.get(sessionId)
        if (event.reason === 'manual' && operation?.stopRequested === true) session.pi?.abortCompaction()
        this.notify('compaction.started', { sessionId, reason: event.reason })
        return
      }
      case 'compaction_end': {
        if (event.errorMessage !== undefined) {
          this.notify('compaction.completed', {
            sessionId,
            reason: event.reason,
            error: event.errorMessage
          })
          return
        }
        if (event.result === undefined) {
          // 类型面允许（pi 溢出恢复二次失败时 result 缺省 + errorMessage 已带，
          // 走不到这）；aborted 单独到此 —— 诚实报因
          this.notify('compaction.completed', {
            sessionId,
            reason: event.reason,
            error: event.aborted ? '压缩已中止' : '压缩未产生结果'
          })
          return
        }
        const result = event.result
        // summarizedUntil = 保留区首条的时间戳（宿主据此把该时刻及之前的
        // 消息原位换折叠条）：从 pi 会话树按 firstKeptEntryId 反查
        const firstKept = session.pi?.sessionManager.getEntry(result.firstKeptEntryId)
        const summarizedUntil =
          firstKept !== undefined ? new Date(firstKept.timestamp).getTime() : undefined
        this.notify('compaction.completed', {
          sessionId,
          reason: event.reason,
          tokensBefore: result.tokensBefore,
          ...(result.estimatedTokensAfter !== undefined && { tokensAfter: result.estimatedTokensAfter }),
          summary: result.summary,
          ...(summarizedUntil !== undefined && { summarizedUntil }),
          // 摘要请求自身的账：不走 run 分段、不进回合统计 —— 宿主折叠
          // 条小字呈现；端点未报 usage 时缺省
          ...(result.usage !== undefined && { summaryUsage: projectUsage(result.usage) })
        })
        return
      }
      case 'agent_settled': {
        // 终态（每轮 prompt 生命周期恰一次，晚于全部内聚恢复/重试 —— 见类头
        // "终态纪律"）。正/负路径都在此收口
        const streaming = this.streaming.get(sessionId)
        if (streaming === undefined) return
        session.summary.updatedAt = Date.now()

        // aborted 属于整个 run；收口钩子期间中止时，最后回答仍可成功且没有 errorMessage。
        // 停止事实取公开终态字段，不能从一条消息或界面的停止按钮反推。
        const pi = session.pi
        const errorMessage = pi?.agent.state.errorMessage
        if (event.aborted || errorMessage) {
          const reason = event.aborted ? 'aborted' : 'error'
          const message = errorMessage ?? '已停止'
          session.inspector?.runFailed(message)
          // aborted/error 也会经过 turn_end，已封存段包含被打断那轮的正文与 usage。
          // Host 给完整快照，宿主不可再补一份流式占位；相邻纯文本段按完成路径合并。
          if (streaming.usage && pi !== undefined) {
            const estimate = estimateContext(pi.agent.state.messages, pi.systemPrompt, pi.agent.state.tools)
            streaming.usage.contextEstimate = estimate
            const lastSegment = streaming.segments.at(-1)
            if (lastSegment?.usage) lastSegment.usage.contextEstimate = { ...estimate }
          }
          void this.finishRun(session, streaming, reason === 'aborted' ? 'aborted' : 'error', () => this.notify('run.failed', { runId: streaming.runId, turnId: streaming.turnId, sessionId, reason, message, messages: SessionManager.displaySegments(streaming) }))
          return
        }
        // length 截断可续写：抑制终态、streaming 保活 ——
        // settleRun 注入显式 continue 消息接着跑;预算尽或续写完成时由下一轮
        // agent_settled 正常收尾。抑制意味着本轮转录不重写盘:续写中途崩溃
        // 丢当前段（pi JSONL 已逐条落盘的除外），与"尽力落盘"语义一致可接受
        if (!streaming.stopRequested && session.pi !== undefined && this.lengthContinuable(session.pi.agent, sessionId)) return

        // 上下文明细估算挂到本回合 usage 上（turn_end 逐轮累加的 usage 已聚合；
        // 明细只描述"此刻转录长什么样"，与轮次无关，算一次即可）。挂 usage 而非
        // 单独字段：renderer 旧数据无此字段自然降级（additive，见
        // MessageUsage.contextEstimate）。聚合与末段各挂一份 —— 指示器分子读的是
        // "末条带 usage 的消息"（分段终态下 = 末段），聚合份供兼容形态与观测
        // 快照，两处是独立对象不共享。盘上转录（pi 树）不带明细 —— 历史回查
        // 路径在 messages() 按需现算，两条路各自出同源数据（estimateContext
        // 纯转录函数，见其注释）
        if (streaming.usage) {
          // system 段：piSession.systemPrompt = 当前完整渲染（自拼 + pi
          // 追加节），与请求组装同源；与历史回查路径（messages()）同表达式
          const estimate = estimateContext(
            session.pi?.agent.state.messages ?? [],
            session.pi?.systemPrompt ?? this.ensureSystemPrompt(session),
            session.pi?.agent.state.tools
          )
          streaming.usage.contextEstimate = estimate
          const lastSegment = streaming.segments.at(-1)
          if (lastSegment?.usage) lastSegment.usage.contextEstimate = { ...estimate }
        }

        // 观测快照吃结构类型（顶层 text/thinking）—— 段化后顶层缓冲已清空，
        // 传各段聚合值（口径 = 拼接后总字符）
        session.inspector?.runCompleted({
          text: streaming.segments.map((s) => s.content).join(''),
          thinking: streaming.segments.map((s) => s.thinking ?? '').join(''),
          usage: streaming.usage,
          durationMs: streaming.durationMs,
          model: streaming.model,
          stopReason: streaming.stopReason
        })
        // 相邻纯文本段合并（续写的呈现形态）：length 段 + 续写段
        // → 单段。run 内相邻纯文本段只可能来自续写注入（无工具的轮会终结
        // run，带工具的 length 轮段里必带工具卡），合并无歧义；正文无缝拼接
        // （续写指令就是"从截断处接着写"），用量/耗时相加 = 计费真相
        const segments = SessionManager.displaySegments(streaming)
        const displayUsage = segments.reduce<MessageUsage | undefined>((usage, segment) =>
          segment.usage !== undefined ? accumulateUsage(usage, segment.usage) : usage, undefined)
        const displayDuration = segments.reduce<number | undefined>((duration, segment) => sumOptional(duration, segment.durationMs), undefined)
        void this.finishRun(session, streaming, 'completed', () => this.notify('run.completed', { runId: streaming.runId, turnId: streaming.turnId,
          sessionId,
          // 分段终态（优先消费）：text 段与工具段按发生序 —— 交错保真的代价是
          // 一 run 多条消息，宿主用它整体替换流式占位（含流式期插入的工具卡）
          messages: segments.length > 0 ? segments : undefined,
          // 聚合兼容形态（老宿主只读 message）：全段拼接。思考/正文任一非空
          // 都落消息（只有思考没有正文的极端截断也可见）；usage 三件套是
          // turn_end 的逐轮累计（计费口径，见 accumulateUsage）
          message:
            segments.some((s) => s.content || s.thinking)
              ? {
                  id: streaming.messageId,
                  role: 'assistant',
                  content: segments.map((s) => s.content).filter((c) => c !== '').join('\n\n'),
                  thinking: segments.some((s) => s.thinking)
                    ? segments.map((s) => s.thinking ?? '').join('\n\n')
                    : undefined,
                  toolCalls: segments.some((s) => (s.toolCalls ?? []).length > 0)
                    ? segments.flatMap((s) => s.toolCalls ?? [])
                    : undefined,
                  usage: displayUsage,
                  durationMs: displayDuration,
                  model: streaming.model,
                  timestamp: Date.now()
                }
              : undefined,
          stopReason: streaming.stopReason
        }))
        return
      }
      // agent_start、message_start/end、agent_end（pi 版带 willRetry，终态已归
      // agent_settled）、queue_update、auto_retry_*、session_info_changed 等：
      // 协议暂无对应事件，转译为空（需要时再扩展协议）
      default:
        return
    }
  }

}
