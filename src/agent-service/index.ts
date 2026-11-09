/**
 * Agent 服务 —— 独立 Node 进程入口，Cogent 的"引擎"。
 *
 * 为什么是独立进程（决策见 docs/架构.md）：
 * - pi 要求 Node >= 22.19 且 ESM-only，Electron 22 等旧宿主无法进程内集成；
 * - 工具执行（shell / 文件写入）需要崩溃隔离：引擎挂了不拖垮宿主；
 * - abort 可以硬杀到进程级。
 *
 * 纪律（目录即边界）：
 * - 只允许依赖 pi-* 与 ../protocol，禁止 import Electron / renderer 代码；
 * - 无头运行：stdin 进请求，stdout 出响应/事件，stderr 只出诊断日志；
 * - 它不知道"窗口"的存在，任何 Node 宿主都能拉起它。
 *
 * 防御边界（本项目防御政策的示范位）：stdin 是本进程唯一的不可信输入，
 * 校验只发生在 dispatch 入口（JSON 解析 + isRpcRequest + 参数显式收窄）；
 * handler 内部信任协议类型，不做二次防御。
 */
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  ProtocolError,
  RpcErrorCode,
  isRpcEvent,
  isRpcRequest,
  toRpcError,
  type CredentialsListResult,
  type SessionArchiveParams,
  type CredentialsSetParams,
  type CustomProviderDef,
  type InitializeParams,
  type InitializeResult,
  type ProtocolEvents,
  type ProviderOverrideDef,
  type ProvidersCustomSyncParams,
  type ProvidersCustomSyncResult,
  type RpcEvent,
  type RpcResponse,
  type SessionMessagesParams,
  type SessionSetPinnedParams
} from '../protocol'
import { CredentialRegistry } from './runtime/credentials'
import { SessionManager } from './runtime/session'
import { ProjectRegistry } from './runtime/project'
import { JsonStorageDriver } from './storage'

/** 事件发送：service → 宿主（notification 帧） */
function notify<E extends keyof ProtocolEvents>(method: E, params: ProtocolEvents[E]): void {
  const frame: RpcEvent = { jsonrpc: '2.0', method, params }
  process.stdout.write(JSON.stringify(frame) + '\n')
}

/** 响应发送 */
function reply(response: RpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n')
}

/**
 * 存储根：第一方数据唯一根（决策 D1，docs/计划-工作区与会话真实化.md §1/§2）。
 * COGENT_HOME 覆盖口供冒烟测试指临时目录（同 COGENT_NODE_BIN 手法）；
 * 第 2 步把 main 侧凭据 store 也迁到同根（引擎是纯 Node，自算 home 零 Electron）。
 */
const STORAGE_ROOT = process.env.COGENT_HOME || join(homedir(), '.cogent')

/** 引擎单例：凭据表 + 本地 JSON 存储 + 项目注册表 + 会话运行时（构造即恢复盘上数据） */
const credentials = new CredentialRegistry()
const storage = new JsonStorageDriver(STORAGE_ROOT)
// 装配顺序：projects 先建（无依赖），sessions 后建（构造即拿到项目引用；
// SessionManager 对项目的使用只发生在 submit 期，无构造期回查）
const projects = new ProjectRegistry(storage)
const sessions = new SessionManager(credentials, storage, notify, projects)

/** 握手：宿主确认链路可用，服务上报运行时信息（宿主据此做 Node 版本守卫）。 */
function handleInitialize(params: unknown): InitializeResult {
  // 信任边界：params 是外部输入，在此做唯一一次显式校验。
  const p = params as Partial<InitializeParams>
  if (typeof p.client !== 'string' || typeof p.protocolVersion !== 'number') {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      'initialize 需要 { client: string, protocolVersion: number }'
    )
  }
  // optional 凭据注入：宿主持久化的 key 灌进引擎内存表（老宿主可不带）
  if (p.credentials) credentials.loadAll(p.credentials)
  return { service: 'cogent-agent', protocolVersion: PROTOCOL_VERSION, node: process.version }
}

/** credentials.set 入口校验：providerId/apiKey 均为非空 string */
function handleCredentialsSet(params: unknown): { ok: true } {
  const p = params as Partial<CredentialsSetParams>
  if (typeof p.providerId !== 'string' || p.providerId.length === 0 || typeof p.apiKey !== 'string') {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      'credentials.set 需要 { providerId: string, apiKey: string }'
    )
  }
  credentials.set(p.providerId, p.apiKey)
  return { ok: true }
}

/** credentials.list：provider 摘要（keyConfigured 布尔位，key 明文不出引擎） */
function handleCredentialsList(): CredentialsListResult {
  return { providers: credentials.summaries() }
}

/** session.messages 入口校验：sessionId 非空 string */
function handleSessionMessages(params: unknown) {
  const p = params as Partial<SessionMessagesParams>
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
    throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.messages 需要 { sessionId: string }')
  }
  return { messages: sessions.messages(p.sessionId) }
}

/** session.setPinned 入口校验：sessionId 非空 string + pinned 布尔 */
function handleSessionSetPinned(params: unknown) {
  const p = params as Partial<SessionSetPinnedParams>
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.pinned !== 'boolean') {
    throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.setPinned 需要 { sessionId: string, pinned: boolean }')
  }
  return { summary: sessions.setPinned(p.sessionId, p.pinned) }
}

/** session.archive 入口校验 */
function handleSessionArchive(params: unknown) {
  const p = params as Partial<SessionArchiveParams>
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.archived !== 'boolean') {
    throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.archive 需要 { sessionId: string, archived: boolean }')
  }
  return { summary: sessions.archive(p.sessionId, p.archived) }
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

/** providers.custom.sync 入口校验：两数组存在、每项字段形状收窄（id 带 custom/ 前缀的交由 registry 处理）。
    载荷实为外部任意 JSON，协议类型只是声明 —— 按 unknown 收窄，不依赖标注类型 */
function handleProvidersCustomSync(params: unknown): ProvidersCustomSyncResult {
  const p = params as Partial<ProvidersCustomSyncParams>
  const defs = p.providers
  const overrides = p.overrides
  const API_FORMATS = ['openai-completions', 'anthropic-messages'] as const
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

/**
 * 方法注册表：method 名 → handler。
 * handler 内部信任协议类型（边界校验已在入口完成），业务异常直接 throw，
 * 由 dispatch 统一转成错误帧 —— 不要在 handler 里自行 try/catch。
 */
const handlers = new Map<string, (params: unknown) => unknown>([
  ['initialize', handleInitialize],
  ['session.list', () => sessions.list()],
  ['session.create', (params) => {
    const p = params as { title?: string; cwd?: string; projectId?: string }
    return sessions.create({ title: p.title, cwd: p.cwd, projectId: p.projectId })
  }],
  ['session.delete', (params) => ({ deleted: sessions.delete((params as { sessionId: string }).sessionId) })],
  ['session.messages', handleSessionMessages],
  ['session.setPinned', handleSessionSetPinned],
  ['session.archive', handleSessionArchive],
  ['session.listArchived', () => sessions.listArchived()],
  ['project.list', () => projects.list()],
  ['project.create', handleProjectCreate],
  ['project.rename', handleProjectRename],
  ['project.delete', (params) => ({ deleted: projects.delete((params as { projectId: string }).projectId) })],
  ['project.setPinned', (params) => {
    const p = params as { projectId: string; pinned: boolean }
    return { summary: projects.setPinned(p.projectId, p.pinned) }
  }],
  ['agent.submit', (params) => {
    const p = params as { sessionId: string; text: string; model?: string; provider?: string; thinkingLevel?: string }
    // submit 内部同步校验（会话存在/空闲），失败 throw → dispatch 转错误帧；
    // 受理后 LLM 循环在 submit 内部异步执行，进度走事件流。这里不能拿掉同步调用
    // 改成 fire-and-forget 的 promise：异步拒绝会绕过 dispatch 的 try/catch 崩掉引擎
    sessions.submit(p.sessionId, p.text, p.model, p.thinkingLevel, p.provider)
    return { accepted: true as const }
  }],
  ['agent.abort', (params) => ({ aborted: sessions.abort((params as { sessionId: string }).sessionId) })],
  ['credentials.set', handleCredentialsSet],
  ['credentials.list', handleCredentialsList],
  ['models.list', () => ({ models: sessions.listModels() })],
  ['providers.custom.sync', handleProvidersCustomSync]
])

/** 单帧处理：请求 → 响应；事件/畸形帧按协议丢弃并记诊断日志。 */
async function dispatch(raw: string): Promise<void> {
  let frame: unknown
  try {
    frame = JSON.parse(raw)
  } catch {
    // 信任边界：宿主发来的行不是合法 JSON（旧版本客户端 / 实现错误）
    reply({ jsonrpc: '2.0', id: null, error: { code: RpcErrorCode.ParseError, message: 'invalid JSON frame' } })
    return
  }

  if (isRpcEvent(frame)) {
    // 当前协议里 宿主→服务 方向只有请求；收到事件帧说明对方实现越界。
    process.stderr.write(`[agent-service] dropped unexpected event frame: ${frame.method}\n`)
    return
  }
  if (!isRpcRequest(frame)) {
    process.stderr.write(`[agent-service] dropped malformed frame: ${raw.slice(0, 120)}\n`)
    return
  }

  const handler = handlers.get(frame.method)
  if (!handler) {
    reply({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: RpcErrorCode.MethodNotFound, message: `unknown method: ${frame.method}` }
    })
    return
  }

  try {
    reply({ jsonrpc: '2.0', id: frame.id, result: await handler(frame.params ?? {}) })
  } catch (error) {
    reply({ jsonrpc: '2.0', id: frame.id, error: toRpcError(error) })
  }
}

// ———— 主循环：一行一帧 ————

const stdin = createInterface({ input: process.stdin })
stdin.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed) void dispatch(trimmed)
})
// 宿主关闭管道（退出/被杀）时服务随行退出，不做任何延迟收尾。
stdin.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// 冒烟自检：无需宿主，直接管道喂数据即可验证协议链路，命令见 docs/开发.md。
void reply // dispatch 内已用；保留导出位避免 noUnusedLocals 误报（与原骨架一致的做法）
