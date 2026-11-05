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

/** 会话摘要（列表/创建返回；完整消息模型随实现细化） */
export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
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

export interface AgentSubmitParams {
  sessionId: string
  text: string
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

/**
 * method 注册表：键名即线上协议。新增 method = 在此加一行 + 服务端加 handler。
 */
export interface ProtocolMethods {
  initialize: { params: InitializeParams; result: InitializeResult }
  'session.list': { params: Record<string, never>; result: SessionSummary[] }
  'session.create': { params: { title?: string; permissionMode?: PermissionMode }; result: SessionSummary }
  'session.delete': { params: { sessionId: string }; result: { deleted: boolean } }
  'agent.submit': { params: AgentSubmitParams; result: AgentSubmitResult }
  'agent.abort': { params: { sessionId: string }; result: { aborted: boolean } }
  'approval.respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
}

// ———— 事件映射（service → 宿主；骨架期先定形状，随实现细化） ————

export interface ProtocolEvents {
  'run.started': { sessionId: string }
  'run.completed': { sessionId: string }
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
