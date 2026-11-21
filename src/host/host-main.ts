/**
 * Host —— 独立 Node 进程入口，Cogent 的"引擎"。
 *
 * 为什么是独立进程（全局架构 D1，决策见 docs/架构.md）：
 * - pi 要求 Node >= 22.19，Host 优先使用自带官方 Node 22（resources/runtime），
 *   引擎运行时与 Electron 发版周期分离；
 * - 工具执行（shell / 文件写入）需要崩溃隔离：Host 挂了不拖垮壳；
 * - abort 可以硬杀到进程级；Electron 不在也能跑（headless，远程模式的地基）。
 *
 * 纪律（目录即边界）：
 * - 只允许依赖 pi-* 与 ../protocol，禁止 import Electron / renderer 代码；
 * - 无头运行：stdin 进请求，stdout 出响应/事件，stderr 只出诊断日志；
 * - 它不知道"窗口"的存在，任何 Node 宿主都能拉起它。
 *
 * 防御边界（本项目防御政策的示范位）：不可信输入 = stdin 帧 + HTTP 门
 * 请求体（阶段 2a 起），校验只发生在 handleFrame 入口（JSON 解析 +
 * isRpcRequest + 参数显式收窄），两个传输门共用同一守卫与注册表（D2：
 * 注册表单一，门只管帧进帧出）；handler 内部信任协议类型，不做二次防御。
 *
 * 启动期（async main）：ModelRuntime.create 是异步（目录装载），pi AgentSession
 * 的请求路由/鉴权都挂在它上 —— 必须先建再装配会话运行时，main() 收拢全部
 * 启动序列，拒绝顶层零散 await。
 */
import { validateSearchQuery } from './runtime/search/validation'

import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { validateTitleSettings } from './runtime/session-title-config'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  ProtocolError,
  RpcErrorCode,
  isRpcEvent,
  isRpcRequest,
  toRpcError,
  type ApprovalRespondParams,
  type CapabilityIssueParams,
  type PlanRespondParams,
  type QuestionRespondParams,
  type CredentialsListResult,
  type SessionArchiveParams,
  type CredentialsSetParams,
  type CustomProviderDef,
  type InitializeParams,
  type InitializeResult,
  type McpExposure,
  type McpOverrideParams,
  type McpServerDef,
  type McpSyncParams,
  type McpSyncResult,
  type SkillListResult,
  type SkillReadResult,
  type SkillSaveParams,
  type SkillScope,
  type SkillSetEnabledParams,
  type SkillWriteResult,
  type PermissionMode,
  type ProtocolEvents,
  type ProviderOverrideDef,
  type ProvidersCustomSyncParams,
  type ProvidersCustomSyncResult,
  type RpcEvent,
  type RpcResponse,
  type SessionCompactParams,
  SessionContinueParams,
  type SessionMessagesParams,
  type SessionSetPermissionParams,
  type SessionSetPlanModeParams,
  type SessionSetPinnedParams,
  type SessionRenameParams,
  type ThinkingLevelWithOff
} from '../protocol'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { CredentialRegistry } from './runtime/credentials'
import { SessionManager } from './runtime/session'
import { ProjectRegistry } from './runtime/project'
import { ApprovalRegistry } from './runtime/approvals'
import { McpConfigStore } from './runtime/mcp-config'
import { SkillStore } from './runtime/skill-store'
import { InspectStore, JsonStorageDriver } from './storage'
import { startHttpRpc } from './http/server'
import { createCapabilityStore, createRootSecret } from './http/auth'
import { AttachmentConfig, attachmentHandlers } from './runtime/attachment-config'
import { FileService } from './runtime/files/reader'
import { outputHandlers } from './runtime/outputs/handlers'
import { fileHandlers } from './runtime/files/handlers'
import { prepareDirectoryReferences } from './runtime/directory-references'

/**
 * 存储根：第一方数据唯一根（决策 D1，docs/模块/工作区与项目.md）。
 * COGENT_HOME 覆盖口供冒烟测试指临时目录（同 COGENT_NODE_BIN 手法）；
 * 第 2 步把 main 侧凭据 store 也迁到同根（引擎是纯 Node，自算 home 零 Electron）。
 * PI_CODING_AGENT_DIR 的归位不在这 —— 那行赋值在 pi 加载之后才执行、对
 * tools-manager 的 TOOLS_DIR 冻结无效，已上移到入口 index.ts（wrapper）。
 */
const STORAGE_ROOT = process.env.COGENT_HOME || join(homedir(), '.cogent')

/**
 * 生态兼容根（~/.agents）：zcode 等工具装技能的中立目录，技能座只读发现
 * （写路径仍走 .cogent，见 skill-store 头注释）。集成测试经 HOME 覆写
 * （harness 把 USERPROFILE/HOME 指进临时根）自动隔离，无需独立覆盖口。
 */
const AGENTS_ROOT = join(homedir(), '.agents')

// 方言模块预热：pi-ai 的 API 方言是**首次请求时**才动态 import（lazyApi），
// 冷启动会拉起整个厂商 SDK，首次文件访问可占数秒；文件打开慢已由探针确认，
// 但不能仅凭等待就断言是 Defender 扫描。预热复用同一模块缓存，降低首句延迟。
// 首次握手响应后后台预加载 Cogent 支持的全部三个方言 ——
// 与懒加载命中同一模块缓存（exports 子路径与 lazy 相对 import 解析到同一
// 文件 URL），首请求直接热。预热失败不炸启动（allSettled + 不 await）：
// 退回懒加载语义，不比没预热差。
function prewarmProviderApis(): void {
  void Promise.allSettled([
    import('@earendil-works/pi-ai/api/anthropic-messages'),
    import('@earendil-works/pi-ai/api/openai-completions'),
    import('@earendil-works/pi-ai/api/openai-responses')
  ])
}

async function main(): Promise<void> {
  // 只记录阶段与进程启动后的累计耗时，凭据、请求参数和会话内容不进启动日志。
  const startup = (stage: string): void => {
    process.stderr.write(`[startup] +${Math.round(process.uptime() * 1000)}ms ${stage}\n`)
  }
  startup('初始化模型运行时')
  // pi 运行时（模型目录 + 鉴权 + 请求路由）：底层配**空 CredentialStore** ——
  // Cogent 的 key 真源是壳侧 safeStorage（经 initialize/credentials.set 进
  // 引擎内存表），绝不让 pi 读写 ~/.pi 的 auth.json（探针实证的内存方案：
  // 空 store + setRuntimeApiKey overlay）
  const emptyCredentialStore = {
    read: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    modify: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(undefined),
    settled: () => Promise.resolve(undefined)
  }
  const modelRuntime = await ModelRuntime.create({ credentials: emptyCredentialStore })
  startup('恢复本地存储与会话')

  /** 引擎单例：凭据表 + 本地 JSON 存储 + 项目注册表 + 会话运行时（构造即恢复盘上数据） */
  const credentials = new CredentialRegistry()
  const storage = new JsonStorageDriver(STORAGE_ROOT)
  // 观测记录落盘（~/.cogent/inspect/*.jsonl，重启回看；构造无 I/O，惰性到会话首用）
  const inspectStore = new InspectStore(STORAGE_ROOT)
  // 装配顺序：projects/approvals 先建（无依赖），sessions 后建（构造即拿到引用；
  // SessionManager 对它们的使用只发生在 submit/respond 期，无构造期回查）
  const projects = new ProjectRegistry(storage)
  // 审批规则表（~/.cogent/approvals.json 单文件，构造即恢复；「始终允许此工作区」）
  const approvals = new ApprovalRegistry(STORAGE_ROOT)
  // MCP 客户端配置（~/.cogent/mcp.json 用户级定义 + 项目级 override 合并，阶段 4a）
  const mcpConfig = new McpConfigStore(STORAGE_ROOT)
  // 技能目录（~/.cogent/skills 用户级 + <cwd>/.cogent/skills 项目级 + 两级启停，阶段 4b）
  const skillStore = new SkillStore(STORAGE_ROOT, AGENTS_ROOT)
  const sessions = new SessionManager(
    credentials,
    storage,
    (method, params) => notify(method, params),
    projects,
    approvals,
    mcpConfig,
    skillStore,
    inspectStore,
    modelRuntime,
    STORAGE_ROOT
  )
  const files = new FileService((sessionId, turnId) => sessions.fileContext(sessionId, turnId))
  startup('装配请求路由')

  /**
   * 凭据 → pi 运行时联动（内存 overlay 单向同步）：凭据表的每次变更同步
   * setRuntimeApiKey/removeRuntimeApiKey —— pi prompt 前的 hasConfiguredAuth
   * 与请求路由的 auth 解析都读 runtime（内置与 custom/* 一视同仁）。
   * await 应用：credentials.set 响应回宿主前 key 已生效，宿主紧接着的
   * submit 不与之竞态
   */
  const applyRuntimeKey = async (providerId: string, apiKey?: string): Promise<void> => {
    if (apiKey !== undefined) await modelRuntime.setRuntimeApiKey(providerId, apiKey)
    else await modelRuntime.removeRuntimeApiKey(providerId)
  }

  /** 事件发送：service → 宿主（stdio notification 帧）+ WS 消费者（2c 起双写） */
  function notify<E extends keyof ProtocolEvents>(method: E, params: ProtocolEvents[E]): void {
    const frame: RpcEvent = { jsonrpc: '2.0', method, params }
    process.stdout.write(JSON.stringify(frame) + '\n')
    broadcastEvent?.(frame)
  }

  /** 响应发送 */
  function reply(response: RpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n')
  }

  // HTTP 门票据 store（D3）：一次性短 TTL，消费即焚 —— 与 rootSecret 同属
  // Host 进程内存态，重启全失效（token 生命周期 = Host 进程生命周期）
  const capabilityStore = createCapabilityStore()

  // HTTP 门实际端口（开门后回填；handleInitialize 闭包读到它时必已赋值 ——
  // HTTP 启动的 await 在主循环注册前完成，而 initialize 帧只能来自主循环）
  let httpPort: number | undefined
  // WS 事件广播器（2c）：开门后回填。事件帧出口从 stdio 单出口变双出口
  //（stdout → main 不变 + WS → 在线消费者），同一帧同一时刻双写
  let broadcastEvent: ((frame: RpcEvent) => void) | null = null

  /**
   * 握手：宿主确认链路可用，服务上报运行时信息（宿主据此做 Node 版本守卫）。
   */
  async function handleInitialize(params: unknown): Promise<InitializeResult> {
    startup('收到 initialize，校验并同步凭据')
    // 信任边界：params 是外部输入，在此做唯一一次显式校验。
    const p = params as Partial<InitializeParams>
    if (typeof p.client !== 'string' || typeof p.protocolVersion !== 'number') {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        'initialize 需要 { client: string, protocolVersion: number }'
      )
    }
    // optional 凭据注入：宿主持久化的 key 灌进引擎内存表（老宿主可不带）。
    // 同步 runtime overlay 后再回握手响应 —— 全部 key 已在 pi 运行时生效
    if (p.credentials) {
      credentials.loadAll(p.credentials)
      await Promise.all(
        Object.entries(p.credentials).map(([providerId, c]) => applyRuntimeKey(providerId, c.apiKey))
      )
    }
    startup('initialize 完成')
    // 先让当前响应的 Promise 续段写出握手帧，再启动预热；否则同步模块加载
    // 会占住同一事件循环，把可选厂商 SDK 的冷加载算进必要的启动等待。
    setImmediate(prewarmProviderApis)
    return {
      service: 'cogent-agent',
      protocolVersion: PROTOCOL_VERSION,
      node: process.version,
      // HTTP 门开着才带（装配序保证：HTTP 启动 await 完成先于主循环收帧）
      ...(httpPort !== undefined ? { httpPort } : {})
    }
  }

  /** credentials.set 入口校验：providerId/apiKey 均为非空 string */
  async function handleCredentialsSet(params: unknown): Promise<{ ok: true }> {
    const p = params as Partial<CredentialsSetParams>
    if (typeof p.providerId !== 'string' || p.providerId.length === 0 || typeof p.apiKey !== 'string') {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        'credentials.set 需要 { providerId: string, apiKey: string }'
      )
    }
    credentials.set(p.providerId, p.apiKey)
    await applyRuntimeKey(p.providerId, p.apiKey)
    return { ok: true }
  }

  /** credentials.remove 入口校验：providerId 非空 string */
  async function handleCredentialsRemove(params: unknown): Promise<{ ok: true }> {
    const p = params as Partial<{ providerId: unknown }>
    if (typeof p.providerId !== 'string' || p.providerId.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'credentials.remove 需要 { providerId: string }')
    }
    credentials.delete(p.providerId)
    await applyRuntimeKey(p.providerId, undefined)
    return { ok: true }
  }

  /** credentials.list：provider 摘要（keyConfigured 布尔位，key 明文不出引擎） */
  function handleCredentialsList(): CredentialsListResult {
    return { providers: credentials.summaries() }
  }

  /** 测试入口只接身份；密钥、地址与方言均由 Host 当前配置解析，不接前端请求覆盖。 */
  function handleModelsTest(params: unknown) {
    const p = params as Partial<{ providerId: unknown; modelId: unknown }> | null | undefined
    if (typeof p?.providerId !== 'string' || p.providerId.trim().length === 0 ||
        typeof p.modelId !== 'string' || p.modelId.trim().length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'models.test 需要 { providerId: 非空 string, modelId: 非空 string }')
    }
    return sessions.testModel(p.providerId, p.modelId)
  }

  /** 会话检索与现有 HostApi 同门校验，不给 renderer 文件系统入口。 */
  function handleSessionSearch(params: unknown) {
    validateSearchQuery(params)
    return sessions.search(params)
  }

  /** session.messages 入口校验：sessionId 非空 string */
  function handleSessionMessages(params: unknown) {
    const p = params as Partial<SessionMessagesParams>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.messages 需要 { sessionId: string }')
    }
    const todos = sessions.todos(p.sessionId)
    return {
      messages: sessions.messages(p.sessionId),
      // 交互座 4c：TodoStrip 打开会话的种子数据（运行中增量走 todos.updated 事件）
      ...(todos.length > 0 && { todos })
    }
  }

  /** session.setPinned 入口校验：sessionId 非空 string + pinned 布尔 */
  function handleSessionSetPinned(params: unknown) {
    const p = params as Partial<SessionSetPinnedParams>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.pinned !== 'boolean') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.setPinned 需要 { sessionId: string, pinned: boolean }')
    }
    return { summary: sessions.setPinned(p.sessionId, p.pinned) }
  }

  /** 标题来自外部请求，在统一入口校验并归一，运行时只消费合法单行标题。 */
  function handleSessionRename(params: unknown) {
    const p = params as Partial<SessionRenameParams>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 ||
        typeof p.title !== 'string' || p.title.trim().length === 0 || /[\r\n]/.test(p.title)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.rename 需要 { sessionId: string, title: 非空单行 string }')
    }
    return { summary: sessions.rename(p.sessionId, p.title.trim()) }
  }

  /** session.archive 入口校验 */
  function handleSessionArchive(params: unknown) {
    const p = params as Partial<SessionArchiveParams>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.archived !== 'boolean') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.archive 需要 { sessionId: string, archived: boolean }')
    }
    return { summary: sessions.archive(p.sessionId, p.archived) }
  }

  /** PermissionMode 值域守卫（入口校验共用）：stdio 载荷是任意 JSON，类型声明
      不构成运行时保证，typeof 检查是真实防御（约定.md 1.1 stdio 帧边界） */
  function isPermissionMode(value: unknown): value is PermissionMode {
    return value === 'auto' || value === 'ask' || value === 'autonomous'
  }

  /** session.create 入口校验：optional 字段带了就必须合法（permissionMode 限值域）。
      逐字段独立守卫（不用 || 复合）—— TS 的控制流分析只在独立 if 里窄化类型 */
  function handleSessionCreate(params: unknown) {
    const p = params as Partial<{ title: unknown; cwd: unknown; projectId: unknown; permissionMode: unknown; planEnabled: unknown }>
    if (p.title !== undefined && typeof p.title !== 'string') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.create 的 title 必须是 string')
    }
    if (p.cwd !== undefined && (typeof p.cwd !== 'string' || p.cwd.length === 0)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.create 的 cwd 必须是非空 string')
    }
    if (p.projectId !== undefined && (typeof p.projectId !== 'string' || p.projectId.length === 0)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.create 的 projectId 必须是非空 string')
    }
    if (p.permissionMode !== undefined && !isPermissionMode(p.permissionMode)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.create 的 permissionMode 必须是 auto|ask|autonomous 之一')
    }
    if (p.planEnabled !== undefined && typeof p.planEnabled !== 'boolean') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.create 的 planEnabled 必须是 boolean')
    }
    return sessions.create({
      title: p.title,
      cwd: p.cwd,
      projectId: p.projectId,
      permissionMode: p.permissionMode,
      planEnabled: p.planEnabled
    })
  }

  /** session.delete 入口校验：sessionId 非空 string */
  function handleSessionDelete(params: unknown) {
    const p = params as Partial<{ sessionId: unknown }>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.delete 需要 { sessionId: string }')
    }
    const deleted = sessions.delete(p.sessionId)
    files.releaseSession(p.sessionId)
    return { deleted }
  }

  /** project.delete 入口校验：projectId 非空 string */
  function handleProjectDelete(params: unknown) {
    const p = params as Partial<{ projectId: unknown }>
    if (typeof p.projectId !== 'string' || p.projectId.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'project.delete 需要 { projectId: string }')
    }
    return { deleted: projects.delete(p.projectId) }
  }

  /** project.setPinned 入口校验：projectId 非空 string + pinned 布尔。
      pinned 不校验会被 if(pinned) 当 false 静默取消置顶 —— 兜底掩盖非法状态（约定.md 1.2-6） */
  function handleProjectSetPinned(params: unknown) {
    const p = params as Partial<{ projectId: unknown; pinned: unknown }>
    if (typeof p.projectId !== 'string' || p.projectId.length === 0 || typeof p.pinned !== 'boolean') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'project.setPinned 需要 { projectId: string, pinned: boolean }')
    }
    return { summary: projects.setPinned(p.projectId, p.pinned) }
  }

  /** agent.submit 入口校验：sessionId 必填，正文/附件至少一项；其余字段带了就约束值域。
      optional 字段逐个独立守卫（TS 控制流只在独立 if 中窄化，复合 || 不窄化）。
      thinkingLevel 值域与协议 ThinkingLevelWithOff 对齐（satisfies 钉住，防白名单与
      枚举漂移）——'off' 是 pi 原生档（关闭思考），漏收它会把滑杆默认档拒之门外 */
  function handleAgentSubmit(params: unknown) {
    const p = params as Partial<{ sessionId: unknown; text: unknown; model: unknown; provider: unknown; thinkingLevel: unknown; attachmentIds: unknown; inputId: unknown; directories: unknown }>
    const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevelWithOff[]
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.text !== 'string') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'agent.submit 需要 { sessionId: string, text: string }')
    }
    if (p.model !== undefined && typeof p.model !== 'string') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'agent.submit 的 model 必须是 string')
    }
    if (p.provider !== undefined && typeof p.provider !== 'string') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'agent.submit 的 provider 必须是 string')
    }
    if (p.thinkingLevel !== undefined && typeof p.thinkingLevel !== 'string') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'agent.submit 的 thinkingLevel 必须是 string')
    }
    if (p.thinkingLevel !== undefined && !(THINKING_LEVELS as readonly string[]).includes(p.thinkingLevel)) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        `agent.submit 的 thinkingLevel 必须是 ${THINKING_LEVELS.join('|')} 之一`
      )
    }
    // 受理后 LLM 循环在 submit 内部异步执行，进度走事件流。这里不能拿掉同步调用
    // 改成 fire-and-forget 的 promise：异步拒绝会绕过 dispatch 的 try/catch 崩掉引擎
    if (p.attachmentIds !== undefined && (!Array.isArray(p.attachmentIds) ||
      !p.attachmentIds.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)))) throw new Error('attachmentIds 不合法')
    if (p.inputId !== undefined && (typeof p.inputId !== 'string' || p.inputId.length > 100)) throw new Error('inputId 不合法')
    const directories = p.directories === undefined ? [] : prepareDirectoryReferences(p.directories)
    if (p.text.trim().length === 0 && (p.attachmentIds === undefined || p.attachmentIds.length === 0) && directories.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, '正文和附件不能同时为空')
    }
    sessions.submit(p.sessionId, p.text, p.model, p.thinkingLevel, p.provider, p.attachmentIds, p.inputId, directories)
    return { accepted: true as const }
  }

  /** approval.respond 入口校验：requestId 非空 string + approved 布尔；optional
      的 message/always/switchMode 带了就约束形状，且 always/switchMode（允许+
      升级语义）与 approved=false 同发是矛盾载荷直接拒绝。唔配对 requestId 在
      SessionManager 抛 InvalidParams —— 双击允许钮、裁决与中止竞态都属此类，
      显式报错而非静默成功 */
  function handleApprovalRespond(params: unknown) {
    const p = params as Partial<ApprovalRespondParams>
    if (typeof p.requestId !== 'string' || p.requestId.length === 0 || typeof p.approved !== 'boolean') {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        'approval.respond 需要 { requestId: string, approved: boolean }'
      )
    }
    if (p.message !== undefined && typeof p.message !== 'string') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'approval.respond 的 message 必须是 string')
    }
    if (p.always !== undefined && !(['workspace'] as readonly string[]).includes(p.always)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, "approval.respond 的 always 只支持 'workspace'")
    }
    if (p.always !== undefined && !p.approved) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'always（始终允许）只能伴随 approved=true')
    }
    if (p.switchMode !== undefined && !(['auto', 'autonomous'] as readonly string[]).includes(p.switchMode)) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        "approval.respond 的 switchMode 只支持 'auto' | 'autonomous'"
      )
    }
    if (p.switchMode !== undefined && !p.approved) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'switchMode（允许并切换为）只能伴随 approved=true')
    }
    return sessions.respondApproval(p.requestId, p.approved, p.message, p.always, p.switchMode)
  }

  /** question.respond 入口校验（交互座 4c-2）：requestId 非空 + answers 数组
      （元素 string 或 string[]；逐项收窄——外部输入是信任边界，风格同上） */
  function handleQuestionRespond(params: unknown) {
    const p = params as Partial<QuestionRespondParams>
    if (typeof p.requestId !== 'string' || p.requestId.length === 0 || !Array.isArray(p.answers)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'question.respond 需要 { requestId: string, answers: (string|string[])[] }')
    }
    for (const answer of p.answers) {
      const ok = typeof answer === 'string' || (Array.isArray(answer) && answer.every((a) => typeof a === 'string'))
      if (!ok) {
        throw new ProtocolError(RpcErrorCode.InvalidParams, 'question.respond 的 answers 元素必须是 string 或 string[]')
      }
    }
    return sessions.respondQuestion(p.requestId, p.answers)
  }

  /** plan.respond 入口校验（交互座 4c-3）：requestId 非空 + approved 布尔 +
      optional message string */
  function handlePlanRespond(params: unknown) {
    const p = params as Partial<PlanRespondParams>
    if (typeof p.requestId !== 'string' || p.requestId.length === 0 || typeof p.approved !== 'boolean') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'plan.respond 需要 { requestId: string, approved: boolean }')
    }
    if (p.message !== undefined && typeof p.message !== 'string') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'plan.respond 的 message 必须是 string')
    }
    return sessions.respondPlan(p.requestId, p.approved, p.message)
  }

  /** session.setPermission 入口校验：sessionId 非空 string + mode 限值域。
      mode 不校验会被静默存脏值（约定.md 1.2-6：兜底掩盖非法状态） */
  function handleSessionSetPermission(params: unknown) {
    const p = params as Partial<SessionSetPermissionParams>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || !isPermissionMode(p.mode)) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        'session.setPermission 需要 { sessionId: string, mode: auto|ask|autonomous }'
      )
    }
    return { summary: sessions.setPermission(p.sessionId, p.mode) }
  }

  /** session.setPlanMode 入口校验（计划开关，正交于权限档）：sessionId 非空
      string + enabled 布尔 */
  function handleSessionSetPlanMode(params: unknown) {
    const p = params as Partial<SessionSetPlanModeParams>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.enabled !== 'boolean') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.setPlanMode 需要 { sessionId: string, enabled: boolean }')
    }
    return { summary: sessions.setPlanMode(p.sessionId, p.enabled) }
  }

  /** session.compact 入口校验：sessionId 非空 string（手动压缩，D7）。
      异步 handler —— dispatch 对 handler 结果 await，Promise 拒绝转错误帧 */
  function handleSessionCompact(params: unknown) {
    const p = params as Partial<SessionCompactParams>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.compact 需要 { sessionId: string }')
    }
    return sessions.compactSession(p.sessionId)
  }

  /** session.continue 入口校验：sessionId 非空 string（手动续写）。
      异步 handler —— 与 compact 同形，dispatch 对结果 await，拒绝转错误帧 */
  function handleSessionContinue(params: unknown) {
    const p = params as Partial<SessionContinueParams>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.continue 需要 { sessionId: string }')
    }
    return sessions.continueSession(p.sessionId)
  }

  /** inspect.entries 入口校验：sessionId 非空 string */
  function handleInspectEntries(params: unknown) {
    const p = params as Partial<{ sessionId: unknown }>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'inspect.entries 需要 { sessionId: string }')
    }
    return { entries: sessions.inspectEntries(p.sessionId) }
  }

  /** inspect.entry 入口校验：sessionId 非空 string + seq 整数 */
  function handleInspectEntry(params: unknown) {
    const p = params as Partial<{ sessionId: unknown; seq: unknown }>
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.seq !== 'number' || !Number.isInteger(p.seq)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'inspect.entry 需要 { sessionId: string, seq: number }')
    }
    return sessions.inspectDetail(p.sessionId, p.seq)
  }

  /** project.create 入口校验：name 非空 + cwds ≥1 个非空 string（首个 = 主根；
      目录存在性在提交前由宿主目录框/信任确认保证，引擎不复核磁盘 ——
      语义上存的是绑定声明，submit 时才复查） */
  function handleProjectCreate(params: unknown) {
    const p = params as Partial<{ name: unknown; cwds: unknown }>
    if (typeof p.name !== 'string' || p.name.trim().length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'project.create 需要 { name: string, cwds: string[] }')
    }
    if (
      !Array.isArray(p.cwds) ||
      p.cwds.length === 0 ||
      !p.cwds.every((c) => typeof c === 'string' && c.length > 0)
    ) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'project.create 需要至少一个工作区目录（cwds: string[]）')
    }
    const cwds = p.cwds as string[]
    return { summary: projects.create(p.name, cwds) }
  }

  /** project.rename 入口校验 */
  function handleProjectRename(params: unknown) {
    const p = params as Partial<{ projectId: unknown; name: unknown }>
    if (typeof p.projectId !== 'string' || p.projectId.length === 0 || typeof p.name !== 'string' || p.name.trim().length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'project.rename 需要 { projectId: string, name: string }')
    }
    return { summary: projects.rename(p.projectId, p.name) }
  }

  /** project.update 入口校验（编辑弹窗：改名 + 目录增删一次提交）：name/cwds
      口径与 create 完全一致（name 非空 + cwds ≥1 个非空 string，全量替换语义） */
  function handleProjectUpdate(params: unknown) {
    const p = params as Partial<{ projectId: unknown; name: unknown; cwds: unknown }>
    if (
      typeof p.projectId !== 'string' ||
      p.projectId.length === 0 ||
      typeof p.name !== 'string' ||
      p.name.trim().length === 0
    ) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'project.update 需要 { projectId: string, name: string, cwds: string[] }')
    }
    if (
      !Array.isArray(p.cwds) ||
      p.cwds.length === 0 ||
      !p.cwds.every((c) => typeof c === 'string' && c.length > 0)
    ) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'project.update 需要至少一个工作区目录（cwds: string[]）')
    }
    return { summary: projects.update(p.projectId, p.name, p.cwds as string[]) }
  }

  /** providers.custom.sync 入口校验：两数组存在、每项字段形状收窄（id 带 custom/ 前缀的交由 registry 处理）。
      载荷实为外部任意 JSON，协议类型只是声明 —— 按 unknown 收窄，不依赖标注类型 */
  function handleProvidersCustomSync(params: unknown): ProvidersCustomSyncResult {
    const p = params as Partial<ProvidersCustomSyncParams>
    const defs = p.providers
    const overrides = p.overrides
    const API_FORMATS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
    // ModelDef 按 unknown 逐字段收窄（id 必填非空；其余 optional 限值域）
    const isModelDef = (value: unknown): boolean => {
      if (typeof value !== 'object' || value === null) return false
      const m = value as Record<string, unknown>
      if (typeof m.id !== 'string' || m.id.length === 0) return false
      if (m.name !== undefined && typeof m.name !== 'string') return false
      if (m.contextWindow !== undefined && typeof m.contextWindow !== 'number') return false
      if (m.maxTokens !== undefined && typeof m.maxTokens !== 'number') return false
      if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') return false
      if (m.input !== undefined) {
        if (!Array.isArray(m.input) || !m.input.every((v) => v === 'text' || v === 'image')) return false
      }
      return true
    }
    const isDef = (def: CustomProviderDef): boolean =>
      typeof def.id === 'string' &&
      def.id.startsWith('custom/') &&
      typeof def.name === 'string' &&
      typeof def.baseUrl === 'string' &&
      Array.isArray(def.models) &&
      def.models.every((m) => typeof m === 'string' && m.length > 0) &&
      // 四个 optional 开关/过滤字段：缺省合法，带了就约束值域
      (def.modelDefs === undefined || (Array.isArray(def.modelDefs) && def.modelDefs.every(isModelDef))) &&
      (def.apiFormat === undefined || (API_FORMATS as readonly string[]).includes(def.apiFormat)) &&
      (def.disabledModels === undefined ||
        (Array.isArray(def.disabledModels) &&
          def.disabledModels.every((m) => typeof m === 'string' && m.length > 0))) &&
      (def.disabled === undefined || typeof def.disabled === 'boolean')
    if (!Array.isArray(defs) || !defs.every(isDef)) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        'providers.custom.sync 需要 providers: CustomProviderDef[]（id 以 custom/ 开头）'
      )
    }
    // baseUrl 空串合法 = 不覆盖端点、只做模型调整
    const isOverride = (o: ProviderOverrideDef): boolean =>
      typeof o.providerId === 'string' &&
      typeof o.baseUrl === 'string' &&
      (o.models === undefined || (Array.isArray(o.models) && o.models.every(isModelDef))) &&
      (o.disabledModels === undefined ||
        (Array.isArray(o.disabledModels) &&
          o.disabledModels.every((m) => typeof m === 'string' && m.length > 0)))
    if (!Array.isArray(overrides) || !overrides.every(isOverride)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'providers.custom.sync 需要 overrides: ProviderOverrideDef[]')
    }
    return { synced: sessions.syncCustomProviders(defs, overrides) }
  }

  /** mcp.sync 入口校验：每项按 stdio/http 判别联合逐字段收窄（stdio 帧载荷是
      外部 JSON，协议类型只是声明）。名字字符规则/命名空间撞名在 store 的
      pi-mcp 校验器里跑（单一权威，边界只管形状）。 */
  function handleMcpSync(params: unknown): McpSyncResult {
    const p = params as Partial<McpSyncParams>
    const EXPOSURES = ['direct', 'deferred', 'codemode', 'hidden'] as const satisfies readonly McpExposure[]
    const isStringRecord = (value: unknown): value is Record<string, string> =>
      typeof value === 'object' && value !== null && !Array.isArray(value) &&
      Object.values(value).every((s) => typeof s === 'string')
    const isDef = (d: unknown): d is McpServerDef => {
      if (typeof d !== 'object' || d === null) return false
      const m = d as Record<string, unknown>
      if (typeof m.name !== 'string' || m.name.length === 0) return false
      // 判别字段先收窄，两类各自必填一组（command / url）
      if (m.type === 'stdio') {
        if (typeof m.command !== 'string' || m.command.length === 0) return false
      } else if (m.type === 'http') {
        if (typeof m.url !== 'string' || m.url.length === 0) return false
      } else {
        return false
      }
      if (m.args !== undefined && (!Array.isArray(m.args) || !m.args.every((a) => typeof a === 'string'))) return false
      if (m.env !== undefined && !isStringRecord(m.env)) return false
      if (m.cwd !== undefined && typeof m.cwd !== 'string') return false
      if (m.headers !== undefined && !isStringRecord(m.headers)) return false
      if (m.description !== undefined && typeof m.description !== 'string') return false
      if (m.enabled !== undefined && typeof m.enabled !== 'boolean') return false
      if (m.exposure !== undefined && (typeof m.exposure !== 'string' || !(EXPOSURES as readonly string[]).includes(m.exposure))) {
        return false
      }
      if (m.timeout !== undefined && (typeof m.timeout !== 'number' || !Number.isFinite(m.timeout) || m.timeout <= 0)) {
        return false
      }
      return true
    }
    if (!Array.isArray(p.servers) || !p.servers.every(isDef)) {
      throw new ProtocolError(
        RpcErrorCode.InvalidParams,
        'mcp.sync 需要 servers: McpServerDef[]（stdio 需 command、http 需 url；字段值域见协议）'
      )
    }
    return { synced: mcpConfig.sync(p.servers) }
  }

  /** mcp.list 入口校验：cwd 可选（带 = 项目合并视图，须非空 string） */
  function handleMcpList(params: unknown) {
    const p = params as Partial<{ cwd: unknown }>
    if (p.cwd !== undefined && (typeof p.cwd !== 'string' || p.cwd.length === 0)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'mcp.list 的 cwd 必须是非空 string')
    }
    return mcpConfig.list(p.cwd)
  }

  /** mcp.override 入口校验：cwd/name 必填非空；enabled/exposure 带了就约束值域
      （全量替换语义：都不带 = 清除该项 override） */
  function handleMcpOverride(params: unknown) {
    const p = params as Partial<McpOverrideParams>
    if (typeof p.cwd !== 'string' || p.cwd.length === 0 || typeof p.name !== 'string' || p.name.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'mcp.override 需要 { cwd: string, name: string }')
    }
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'mcp.override 的 enabled 必须是 boolean')
    }
    const EXPOSURES = ['direct', 'deferred', 'codemode', 'hidden'] as const satisfies readonly McpExposure[]
    if (
      p.exposure !== undefined &&
      (typeof p.exposure !== 'string' || !(EXPOSURES as readonly string[]).includes(p.exposure))
    ) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'mcp.override 的 exposure 必须是 direct|deferred|codemode|hidden 之一')
    }
    mcpConfig.override(p.cwd, p.name, {
      ...(p.enabled !== undefined && { enabled: p.enabled }),
      ...(p.exposure !== undefined && { exposure: p.exposure })
    })
    return { ok: true as const }
  }

  /** skills.* 入口校验（共用）：scope 判别 + cwd（project 档必填）+ name 非空。
      名字字符规则在 store 的 pi 同款校验里跑（单一权威，边界只管形状）。 */
  function skillTarget(params: unknown): { scope: SkillScope; cwd: string | undefined; name: string } {
    const p = params as Partial<SkillSaveParams>
    if (p.scope !== 'user' && p.scope !== 'project') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'skills.* 需要 scope: user|project')
    }
    if (p.cwd !== undefined && (typeof p.cwd !== 'string' || p.cwd.length === 0)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'skills.* 的 cwd 必须是非空 string')
    }
    if (typeof p.name !== 'string' || p.name.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'skills.* 需要 name: string')
    }
    return { scope: p.scope, cwd: p.cwd, name: p.name }
  }

  function handleSkillsSave(params: unknown): SkillWriteResult {
    const p = params as Partial<SkillSaveParams>
    const target = skillTarget(params)
    if (typeof p.description !== 'string' || p.description.length === 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'skills.save 需要 description: string')
    }
    if (typeof p.body !== 'string') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'skills.save 需要 body: string（可为空串）')
    }
    skillStore.save(target.scope, target.cwd, target.name, p.description, p.body)
    return { ok: true as const }
  }

  function handleSkillsList(params: unknown): SkillListResult {
    const p = params as Partial<{ cwd: unknown }>
    if (p.cwd !== undefined && (typeof p.cwd !== 'string' || p.cwd.length === 0)) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'skills.list 的 cwd 必须是非空 string')
    }
    return skillStore.list(p.cwd)
  }

  function handleSkillsDelete(params: unknown): SkillWriteResult {
    const target = skillTarget(params)
    skillStore.delete(target.scope, target.cwd, target.name)
    return { ok: true as const }
  }

  function handleSkillsRead(params: unknown): SkillReadResult {
    const target = skillTarget(params)
    return skillStore.read(target.scope, target.cwd, target.name)
  }

  function handleSkillsSetEnabled(params: unknown): SkillWriteResult {
    const p = params as Partial<SkillSetEnabledParams>
    const target = skillTarget(params)
    if (p.value !== 'enabled' && p.value !== 'disabled' && p.value !== 'inherit') {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'skills.setEnabled 需要 value: enabled|disabled|inherit')
    }
    skillStore.setEnabled(target.scope, target.cwd, target.name, p.value)
    return { ok: true as const }
  }

  /**
   * 方法注册表：method 名 → handler。
   * handler 内部信任协议类型（边界校验已在入口完成），业务异常直接 throw，
   * 由 dispatch 统一转成错误帧 —— 不要在 handler 里自行 try/catch。
   */
  const handlers = new Map<string, (params: unknown) => unknown>([
    ...fileHandlers(files),
    ...outputHandlers(sessions.outputs, files, (sessionId) => { sessions.fileContext(sessionId) }),
    ...attachmentHandlers(sessions.attachments, new AttachmentConfig(STORAGE_ROOT)),
    ['initialize', handleInitialize],
    ['session.list', () => sessions.list()],
    ['session.search', handleSessionSearch],
    ['session.search.rebuild', () => sessions.searchService.rebuild()],
    ['session.create', handleSessionCreate],
    ['session.delete', handleSessionDelete],
    ['session.messages', handleSessionMessages],
    ['session.setPinned', handleSessionSetPinned],
    ['session.rename', handleSessionRename],
    ['session.titleSettings.get', () => sessions.titleSettings.get()],
    ['session.titleSettings.set', (params) => {
      try { validateTitleSettings(params) }
      catch (error) { throw new ProtocolError(RpcErrorCode.InvalidParams, error instanceof Error ? error.message : String(error)) }
      return sessions.titleSettings.set(params)
    }],
    ['session.archive', handleSessionArchive],
    ['session.listArchived', () => sessions.listArchived()],
    ['session.setPermission', handleSessionSetPermission],
    ['session.setPlanMode', handleSessionSetPlanMode],
    ['session.compact', handleSessionCompact],
    ['session.continue', handleSessionContinue],
    ['project.list', () => projects.list()],
    ['project.create', handleProjectCreate],
    ['project.rename', handleProjectRename],
    ['project.update', handleProjectUpdate],
    ['project.delete', handleProjectDelete],
    ['project.setPinned', handleProjectSetPinned],
    ['agent.submit', handleAgentSubmit],
    ['agent.abort', (params) => ({ aborted: sessions.abort((params as { sessionId: string }).sessionId) })],
    // 宿主侧裁决通道：不经 renderer 通用代理（D3），main 的 approval:respond 专属
    // IPC 直抵这里 —— 但协议上是普通 method（任何宿主都能驱动，无传输层特权）
    ['approval.respond', handleApprovalRespond],
    ['question.respond', handleQuestionRespond],
    ['plan.respond', handlePlanRespond],
    ['credentials.set', handleCredentialsSet],
    ['credentials.remove', handleCredentialsRemove],
    ['credentials.list', handleCredentialsList],
    ['models.list', () => sessions.listModels()],
    ['models.test', handleModelsTest],
    ['providers.custom.sync', handleProvidersCustomSync],
    // MCP 座（4a + 作用域管理）：摘要/诊断只读（带 cwd = 项目合并视图）；
    // 全量写 user 级定义；项目级 override 全量替换（空 = 清除回落）
    ['mcp.list', handleMcpList],
    ['mcp.sync', handleMcpSync],
    ['mcp.override', handleMcpOverride],
    // 技能座（4b）：摘要/诊断/正文只读（带 cwd = 两级合并视图）；写路径三条
    //（save 写 SKILL.md / delete 删目录 / setEnabled 写两级状态文件）
    ['skills.list', handleSkillsList],
    ['skills.read', handleSkillsRead],
    ['skills.save', handleSkillsSave],
    ['skills.delete', handleSkillsDelete],
    ['skills.setEnabled', handleSkillsSetEnabled],
    ['inspect.entries', handleInspectEntries],
    ['inspect.entry', handleInspectEntry],
    // 票据签发（D3）：main 经 stdio 发起（血缘全权）；HTTP 门侧由档位表
    // 限 admin（server.ts METHOD_MIN_SCOPE），防低档 token 自签提权
    [
      'capability.issue',
      (params) => {
        // 信任边界：params 是外部输入，在此做唯一一次显式校验
        const scope = (params as Partial<CapabilityIssueParams>).scope
        if (scope !== 'readonly' && scope !== 'write' && scope !== 'admin') {
          throw new ProtocolError(
            RpcErrorCode.InvalidParams,
            'capability.issue 需要 { scope: readonly | write | admin }'
          )
        }
        return capabilityStore.issue(scope)
      }
    ]
  ])

  /**
   * 单帧处理：请求 → 响应帧；事件/畸形帧返回 null（由调用方决定丢弃方式：
   * stdio 丢弃 + 已记诊断日志，HTTP 门转 400）。两个传输门共用这一入口，
   * 保证守卫与分发路径唯一（D2 注册表单一）。
   */
  async function handleFrame(raw: string): Promise<RpcResponse | null> {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      // 信任边界：对端发来的不是合法 JSON（旧版本客户端 / 实现错误）
      return { jsonrpc: '2.0', id: null, error: { code: RpcErrorCode.ParseError, message: 'invalid JSON frame' } }
    }

    if (isRpcEvent(frame)) {
      // 当前协议里 宿主→服务 方向只有请求；收到事件帧说明对方实现越界。
      process.stderr.write(`[host] dropped unexpected event frame: ${frame.method}\n`)
      return null
    }
    if (!isRpcRequest(frame)) {
      process.stderr.write(`[host] dropped malformed frame: ${raw.slice(0, 120)}\n`)
      return null
    }

    const handler = handlers.get(frame.method)
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: RpcErrorCode.MethodNotFound, message: `unknown method: ${frame.method}` }
      }
    }

    try {
      return { jsonrpc: '2.0', id: frame.id, result: await handler(frame.params ?? {}) }
    } catch (error) {
      return { jsonrpc: '2.0', id: frame.id, error: toRpcError(error) }
    }
  }

  // ———— HTTP 门（2a 骨架 + 2b 鉴权 + 2c WS/远程模式）：同一注册表 ————
  // 默认不开（D2：loopback 且按需），开门即要 token。rootSecret 启动新生成、
  // 不出进程。实际监听地址打到 stderr（冒烟脚本与 main 双通道之一）。
  if (process.env.COGENT_HTTP_RPC === '1') {
    startup('启动 HTTP 监听')
    const portEnv = process.env.COGENT_HTTP_PORT
    const port = portEnv === undefined ? 0 : Number(portEnv)
    // env 是外部输入，入口处显式校验（畸形值拒启好过 serve 内部报晦涩错）
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`COGENT_HTTP_PORT 非法: ${portEnv}`)
    }
    // 远程模式（2c）：COGENT_HTTP_HOST 显式设置才放开监听（默认 loopback
    // fail-closed）。恒鉴权仍在 —— 非 loopback 下每一请求都过 token（zcode
    // 对非 loopback 直接 throw 是因为它有匿名档，本项目无匿名档）
    const hostname = process.env.COGENT_HTTP_HOST ?? '127.0.0.1'
    const http = await startHttpRpc(handleFrame, {
      port,
      hostname,
      rootSecret: createRootSecret(),
      store: capabilityStore
    })
    httpPort = http.port
    broadcastEvent = http.broadcastEvent
    if (hostname !== '127.0.0.1' && hostname !== '::1' && hostname !== 'localhost') {
      process.stderr.write(
        `[host] http rpc NON-LOOPBACK listening on ${hostname}:${http.port} —— 远程模式，全部请求需有效 token\n`
      )
    } else {
      process.stderr.write(`[host] http rpc listening on ${hostname}:${http.port}\n`)
    }
  }

  // ———— 主循环：一行一帧 ————

  const stdin = createInterface({ input: process.stdin })
  stdin.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed) void handleFrame(trimmed).then((response) => {
      if (response) reply(response)
    })
  })
  // 宿主关闭管道（退出/被杀）时服务随行退出。无引擎级退出清场：pi 的
  // bash/powershell 自管单命令进程树（abort/超时杀），但无全局登记表 ——
  // 引擎退出时在跑的命令在 unix 上留孤儿是 pi 上游语义（工具系统.md 已记）
  stdin.on('close', () => {
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    process.exit(0)
  })
  startup('stdio 就绪，等待 initialize')
}

// 启动失败（ModelRuntime 建不起来等）让进程显式死掉并留诊断 —— 引擎进程
// 拒启好过带病运行（约定.md §1.1：报错而非静默降级）
main().catch((error) => {
  process.stderr.write(`[host] 启动失败: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
