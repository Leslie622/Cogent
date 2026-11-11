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
  type ApprovalRespondParams,
  type CredentialsListResult,
  type SessionArchiveParams,
  type CredentialsSetParams,
  type CustomProviderDef,
  type InitializeParams,
  type InitializeResult,
  type PermissionMode,
  type ProtocolEvents,
  type ProviderOverrideDef,
  type ProvidersCustomSyncParams,
  type ProvidersCustomSyncResult,
  type RpcEvent,
  type RpcResponse,
  type SessionMessagesParams,
  type SessionSetPermissionParams,
  type SessionSetPinnedParams
} from '../protocol'
import { CredentialRegistry } from './runtime/credentials'
import { SessionManager } from './runtime/session'
import { ProjectRegistry } from './runtime/project'
import { ApprovalRegistry } from './runtime/approvals'
import { InspectStore, JsonStorageDriver } from './storage'
import { killTrackedDetachedChildren } from './tools/shell'

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
// 观测记录落盘（~/.cogent/inspect/*.jsonl，重启回看；构造无 I/O，惰性到会话首用）
const inspectStore = new InspectStore(STORAGE_ROOT)
// 装配顺序：projects/approvals 先建（无依赖），sessions 后建（构造即拿到引用；
// SessionManager 对它们的使用只发生在 submit/respond 期，无构造期回查）
const projects = new ProjectRegistry(storage)
// 审批规则表（~/.cogent/approvals.json 单文件，构造即恢复；「始终允许此工作区」）
const approvals = new ApprovalRegistry(STORAGE_ROOT)
const sessions = new SessionManager(credentials, storage, notify, projects, approvals, inspectStore)

// 方言模块预热：pi-ai 的 API 方言是**首次请求时**才动态 import（lazyApi），
// 冷启动一次要拉起整个厂商 SDK（openai-completions 连带 26MB 的 openai 包，
// Windows Defender 扫描把首请求拖慢到秒级 —— 实测首句「你好」墙钟 5s 里 3.8s
// 是它）。这笔钱付在首条消息上是错误的位置：用户正盯着「工作中」计时器。
// 进程启动即后台预加载 Cogent 支持的全部三个方言，把成本挪进启动期 ——
// 与懒加载命中同一模块缓存（exports 子路径与 lazy 相对 import 解析到同一
// 文件 URL），首请求直接热。预热失败不炸启动（allSettled + 不 await）：
// 退回懒加载语义，不比没预热差。
void Promise.allSettled([
  import('@earendil-works/pi-ai/api/anthropic-messages'),
  import('@earendil-works/pi-ai/api/openai-completions'),
  import('@earendil-works/pi-ai/api/openai-responses')
])

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

/** credentials.remove 入口校验：providerId 非空 string */
function handleCredentialsRemove(params: unknown): { ok: true } {
  const p = params as Partial<{ providerId: unknown }>
  if (typeof p.providerId !== 'string' || p.providerId.length === 0) {
    throw new ProtocolError(RpcErrorCode.InvalidParams, 'credentials.remove 需要 { providerId: string }')
  }
  credentials.delete(p.providerId)
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

/** PermissionMode 值域守卫（入口校验共用）：stdio 载荷是任意 JSON，类型声明
    不构成运行时保证，typeof 检查是真实防御（约定.md 1.1 stdio 帧边界） */
function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'auto' || value === 'ask' || value === 'plan' || value === 'autonomous'
}

/** session.create 入口校验：optional 字段带了就必须合法（permissionMode 限值域）。
    逐字段独立守卫（不用 || 复合）—— TS 的控制流分析只在独立 if 里窄化类型 */
function handleSessionCreate(params: unknown) {
  const p = params as Partial<{ title: unknown; cwd: unknown; projectId: unknown; permissionMode: unknown }>
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
    throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.create 的 permissionMode 必须是 auto|ask|plan 之一')
  }
  return sessions.create({
    title: p.title,
    cwd: p.cwd,
    projectId: p.projectId,
    permissionMode: p.permissionMode
  })
}

/** session.delete 入口校验：sessionId 非空 string */
function handleSessionDelete(params: unknown) {
  const p = params as Partial<{ sessionId: unknown }>
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
    throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.delete 需要 { sessionId: string }')
  }
  return { deleted: sessions.delete(p.sessionId) }
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

/** agent.submit 入口校验：sessionId/text 必填非空；model/provider/thinkingLevel 带了就约束值域。
    optional 字段逐个独立守卫（TS 控制流只在独立 if 里窄化，复合 || 不窄化） */
function handleAgentSubmit(params: unknown) {
  const p = params as Partial<{ sessionId: unknown; text: unknown; model: unknown; provider: unknown; thinkingLevel: unknown }>
  const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || typeof p.text !== 'string' || p.text.length === 0) {
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
  sessions.submit(p.sessionId, p.text, p.model, p.thinkingLevel, p.provider)
  return { accepted: true as const }
}

/** approval.respond 入口校验：requestId 非空 string + approved 布尔；optional
    的 message/always 带了就约束形状，且 always（落规则）与 approved=false 同发
    是矛盾载荷直接拒绝。唔配对 requestId 在 SessionManager 抛 InvalidParams ——
    双击允许钮、裁决与中止竞态都属此类，显式报错而非静默成功 */
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
  return sessions.respondApproval(p.requestId, p.approved, p.message, p.always)
}

/** session.setPermission 入口校验：sessionId 非空 string + mode 限值域。
    mode 不校验会被静默存脏值（约定.md 1.2-6：兜底掩盖非法状态） */
function handleSessionSetPermission(params: unknown) {
  const p = params as Partial<SessionSetPermissionParams>
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0 || !isPermissionMode(p.mode)) {
    throw new ProtocolError(RpcErrorCode.InvalidParams, 'session.setPermission 需要 { sessionId: string, mode: auto|ask|plan }')
  }
  return { summary: sessions.setPermission(p.sessionId, p.mode) }
}

/** inspect.entries 入口校验：sessionId 非空 string */
function handleInspectEntries(params: unknown) {  const p = params as Partial<{ sessionId: unknown }>
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

/**
 * 方法注册表：method 名 → handler。
 * handler 内部信任协议类型（边界校验已在入口完成），业务异常直接 throw，
 * 由 dispatch 统一转成错误帧 —— 不要在 handler 里自行 try/catch。
 */
const handlers = new Map<string, (params: unknown) => unknown>([
  ['initialize', handleInitialize],
  ['session.list', () => sessions.list()],
  ['session.create', handleSessionCreate],
  ['session.delete', handleSessionDelete],
  ['session.messages', handleSessionMessages],
  ['session.setPinned', handleSessionSetPinned],
  ['session.archive', handleSessionArchive],
  ['session.listArchived', () => sessions.listArchived()],
  ['session.setPermission', handleSessionSetPermission],
  ['project.list', () => projects.list()],
  ['project.create', handleProjectCreate],
  ['project.rename', handleProjectRename],
  ['project.delete', handleProjectDelete],
  ['project.setPinned', handleProjectSetPinned],
  ['agent.submit', handleAgentSubmit],
  ['agent.abort', (params) => ({ aborted: sessions.abort((params as { sessionId: string }).sessionId) })],
  // 宿主侧裁决通道：不经 renderer 通用代理（D3），main 的 approval:respond 专属
  // IPC 直抵这里 —— 但协议上是普通 method（任何宿主都能驱动，无传输层特权）
  ['approval.respond', handleApprovalRespond],
  ['credentials.set', handleCredentialsSet],
  ['credentials.remove', handleCredentialsRemove],
  ['credentials.list', handleCredentialsList],
  ['models.list', () => sessions.listModels()],
  ['providers.custom.sync', handleProvidersCustomSync],
  ['inspect.entries', handleInspectEntries],
  ['inspect.entry', handleInspectEntry]
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
// 宿主关闭管道（退出/被杀）时服务随行退出。退出前杀掉 bash 工具拉起的
// detached 子进程树 —— 引擎死了没人替我们杀，留着就是孤儿（宿主侧 Electron
// 的教训在引擎侧同样成立，见 tools/shell.ts）
stdin.on('close', () => {
  killTrackedDetachedChildren()
  process.exit(0)
})
process.on('SIGTERM', () => {
  killTrackedDetachedChildren()
  process.exit(0)
})

// 冒烟自检：无需宿主，直接管道喂数据即可验证协议链路，命令见 docs/开发.md。
void reply // dispatch 内已用；保留导出位避免 noUnusedLocals 误报（与原骨架一致的做法）
