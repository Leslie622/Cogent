/**
 * Cogent Agent 服务协议 —— 对外契约，跨项目复用边界。
 *
 * 任何宿主（Cogent 的 Electron main、将来的 Electron 22 旧项目、测试脚本）
 * 实现本协议即可驱动引擎。因此本目录有兼容性纪律，与普通业务类型不同：
 *
 * - 只增不破：method / event 名一经发布不可改名、不可删；字段只增 optional；
 * - 破坏性变更必须递增 PROTOCOL_VERSION，服务在 initialize 响应里上报；
 * - 本目录零运行时依赖：只允许类型、常量、纯函数（任意 Node 版本可加载）。
 *
 * 传输：newline-delimited JSON over stdio，一行一帧。
 * 三种帧：请求（id + method）、响应（id + result/error）、事件（method，无 id）。
 */

/** 协议版本：语义承诺 = 帧格式与既有 method 语义不变，新增能力走可选字段/新 method */
export const PROTOCOL_VERSION = 1

// ———— JSON-RPC 2.0 极简子集 ————

export interface RpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: RpcError
}

/** 事件（notification）：service → 宿主的单向推送，无 id、无应答 */
export interface RpcEvent {
  jsonrpc: '2.0'
  method: string
  params: unknown
}

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

/** JSON-RPC 标准错误码（不自造语义） */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603
} as const

/** 业务层可抛的错误：dispatch 捕获后转成 RpcError 帧 */
export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** 任意异常 → RpcError（ProtocolError 保码，其余归 InternalError） */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof ProtocolError) return { code: error.code, message: error.message }
  const message = error instanceof Error ? error.message : String(error)
  return { code: RpcErrorCode.InternalError, message }
}

// ———— 帧守卫：stdio 帧解析是宿主与服务共同的信任边界 ————

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isRpcRequest(frame: unknown): frame is RpcRequest {
  return (
    isObject(frame) &&
    frame.jsonrpc === '2.0' &&
    (typeof frame.id === 'number' || typeof frame.id === 'string') &&
    typeof frame.method === 'string'
  )
}

export function isRpcEvent(frame: unknown): frame is RpcEvent {
  return isObject(frame) && frame.jsonrpc === '2.0' && typeof frame.method === 'string' && !('id' in frame)
}

// ———— 领域类型 ————

/**
 * 会话摘要（列表/创建/置顶返回）。
 * 持久化（2026-11-09，docs/计划-工作区与会话真实化.md 第 1 步）：引擎重启后经
 * StorageDriver 复原，summary 整体落盘 —— 新字段全部 optional（只增不破），
 * 旧宿主/旧盘数据缺字段即走缺省行为。
 */
export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 工作区目录（第 6 步接线：无项目也可单绑）；缺省 = 无绑定 */
  cwd?: string
  /** 项目归属（继承项目 cwd，两者可并存）；缺省 = 不属于任何项目 */
  projectId?: string
  /** 置顶时间（毫秒）；缺省 = 未置顶。存时间不存布尔：置顶分区按此倒序 */
  pinnedAt?: number
  /**
   * 归档时间（毫秒）；缺省 = 未归档。归档 = 回收站语义（软删）：session.list
   * 默认滤掉已归档会话，设置页「已归档的聊天」可查看/恢复/彻底删除。
   */
  archivedAt?: number
}

/**
 * 对话消息（协议侧的最小形状）。
 * 刻意不搬 pi 的完整 content blocks / toolCall —— 协议只暴露 UI 渲染所需。
 * thinking：assistant 思考文本（ pi ThinkingContent 块拼接，additive 扩展）；
 * 完整块结构化（phase/toolCall 等）仍是路线第 1 项，届时继续以 optional 字段扩展。
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 思考文本（仅 assistant 且模型开了思考才有）；缺省 = 无思考内容 */
  thinking?: string
  timestamp: number
}

/** provider 摘要：凭据状态用布尔位表达，key 明文永远不出引擎（安全边界） */
export interface ProviderSummary {
  id: string
  name: string
  keyConfigured: boolean
  /** 自定义 provider（custom/ 前缀，用户在设置页添加） */
  custom?: boolean
}

/** 模型摘要（models.list 返回；模型选择下拉的数据源） */
export interface ModelSummary {
  id: string
  name: string
  /** 所属 provider id（如 'anthropic' / 'openai'） */
  provider: string
  /** 是否支持推理（thinking） */
  reasoning: boolean
  /**
   * 该模型真实支持的思考力度档（含 'off'；pi getSupportedThinkingLevels 判定，
   * 源头是 pi 目录按端点手工标定的 thinkingLevelMap）。UI 滑杆按此渲染/置灰，
   * 切模型时据此 clamp —— 避免"选了 medium 实际下发 high"的静默降级。
   */
  thinkingLevels: ThinkingLevelWithOff[]
  contextWindow: number
  maxTokens: number
}

/** 工具的风险类别：审批策略按此分级 */
export type ToolKind = 'read' | 'write' | 'exec' | 'network'

/** 会话级权限模式：auto=全自动；ask=写类操作需确认；plan=只读规划 */
export type PermissionMode = 'auto' | 'ask' | 'plan'

// ———— 方法映射：method 名 → 参数/结果 ————

export interface InitializeParams {
  /** 宿主标识，如 'cogent-main' / 'legacy-electron22' / 'smoke-test' */
  client: string
  /** 宿主实现的协议版本 */
  protocolVersion: number
}

export interface InitializeResult {
  service: string
  /** 服务实现的协议版本 */
  protocolVersion: number
  /** 服务运行时的 Node 版本，宿主据此做版本守卫 */
  node: string
}

export interface InitializeParams {
  /** 宿主标识，如 'cogent-main' / 'legacy-electron22' / 'smoke-test' */
  client: string
  /** 宿主实现的协议版本 */
  protocolVersion: number
  /**
   * 握手时注入的凭据（宿主持有的持久化凭据灌进引擎内存表）。
   * optional：老宿主/冒烟脚本可以不带；key 只在引擎内存存活，不落引擎侧磁盘。
   */
  credentials?: Record<string, { apiKey: string }>
}

export interface InitializeResult {
  service: string
  /** 服务实现的协议版本 */
  protocolVersion: number
  /** 服务运行时的 Node 版本，宿主据此做版本守卫 */
  node: string
}

export interface AgentSubmitParams {
  sessionId: string
  text: string
  /** 本次请求使用的模型（provider 内模型 id）；省略时沿用会话当前模型 */
  model?: string
  /** 推理力度（pi ThinkingLevel）；省略时沿用会话当前值 */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}
export interface AgentSubmitResult {
  /** 已受理；执行结果经事件流推送（run.* / message.* / tool.*） */
  accepted: true
}

export interface ApprovalRespondParams {
  requestId: string
  approved: boolean
}
export interface ApprovalRespondResult {
  ok: true
}

export interface CredentialsSetParams {
  providerId: string
  apiKey: string
}
export interface CredentialsSetResult {
  ok: true
}

/** provider id → 是否已配 key（不含 key 明文，见 ProviderSummary 注释） */
export interface CredentialsListResult {
  providers: ProviderSummary[]
}

export interface ModelsListResult {
  models: ModelSummary[]
}

export interface SessionMessagesParams {
  sessionId: string
}
export interface SessionMessagesResult {
  messages: ChatMessage[]
}

/** 置顶/取消置顶（同一入口，pinned 二值切换）；返回更新后的完整摘要 */
export interface SessionSetPinnedParams {
  sessionId: string
  pinned: boolean
}
export interface SessionSetPinnedResult {
  summary: SessionSummary
}

/** 归档/取消归档（回收站语义：archive=false = 恢复）；返回更新后的完整摘要 */
export interface SessionArchiveParams {
  sessionId: string
  archived: boolean
}
export interface SessionArchiveResult {
  summary: SessionSummary
}

/**
 * 项目摘要（= 目录绑定，计划 D3）：会话经 projectId 归属项目并继承其全部目录。
 * cwds 多根（2026-11-09 二次决策收编）：跨仓库任务（前端+后端两仓库一个项目）
 * 是主流 Agent（VS Code workspace / Claude Code --add-dir）的既定能力；
 * 首个目录 = 主根（标题/信息区展示取它）。
 */
export interface ProjectSummary {
  id: string
  name: string
  /** 工作区根目录列表（≥1；绝对路径，创建时经宿主目录选择框取得） */
  cwds: string[]
  createdAt: number
  /** 置顶时间（毫秒）；缺省 = 未置顶（置顶分区按此倒序，移动语义：置顶后不在项目分区重复） */
  pinnedAt?: number
}

export interface ProjectCreateParams {
  name: string
  /** 工作区根目录（≥1 个；首个为主根） */
  cwds: string[]
}
export interface ProjectCreateResult {
  summary: ProjectSummary
}

export interface ProjectRenameParams {
  projectId: string
  name: string
}
export interface ProjectRenameResult {
  summary: ProjectSummary
}

export interface ProjectDeleteParams {
  projectId: string
}
export interface ProjectDeleteResult {
  deleted: boolean
}

/** 项目置顶/取消（同会话置顶口径；移动语义由 UI 分区过滤实现） */
export interface ProjectSetPinnedParams {
  projectId: string
  pinned: boolean
}
export interface ProjectSetPinnedResult {
  summary: ProjectSummary
}

/**
 * 思考等级（pi ThinkingLevel 的子集；off 是"关闭思考"，不属于"支持的等级"）。
 * 引擎按选中集构建 thinkingLevelMap：选中的等级原值透传，未选中的置 null（显式不支持）。
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 完整档位（含 'off' = 关闭思考）：thinkingLevels 等"支持档枚举"场景用 */
export type ThinkingLevelWithOff = 'off' | ThinkingLevel

/**
 * 用户自定义模型定义（内置供应商 override 与自定义供应商 modelDefs 共用）。
 * 与 pi Model 的对应：引擎侧补默认值构建（contextWindow/maxTokens 兜底 128k/32k，
 * input 缺省 ['text']，reasoning 缺省 false，cost 全 0 —— 用户端点的计费对外不可知）。
 * pi 的输入模态只有 text | image（视频/PDF 无对应字段），故只列这两项。
 */
export interface ModelDef {
  /** 模型 id（provider 内唯一；请求体 model 字段的值） */
  id: string
  /** 显示名；缺省 = id */
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  /** 模型支持思考/推理（pi 会按 thinkingLevel 附带 reasoning 参数） */
  reasoning?: boolean
  /** 支持的思考等级子集；缺省 = 跟随端点默认（不下发映射）。仅 reasoning 时有意义 */
  thinkingLevels?: ThinkingLevel[]
}

/**
 * 自定义 provider 定义（OpenAI-compatible / Anthropic-compatible 端点：中转站/网关/Ollama）。
 * 引擎侧经 createProvider 注入；key 不在本定义里（走 credentials.set 单独管理）。
 * 字段纪律（只增不破）：三个开关/过滤字段全是 optional，老宿主不带即走默认行为。
 */
export interface CustomProviderDef {
  /** `custom/<slug>` 形式，与内置 provider id 空间隔离 */
  id: string
  name: string
  baseUrl: string
  /** 模型 id 列表（端点上可用的模型，用户自填）—— 简写形式；完整定义走 modelDefs */
  models: string[]
  /** 模型完整定义（带上下文/输出/模态/推理）；与 models 合并注册，同 id 时本字段优先 */
  modelDefs?: ModelDef[]
  /**
   * 端点的 API 方言（决定引擎用哪套请求实现）。缺省 'openai-completions'
   * （最通用的兼容方言）；anthropic-messages 时请求走官方 Anthropic SDK，
   * 它会自行在 baseUrl 后拼 /v1/messages —— baseUrl 填根地址即可。
   */
  apiFormat?: 'openai-completions' | 'anthropic-messages'
  /** 禁用模型（models/modelDefs 的子集）：sync 时不注册进 provider，目录/下拉自然不出现 —— 可逆开关的数据面 */
  disabledModels?: string[]
  /** 整 provider 禁用：保留定义不注册（再启用即恢复），区别于 deleteProvider 的彻底移除 */
  disabled?: boolean
}

/**
 * 内置 provider 的本地调整（覆盖通道）：baseUrl 换中转/代理 + 模型增删。
 * baseUrl 空串 = 沿用官方端点（保留必填兼容既有载荷）；models = 用户新增模型
 * （与 pi 目录并存，id 冲突时覆盖目录同名项）；disabledModels = 目录里禁掉的模型。
 */
export interface ProviderOverrideDef {
  providerId: string
  baseUrl: string
  models?: ModelDef[]
  disabledModels?: string[]
}

export interface ProvidersCustomSyncParams {
  providers: CustomProviderDef[]
  overrides: ProviderOverrideDef[]
}
export interface ProvidersCustomSyncResult {
  synced: number
}

/**
 * method 注册表：键名即线上协议。新增 method = 在此加一行 + 服务端加 handler。
 */
export interface ProtocolMethods {
  initialize: { params: InitializeParams; result: InitializeResult }
  'session.list': { params: Record<string, never>; result: SessionSummary[] }
  'session.create': { params: { title?: string; permissionMode?: PermissionMode; cwd?: string; projectId?: string }; result: SessionSummary }
  'session.delete': { params: { sessionId: string }; result: { deleted: boolean } }
  'session.messages': { params: SessionMessagesParams; result: SessionMessagesResult }
  'session.setPinned': { params: SessionSetPinnedParams; result: SessionSetPinnedResult }
  'session.listArchived': { params: Record<string, never>; result: SessionSummary[] }
  'session.archive': { params: SessionArchiveParams; result: SessionArchiveResult }
  'project.list': { params: Record<string, never>; result: ProjectSummary[] }
  'project.create': { params: ProjectCreateParams; result: ProjectCreateResult }
  'project.rename': { params: ProjectRenameParams; result: ProjectRenameResult }
  'project.delete': { params: ProjectDeleteParams; result: ProjectDeleteResult }
  'project.setPinned': { params: ProjectSetPinnedParams; result: ProjectSetPinnedResult }
  'agent.submit': { params: AgentSubmitParams; result: AgentSubmitResult }
  'agent.abort': { params: { sessionId: string }; result: { aborted: boolean } }
  'approval.respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
  'credentials.set': { params: CredentialsSetParams; result: CredentialsSetResult }
  'credentials.list': { params: Record<string, never>; result: CredentialsListResult }
  'models.list': { params: Record<string, never>; result: ModelsListResult }
  'providers.custom.sync': { params: ProvidersCustomSyncParams; result: ProvidersCustomSyncResult }
}

// ———— 事件映射（service → 宿主；骨架期先定形状，随实现细化） ————

export interface ProtocolEvents {
  'run.started': { sessionId: string }
  'run.completed': {
    sessionId: string
    /** 最终完整 assistant 回复；renderer 用它替换流式累积，免拼 delta */
    message?: ChatMessage
    /**
     * pi 停止原因（stop/length/toolUse…）。length = 输出被 token 上限截断
     * （模型上限或端点侧强制上限），UI 据此提示"回复被截断"——截断不是错误，
     * pi 也按正常结束处理，不透出就无从呈现。
     */
    stopReason?: string
  }
  'run.failed': { sessionId: string; message: string }
  /**
   * 流式增量（同一条 assistant 消息内按 kind 分流）：
   * - 'text'（缺省，兼容不带 kind 的旧引擎）：正文增量；
   * - 'thinking'：思考增量（模型开了思考且未结束时先于正文产生）。
   * 同 messageId = 同一条消息的两路累积缓冲，宿主各自拼接。
   */
  'message.delta': { sessionId: string; messageId: string; delta: string; kind?: 'text' | 'thinking' }
  'tool.started': { sessionId: string; callId: string; name: string; kind: ToolKind }
  'tool.completed': { sessionId: string; callId: string; isError: boolean; summary: string }
  /** 审批请求：宿主（最终是用户）裁决后以 approval.respond 回复 */
  'approval.request': {
    sessionId: string
    requestId: string
    toolName: string
    kind: ToolKind
    summary: string
  }
}
