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
 * 会话摘要（列表/创建返回）。
 * 存储落地前会话只活在引擎内存（docs/路线.md 第 3 项另做），因此没有持久化相关字段。
 */
export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/**
 * 对话消息（协议侧的最小形状）。
 * 刻意不含 pi 的 content blocks / thinking / toolCall —— 协议只暴露 UI 渲染所需，
 * pi 消息模型细化为路线第 1 项，届时以 optional 字段扩展。
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
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

/**
 * 自定义 provider 定义（OpenAI-compatible 端点：中转站/网关/Ollama）。
 * 引擎侧经 createProvider 注入；key 不在本定义里（走 credentials.set 单独管理）。
 */
export interface CustomProviderDef {
  /** `custom/<slug>` 形式，与内置 provider id 空间隔离 */
  id: string
  name: string
  baseUrl: string
  /** 模型 id 列表（端点上可用的模型，用户自填） */
  models: string[]
}

/** 内置 provider 的 baseUrl 覆盖（代理/中转），对齐 pi models.json 原生能力 */
export interface ProviderOverrideDef {
  providerId: string
  baseUrl: string
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
  'session.create': { params: { title?: string; permissionMode?: PermissionMode }; result: SessionSummary }
  'session.delete': { params: { sessionId: string }; result: { deleted: boolean } }
  'session.messages': { params: SessionMessagesParams; result: SessionMessagesResult }
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
  /** TODO(实现时细化)：delta 先按纯文本，后续换结构化 content blocks */
  'message.delta': { sessionId: string; messageId: string; delta: string }
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
