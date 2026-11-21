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
export const PROTOCOL_VERSION = 3

import type { AttachmentMethods } from '../shared/attachments'
import type { FileMethods, FileInternalMethods, FileContext, FileReference } from '../shared/files'
import type { OutputMethods, TurnOutputs } from '../shared/outputs'

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

/** 事件（notification）：host → 宿主的单向推送，无 id、无应答 */
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
 * 持久化（2026-11-09，docs/模块/工作区与项目.md）：引擎重启后经
 * StorageDriver 复原，summary 整体落盘 —— 新字段全部 optional（只增不破），
 * 旧宿主/旧盘数据缺字段即走缺省行为。
 */
export interface SessionSummary {
  id: string
  title: string
  /** 用户手动命名后不再由首条消息覆盖；缺省沿用自动命名规则。 */
  titleManual?: boolean
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
   * 默认滤掉已归档会话，设置页「归档」可查看/恢复/彻底删除。
   */
  archivedAt?: number
  /**
   * 会话级权限模式（工具审批判定矩阵的会话侧输入，docs/模块/审批与权限.md）：
   * ask（缺省）= 写类工具先审批；auto = 全放行（「完全访问」）；autonomous =
   * 文件写放行/exec 询问。缺省按 ask 处理（旧盘数据无此字段即落默认行为）。
   */
  permissionMode?: PermissionMode
  /**
   * 计划模式开关（正交于权限档，docs/模块/审批与权限.md）：true = 只读
   * 约束生效（写/exec 拒绝，优先于档位放行）+ submit_plan 可用。缺省 = 关。
   * permissionMode 永不被 plan 触碰 —— 关闭开关后原档自动恢复，无需记回退档。
   */
  planEnabled?: boolean
}

/**
 * 一次回答的 token 用量（仅 assistant；pi Usage 的投影形状）。
 * 手写而非 import pi 类型 —— 协议零运行时依赖（约定.md §2）。
 * reasoning 是 output 的子集，provider 报告了该细项才有；
 * totalCost = pi cost.total（端点实报优先、目录估价兜底），目录无定价的模型缺省。
 * totalCostFromProvider 区分两者：估价 ≠ 账单（目录单价是汇率/分时快照，
 * 如 DeepSeek 官方分时半价未建模），UI 据此给成本加 ≈ 前缀；多轮全实报才算实报。
 * 工具循环多轮时为各轮之和（计费口径：每轮请求都携带全量上下文，账单即各轮相加）。
 */
export interface MessageUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 思考 token（output 子集）；provider 未报告该细项时缺省 */
  reasoning?: number
  totalTokens: number
  /** 本次总成本 USD；无定价时缺省 */
  totalCost?: number
  /** 成本是否端点实报（OpenRouter 等）；false/缺省 = 目录估价（旧会话数据同按估价处理） */
  totalCostFromProvider?: boolean
  /**
   * 上下文明细估算（2026-11-11 additive；悬浮卡分类区数据源）。粗估口径 =
   * pi estimateContextTokens（3.5 chars/token，与引擎 max_tokens 预算同源），
   * 与末轮端点实报的 input/cache* 有误差 —— UI 据此带 ≈ 标记。
   * 三段：系统提示词 / 系统工具声明 / 对话消息；缺省 = 引擎未算（旧会话投影）。
   */
  contextEstimate?: ContextEstimate
}

/** 上下文明细三段估算（token 数；见 MessageUsage.contextEstimate） */
export interface ContextEstimate {
  /** leading system message 文本（工作区上下文 + 权限通告等） */
  systemPrompt: number
  /** 工具 JSON schema 声明（toolsAdded，estimateToolsTokens 口径） */
  toolDefs: number
  /** 其余全部消息（user/assistant/toolResult） */
  messages: number
  /** 三段之和（= estimateContextTokens().tokens，即 max_tokens 预算式里的"占用"） */
  total: number
}

/**
 * 工具调用投影（工具卡数据形状，docs/模块/审批与权限.md）：
 * 流式（tool.started/completed 事件）与历史回查（ChatMessage.toolCalls）共用。
 * status 三态：ok = 执行成功；error = 执行失败（结果 isError）；blocked =
 * 未执行（审批拒绝 / 计划模式只读拦截 / 中止 —— 模型收到的是 error 结果 + 原因）。
 */
export interface ToolCallRecord {
  fileRefs?: FileReference[]
  /** pi toolCall 块 id（事件流与历史回查的配对键） */
  callId: string
  name: string
  kind: ToolKind
  /** 参数一行摘要（引擎生成，如 read("src/index.ts")）；UI 卡标题 */
  summary: string
  status: 'ok' | 'error' | 'blocked'
  /** 结果一行摘要（截断）；错误/拒绝时为原因 */
  resultSummary?: string
  /** 执行起点毫秒（引擎 tool_execution_start 打点）。UI 聚合「工具时长」用 ——
   *  与 endedAt 构成区间，渲染端做并集（并行工具同拍执行不重复计墙钟）；
   *  blocked（未执行）与旧转录（无 durationMs 可倒推）缺省，聚合时自然跳过 */
  startedAt?: number
  /** 执行终点毫秒（流式 = tool_execution_end 打点；历史回查 = pi toolResult
   *  消息 timestamp —— 转录持久化的单一来源，重启回查数字不漂移） */
  endedAt?: number
  /** edit 工具的展示 diff（带行号的 +-/ 上下文 diff，引擎从工具 details 提取；
   *  D4 定稿进协议 —— 工具卡 diff 呈现的数据源。缺省 = 非
   *  edit 工具或旧转录，UI 自然不渲染 diff 块） */
  diff?: string
}

/**
 * 对话消息（协议侧的最小形状）。
 * 刻意不搬 pi 的完整 content blocks / toolCall —— 协议只暴露 UI 渲染所需。
 * thinking：assistant 思考文本（ pi ThinkingContent 块拼接，additive 扩展）；
 * usage/durationMs/model：token 用量/模型耗时/模型名（2026-11-09 additive，
 * 属路线空位 1 的 usage 先行，同 thinking 的 flat 先行模式）；
 * toolCalls：本条 assistant 消息发起的工具调用（2026-11-10 additive，
 * 工具循环落地 —— 段化投影，见 run.completed.messages 注释）；
 * 完整块结构化（phase/签名透传等）仍是路线第 1 项，届时继续以 optional 字段扩展。
 */
export interface ChatMessage {
  turnId?: string
  fileContext?: FileContext
  attachments?: import('../shared/attachments').AttachmentRef[]
  directories?: import('../shared/attachments').DirectoryRef[]
  id: string
  /**
   * role 'compaction'（additive）= 上下文压缩折叠条：
   * content 为 checkpoint 摘要全文（点击展开可读），不参与回合的问答切分。
   * 老宿主按 role switch 渲染时落 default 分支自然忽略，不破。
   */
  role: 'user' | 'assistant' | 'compaction'
  content: string
  /** 思考文本（仅 assistant 且模型开了思考才有）；缺省 = 无思考内容 */
  thinking?: string
  /** token 用量（仅 assistant）；缺省 = 引擎没拿到（如极老会话的投影） */
  usage?: MessageUsage
  /** 模型耗时毫秒（仅 assistant，各轮之和，不含工具执行时间）；pi 未计时则缺省 */
  durationMs?: number
  /** 产生本回答的模型 id（仅 assistant） */
  model?: string
  /** 本条消息发起的工具调用（仅 assistant，按发生序）；缺省 = 无工具轮 */
  toolCalls?: ToolCallRecord[]
  /** 压缩元数据（仅 role 'compaction'）：前后 token 估算，折叠条文案与
   *  指示器回落的数据源；summaryUsage = 摘要调用自身的账（不进 run 统计，
   *  折叠条小字呈现）；缺省 = 非 compaction 消息或旧引擎投影 */
  compaction?: { tokensBefore: number; tokensAfter?: number; summaryUsage?: MessageUsage }
  timestamp: number
}

/**
 * provider 摘要：凭据状态用布尔位表达，key 明文不出**引擎**（引擎协议侧边界）。
 * 注意全链路口径（2026-11-08 产品决策）：壳侧另有 credentials:get 按 provider
 * 单取明文供设置页回显 —— 引擎不回流 ≠ 宿主不回流，两侧边界勿混。
 */
export interface ProviderSummary {
  id: string
  name: string
  keyConfigured: boolean
  /** 自定义 provider（custom/ 前缀，用户在设置页添加） */
  custom?: boolean
}

/** 模型摘要（models.list 返回；模型选择下拉的数据源） */
export interface ModelSummary {
  input?: Array<'text' | 'image'>
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
  /**
   * 是否用户添加（目录外新增/自定义供应商注册）；缺省 false = pi 目录原生。
   * UI 据此区分"默认模型 vs 自定义模型"：默认模型编辑时锁 id（目录身份不可
   * 改，只能调配置）；显示层一律用 id（2026-11-10 定调），name 不参与呈现。
   */
  userDefined?: boolean
  /**
   * 有效压缩触发阈值占窗口比（0–1，完备化批次 R1）：引擎按 model.compaction
   * 覆盖代入触发公式对 contextWindow 解出（max(50%, min(ratio, 1−floor/ctx))）。
   * 指示器预警线直接画它 —— 小窗模型触发线显著前移（20K 窗 ≈59%），引擎侧
   * 真值随目录下发，消灭 renderer 侧 0.9 常量双处镜像。窗口缺数据（≤0）的
   * 怪模型不带，渲染端回落 0.9。
   */
  compactionThresholdRatio?: number
}

/** 工具的风险类别：审批策略按此分级（edit 属写类） */
export type ToolKind = 'read' | 'write' | 'edit' | 'exec' | 'network'

/**
 * 会话级权限模式：auto=全自动；ask=写类操作需确认；
 * autonomous=自主模式（D6 定稿：文件写
 * write/edit 信任放行，exec/network 风险类逐次询问 —— 之前无 exec/network
 * 工具时它只能是 ask 同义词，故一直置灰占位）。
 * 只读计划是正交开关（SessionSummary.planEnabled），不占档位 —— v3 起删
 * 'plan' 联合值（docs/模块/审批与权限.md）。
 */
export type PermissionMode = 'auto' | 'ask' | 'autonomous'

// ———— 方法映射：method 名 → 参数/结果 ————

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
  /** HTTP 门实际监听端口（阶段 2b-2 起；未开门的老宿主/不开门时缺省） */
  httpPort?: number
}

export interface AgentSubmitParams {
  attachmentIds?: string[]
  directories?: import('../shared/attachments').DirectoryRef[]
  inputId?: string
  sessionId: string
  text: string
  /** 本次请求使用的模型（provider 内模型 id）；省略时沿用会话当前模型 */
  model?: string
  /**
   * 模型所属 provider id（如 'deepseek'）：同名模型被多家目录收录时（azure
   * 也收录 deepseek-v4-pro）id 单键全局查找有歧义，UI 选择时的 provider
   * 原样下发、引擎双键限定解析；省略 = 引擎按旧序解析（默认 provider 优先）
   */
  provider?: string
  /**
   * 推理力度（pi ThinkingLevel 原样含 'off' = 关闭思考；方言层会翻成 DeepSeek/
   * anthropic 的 thinking disabled、google 的 enabled:false 或 openai 的省略字段）。
   * 曾把 off 误当"不属于档位"漏出枚举，导致滑杆默认档被入口校验拒收 ——
   * 回归钉见 tests/integration/thinking-off.test.ts。省略时沿用会话当前值
   */
  thinkingLevel?: ThinkingLevelWithOff
}
export interface AgentSubmitResult {
  /** 已受理；执行结果经事件流推送（run.* / message.* / tool.*） */
  accepted: true
}

export interface ApprovalRespondParams {
  requestId: string
  approved: boolean
  /**
   * 拒绝附言（「告诉模型接下来怎么做」，审批交互升级 D2）：进 block reason →
   * 工具错误结果给模型，自我纠正依据。仅在 approved=false 时有意义。
   */
  message?: string
  /**
   * 'workspace' = 允许本次 + 落工作区级「始终允许」规则（D3；隐含 approved=true，
   * 与 approved=false 同发是矛盾载荷，入口校验拒绝）。规则存引擎侧全局
   * approvals.json，只记 roots 不记命令/内容（无泄漏面，对照 Claude Code
   * settings.local.json 事故，调研见 技术笔记/工具系统与审批.md）。
   */
  always?: 'workspace'
  /**
   * 「允许，并切换为 X」（zcode 同款）：允许本次 + 会话
   * 切到该模式 + **记为项目默认**（同一项目的新会话沿用）。只收两档放宽模式
   * （auto/autonomous）—— 切回收紧档走权限菜单（显式动作，不藏在审批里）。
   * 隐含 approved=true，与 approved=false 同发是矛盾载荷，入口校验拒绝。
   */
  switchMode?: 'auto' | 'autonomous'
}
export interface ApprovalRespondResult {
  ok: true
  /**
   * switchMode 场景带回切换后的会话摘要（宿主同步列表里的模式标记；
   * 非切换场景缺省）。
   */
  summary?: SessionSummary
}

export interface CredentialsSetParams {
  providerId: string
  apiKey: string
}
export interface CredentialsSetResult {
  ok: true
}

/**
 * 删除单条凭据（credentials.remove，2026-11-10 additive）：此前引擎内存表只有
 * set 没有 remove —— 宿主删 key 只能写空串冒充（壳判"未配置"、引擎判"已配置(空)"
 * 的语义分裂）。删除 = 引擎内存表移除 + 宿主各自处理自己的持久化。
 */
export interface CredentialsRemoveParams {
  providerId: string
}
export interface CredentialsRemoveResult {
  ok: true
}

/** provider id → 是否已配 key（不含 key 明文，见 ProviderSummary 注释） */
export interface CredentialsListResult {
  providers: ProviderSummary[]
}

export interface ModelsListResult {
  models: ModelSummary[]
  /**
   * 引擎侧的默认模型（provider + id 双键，2026-11-10 additive）：宿主用它替代
   * 自己复制一份默认模型常量 —— 复制无机制保证一致，漂移后回填偏好会指向
   * 不可用模型。老引擎缺省 = 宿主自行取 models[0]。
   */
  defaultModel?: { provider: string; id: string }
}

export interface SessionMessagesParams {
  sessionId: string
}
export interface SessionMessagesResult {
  messages: ChatMessage[]
  /**
   * 当前任务清单（交互座 4c，additive）：todo_write 维护的活清单 —— 打开
   * 会话时 TodoStrip 的种子数据；运行中增量走 todos.updated 事件。缺省 =
   * 无清单（从未写过 todo_write 的会话 / 旧引擎）。
   */
  todos?: TodoItem[]
}

/**
 * 任务清单条目（交互座 4c；todo_write 工具参数与 todos.updated 事件共用）。
 * 全量替换语义：每次 todo_write 提交完整清单（zcode/dsh 同款，非增量 patch）。
 */
export interface TodoItem {
  /** 任务简述（一行） */
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** ask_user 的选项（交互座 4c-2；question.asked 事件载荷） */
export interface AskOptionParam {
  label: string
  description?: string
}
/** ask_user 的单个问题 */
export interface AskQuestionParam {
  question: string
  header?: string
  options: AskOptionParam[]
  multiSelect?: boolean
}
/** question.respond 参数：按问题序作答；字符串（单选/自由输入）、多选数组、空串 = 跳过 */
export interface QuestionRespondParams {
  requestId: string
  answers: Array<string | string[]>
}
/** plan.respond 参数（交互座 4c-3）：批准 = 关计划开关（档位不动）；拒绝可附反馈（开关保持开） */
export interface PlanRespondParams {
  requestId: string
  approved: boolean
  /** 拒绝反馈（进工具结果给模型，修订后重提）；批准时忽略 */
  message?: string
}

/** 手动重命名；title 为去首尾空白的非空单行标题，返回落盘后的完整摘要。 */
export interface SessionRenameParams {
  sessionId: string
  title: string
}
export interface SessionRenameResult {
  summary: SessionSummary
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
 * 会话级权限切换（「完全访问」按钮，docs/模块/审批与权限.md）：引擎在
 * beforeToolCall 判定矩阵里消费 permissionMode。返回更新后的完整摘要。
 */
export interface SessionSetPermissionParams {
  sessionId: string
  mode: PermissionMode
}
export interface SessionSetPermissionResult {
  summary: SessionSummary
}

/**
 * 计划模式开关（正交于权限档）：UI 计划钮/菜单开关项的引擎通道。开关变化经
 * session.summaryChanged 事件北向广播（enter_plan 工具与手动 toggle 同路）。
 */
export interface SessionSetPlanModeParams {
  sessionId: string
  enabled: boolean
}
export interface SessionSetPlanModeResult {
  summary: SessionSummary
}

/**
 * 手动压缩（D7；未来 /compact 命令的引擎通道）：
 * 无论阈值直接压缩。会话回复中拒绝（上游手动路会先 abort 再压，我们选择
 * 拒绝 —— 显式让用户等，比静默打断正在生成的回复更可预期）。无可压缩
 * （刚压过/过短）返回错误而非空成功 —— 手动动作要明确反馈。
 */
export interface SessionCompactParams {
  sessionId: string
}
export interface SessionCompactResult {
  /** 压缩前上下文估算（与触发判定同源） */
  tokensBefore: number
  /** 压缩后上下文估算（指示器回落依据） */
  tokensAfter: number
}

/**
 * 手动续写（截断动作条「继续生成」的引擎通道）：对末条
 * stopReason=length 的回复注入显式 continue 指令再跑（与自动路同消息同
 * 循环，续写预算重新给满）。会话回复中拒绝；末条非截断拒绝（明确结果）。
 * 事件面 = 新一段 run.started → message.delta… → run.completed。
 */
export interface SessionContinueParams {
  sessionId: string
}
export interface SessionContinueResult {
  ok: true
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
  /**
   * 项目级默认权限模式（审批面板「允许，并切换为」落位，zcode 同款语义：
   * 同一项目的新会话沿用）。缺省 = 未设置（新会话回落全局设置/ask）。
   */
  defaultPermissionMode?: PermissionMode
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

/** 项目编辑（改名 + 目录增删一次提交；编辑弹窗走此方法，rename 保留给纯改名场景）。
    cwds 语义同 create：全量替换（≥1，首个 = 主根）—— UI 编辑表单本就是整表提交 */
export interface ProjectUpdateParams {
  projectId: string
  name: string
  cwds: string[]
}
export interface ProjectUpdateResult {
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
 * 思考等级（pi ThinkingLevel 的子集；off 是"关闭思考"，不属于"支持的等级"，
 * 故 ModelDef.thinkingLevels 选档集不含它 —— off 的可用性走 thinkingLevelMap
 * 默认规则，不归用户选档管）。
 * 引擎按选中集构建 thinkingLevelMap：选中的等级原值透传，未选中的置 null（显式不支持）。
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 完整档位（含 'off' = 关闭思考）：支持档枚举（thinkingLevels）与 agent.submit 值域共用 */
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
  /**
   * 压缩参数覆盖 —— 盘上兼容字段：压缩内核 = pi（触发线 pi reserve 制，
   * 引擎按窗口自适应，见 runtime/compaction.ts piTriggerRatio），本覆盖
   * pi 不读、引擎不消费，仅为旧盘上数据保留。调压缩行为的正道：pi
   * settings（compaction.reserveTokens/keepRecentTokens）。
   */
  compaction?: CompactionParamsOverride
  /**
   * 思考预算（token 按档位）：推理模型的思考硬钳制，防小窗
   * 输出预算被思考吃光（死锁复盘的第四环）。字段全可选，缺省跟 pi 内建
   * 预算表。设置 UI 收在「高级」折叠。
   */
  thinkingBudgets?: ThinkingBudgetsOverride
}

/**
 * 压缩触发参数的用户覆盖（ModelDef.compaction 的形状）—— 盘上兼容字段：
 * pi 不读（触发线 = ctx − reserve，reserve 按窗口自适应）；仅为旧盘上
 * 数据兼容保留。生效公式见 runtime/compaction.ts piTriggerRatio。
 */
export interface CompactionParamsOverride {
  /** 占比触发线 (0,1] */
  thresholdRatio?: number
  /** 绝对余量下限（token） */
  roomFloorTokens?: number
}

/**
 * 思考预算（token，按档位）：自托管 openai 系端点（vLLM/Qwen/
 * DashScope/SGLang/llama.cpp）的硬钳制 —— 引擎按当前思考档取预算并夹到
 * 输出余量（pi clampThinkingBudgetToAnswerRoom，答案保底 1024）。pi
 * ThinkingBudgets 的协议镜像；xhigh/max 档 pi 侧归 high（clampReasoning）。
 * 下发到请求体的字段名由 provider 的 compat.thinkingTokenBudgetField 决定。
 */
export interface ThinkingBudgetsOverride {
  minimal?: number
  low?: number
  medium?: number
  high?: number
}

/**
 * provider 级兼容覆盖：面向懂端点用户的高级面（设置页「高级」
 * 折叠），字段与 pi OpenAICompletionsCompat 同名直通 —— 未设置时 pi 按
 * baseUrl 自动探测。仅 openai 系方言消费（anthropic 走官方 budget_tokens，
 * 不经此面）。
 */
export interface ProviderCompatDef {
  /** 思考预算的请求体字段名（自托管方言三选）；缺省不发预算字段 */
  thinkingTokenBudgetField?: 'thinking_budget' | 'thinking_budget_tokens' | 'thinking_token_budget'
  /** thinkingTokenBudgetField 的简写：置 true 等价 'thinking_token_budget' */
  supportsThinkingTokenBudget?: boolean
  /** max_tokens 字段名（部分网关只认其一） */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
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
   * （最通用的兼容方言）。baseUrl 拼法随方言：openai 系两方言走官方 OpenAI
   * SDK，只在 baseUrl 后拼 /chat/completions 或 /responses —— baseUrl 要带
   * /v1；anthropic-messages 走官方 Anthropic SDK，自拼 /v1/messages ——
   * baseUrl 填根地址。部分网关按路由放行模型权限（2026-11-10 实测：同一
   * key+模型仅 /v1/responses 可用），三方言即三套可选端点路径。
   */
  apiFormat?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /** 禁用模型（models/modelDefs 的子集）：sync 时不注册进 provider，目录/下拉自然不出现 —— 可逆开关的数据面 */
  disabledModels?: string[]
  /** 整 provider 禁用：保留定义不注册（再启用即恢复），区别于 deleteProvider 的彻底移除 */
  disabled?: boolean
  /**
   * 端点兼容覆盖（高级面）：字段与 pi OpenAICompletionsCompat
   * 同名直通，作用于本 provider 全部模型（pi 上游 models.json 的
   * ProviderConfig.compat 同位）。仅 openai 系方言消费；未设置时 pi 按
   * baseUrl 自动探测
   */
  compat?: ProviderCompatDef
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

// ———— MCP 座（阶段 4a：Host 管理的 MCP 客户端配置）————

/**
 * MCP 工具的暴露档（pi McpExposure 的协议镜像，零运行时依赖手写）：
 * direct = 工具直接声明给模型（Cogent 默认档）；deferred/codemode 依赖
 * tool_search/codemode 工具（Cogent 未装载，仅供手改配置的忠实显示）；
 * hidden = 注册但不可达。
 */
export type McpExposure = 'direct' | 'deferred' | 'codemode' | 'hidden'

/**
 * MCP server 定义（mcp.sync 的载荷项）：pi-mcp `mcpServers` 通用形状的
 * 协议展开 —— stdio/http 判别联合 + name 显式字段（盘上文件以 name 为键，
 * 协议里展开成数组项便于逐项校验）。存盘时由引擎折回通用形状
 * （与生态互拷，见 docs/模块/MCP座.md）。
 */
export type McpServerDef = { name: string } & (
  | {
      type: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
    }
  | {
      type: 'http'
      url: string
      headers?: Record<string, string>
    }
) & {
    description?: string
    /** 缺省 true */
    enabled?: boolean
    /** 缺省 direct（UI 表单恒显式下发；盘上手改缺省按 pi 的 codemode 显示） */
    exposure?: McpExposure
    /** 每请求超时秒数（缺省 60） */
    timeout?: number
  }

/** mcp.list 的 server 摘要（设置页卡片行 + 编辑表单数据源） */
export interface McpServerSummary {
  name: string
  type: 'stdio' | 'http'
  /** 一行展示：stdio = command + args；http = url */
  detail: string
  description?: string
  enabled: boolean
  exposure: McpExposure
  /**
   * 完整定义（4a-2：编辑表单的回填源）。摘要字段是显示口径（含缺省化），
   * 编辑要以用户写入的原值为基 —— def 即盘上条目折回的协议形状。
   */
  def: McpServerDef
  /**
   * 项目 override 已作用于该项（list 带 cwd 时的合并视图口径）：enabled/
   * exposure 是生效值（用户级原值仍在 def）。缺省 = 无 override 或本就是
   * 用户级视图。
   */
  overrideApplied?: boolean
  /** 项目 override 文件里该项的原样内容（list 带 cwd 时；overrideApplied 才有） */
  override?: { enabled?: boolean; exposure?: McpExposure }
}

export interface McpListResult {
  servers: McpServerSummary[]
  /**
   * 配置文件诊断（损坏 JSON / 非法条目 / 项目级越权条目）：不炸列表，
   * 逐条列出供 UI 呈现 —— 配置文件是外部输入（约定.md §1.1 持久化读取）
   */
  errors: string[]
}

/**
 * 全量写项目级 override（mcp.override，作用域管理批次）：**全量替换**该项的
 * 项目 override —— 传入键写入 <cwd>/.cogent/mcp.json，空 patch = 清除该项
 * override（回落用户级定义）。UI 从 list 的 override 字段起步改一键再整发。
 */
export interface McpOverrideParams {
  cwd: string
  name: string
  enabled?: boolean
  exposure?: McpExposure
}
export interface McpOverrideResult {
  ok: true
}

/** 全量同步 user 级定义（替换语义，与 providers.custom.sync 同构） */
export interface McpSyncParams {
  servers: McpServerDef[]
}
export interface McpSyncResult {
  synced: number
}

// ———— 技能座（阶段 4b，docs/模块/技能座.md）————
//
// 技能 = 目录里的 SKILL.md 指令包（pi Agent Skills 生态形状），Host 管
// 两个受管目录的发现/启停/编辑；进入会话走「清单进系统提示段、正文模型
// read 自取」的渐进加载（pi 原生语义），段由 before_agent_start 钩子
// 每回合活算（热刷新）。

/** 技能定义所在作用域（由目录决定：~/.cogent/skills 或 <cwd>/.cogent/skills） */
export type SkillScope = 'user' | 'project'

/** skills.list 的技能摘要（设置页卡片行数据源） */
export interface SkillSummary {
  name: string
  description: string
  scope: SkillScope
  /** SKILL.md 绝对路径（渐进加载的 read 入口，UI 展示用） */
  path: string
  /** 技能目录（references/ 等相对资源的锚点） */
  baseDir: string
  /** frontmatter disable-model-invocation：不进模型清单，仅 /skill: 手动可调 */
  manualOnly: boolean
  /** 两级启停求值后的生效值（清单注入按此过滤） */
  enabled: boolean
  /** user 级禁用名单命中（项目覆盖重新启用时 enabled=true 但此项仍为 true） */
  userDisabled: boolean
  /** 项目级状态文件对本名的显式覆盖（缺省 = 无覆盖，回落 user 名单） */
  override?: boolean
  /** 来自 .agents 生态兼容目录（zcode 等工具装的）：只读发现 + 按名启停，
   *  新建/编辑/删除归原工具（写路径只在 .cogent） */
  eco?: boolean
}

export interface SkillListResult {
  skills: SkillSummary[]
  /**
   * 发现/状态文件诊断（坏 frontmatter、名字非法、同名冲突、损坏 JSON）：
   * 不炸列表逐条带回（约定.md §1.1 持久化读取）
   */
  errors: string[]
}

/** 新增/编辑一枚技能（skills.save）：frontmatter 由引擎生成（防手写错） */
export interface SkillSaveParams {
  scope: SkillScope
  /** scope=project 时必填（项目技能目录所在的工作区主根） */
  cwd?: string
  /** 名字规则镜像 pi validateName：1-64、^[a-z0-9-]+$、无首尾/连续连字符 */
  name: string
  /** 1-1024 chars（pi validateDescription 同款） */
  description: string
  /** 正文 Markdown，不含 frontmatter */
  body: string
}

export interface SkillDeleteParams {
  scope: SkillScope
  /** scope=project 时必填 */
  cwd?: string
  name: string
}

/** 写启停状态（skills.setEnabled）：user 档写禁用名单，project 档写 overrides */
export interface SkillSetEnabledParams {
  scope: SkillScope
  /** scope=project 时必填 */
  cwd?: string
  name: string
  /**
   * enabled/disabled = 显式两态；project 档多一档 inherit = 清除该名覆盖
   * （回落 user 名单求值）。user 档无更上层可回落，inherit 非法。
   */
  value: 'enabled' | 'disabled' | 'inherit'
}

export interface SkillWriteResult {
  ok: true
}

/** 读单枚技能正文（skills.read）：编辑表单回填源（list 不带 body —— 正文可能很大） */
export interface SkillReadResult {
  description: string
  /** 去 frontmatter 的正文 Markdown */
  body: string
}

export interface InspectEntriesParams {
  sessionId: string
}
export interface InspectEntriesResult {
  /** 按 seq 升序；首条 seq > 0 即更早条目已被 ring 滚动丢弃 */
  entries: InspectEntrySummary[]
}

export interface InspectEntryParams {
  sessionId: string
  seq: number
}

// ———— 运行时控制台（inspect 域，2026-11-10）————
//
// 学习导向的观测通道：把引擎每一步底层动作（厂商请求体 / SSE 分片 / 引擎循环 /
// 工具执行）以"摘要事件 + 按需详情"两段式暴露给宿主的控制台 UI。
// 设计动机（与聊天事件的分野）：聊天事件（run.*/message.*）服务对话 UI，只暴露
// 用户可读的投影；inspect 域服务"想看引擎内部怎么跑"的学习场景，暴露的是
// 尽可能原始的底层形状 —— 两者数据同源但形态不同，不共用事件。

/**
 * 观测条目类型。五层结构（UI 据此分色/过滤，也是学习路径的解剖层次）：
 * - 会话层 run.*：一次 agent.submit 的完整生命周期；
 * - 提示词 system.prompt：本轮请求实际生效的系统提示词全文；
 * - 引擎层 turn.*：pi Agent 循环的轮次边界（一 run 内可多轮 = 工具循环）；
 * - 接口层 api.*：pi→厂商的原始 HTTP 往返（请求体 / 响应头 / SSE 分片聚合）；
 * - 工具层 tool.*：工具执行的参数与结果；
 * - 审批层 approval.*：审批往返审计对（asked/decided 成对，放行也留痕，
 *   钩子座 4d —— read 类不经审批域，不产生条目）。
 */
export type InspectEntryKind =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'system.prompt'
  | 'turn.started'
  | 'turn.completed'
  | 'api.request'
  | 'api.response'
  | 'api.stream'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.progress'
  | 'approval.asked'
  | 'approval.decided'

/**
 * 观测条目摘要（时间线一行）。刻意小体积：控制台未打开时引擎也在实时推送，
 * 摘要是常流，完整 payload 走 inspect.entry 按需拉取 —— 否则长对话的请求体
 * （几百 KB 上下文）会把 stdio 事件流打爆。
 */
export interface InspectEntrySummary {
  /** 会话内单调递增序号（inspect.entry 的取详情键） */
  seq: number
  /** 事件时刻（Unix 毫秒） */
  ts: number
  kind: InspectEntryKind
  /** 所属 run 序号（第几次 agent.submit，从 1 起）；时间线按它分组折叠 */
  run: number
  /** 一行摘要（时间线主文案） */
  title: string
  /** 键值对概览（时间线次级信息 + 详情面板顶部表格共用源） */
  overview?: Array<{ label: string; value: string }>
  /** 是否有可按需拉取的详情（api.request 的请求体、system.prompt 的全文…） */
  hasDetail: boolean
}

/** 观测条目详情：命名数据块（详情面板按块分 Tab/分节渲染） */
export interface InspectEntryDetail {
  seq: number
  /** 块名即渲染标签；json 块引擎侧已 pretty-print，text 块原样文本 */
  blocks: Array<{ name: string; format: 'json' | 'text'; content: string }>
}

/**
 * HTTP 门 scope 档位（D3，阶段 2b）：readonly ⊂ write ⊂ admin 逐级包含；
 * session 绑定档（页面级只碰单会话）留给阶段 3 webview 消费者再落。
 */
export type TokenScope = 'readonly' | 'write' | 'admin'

/** capability.issue（D3 票据签发入口；stdio 血缘 = main 专用语义，HTTP 门需 admin） */
export interface CapabilityIssueParams {
  scope: TokenScope
}
export interface CapabilityIssueResult {
  /** 一次性票据：32B base64url，30s TTL，/auth/exchange 消费即焚 */
  ticket: string
  /** epoch ms；过期即作废（zcode hostCapability 同款语义） */
  expiresAt: number
}

/**
 * method 注册表：键名即线上协议。新增 method = 在此加一行 + 服务端加 handler。
 */
export interface ProtocolMethods extends AttachmentMethods, FileMethods, FileInternalMethods, OutputMethods {
  initialize: { params: InitializeParams; result: InitializeResult }
  'session.list': { params: Record<string, never>; result: SessionSummary[] }
  'session.create': { params: { title?: string; permissionMode?: PermissionMode; planEnabled?: boolean; cwd?: string; projectId?: string }; result: SessionSummary }
  'session.delete': { params: { sessionId: string }; result: { deleted: boolean } }
  'session.messages': { params: SessionMessagesParams; result: SessionMessagesResult }
  'session.setPinned': { params: SessionSetPinnedParams; result: SessionSetPinnedResult }
  'session.rename': { params: SessionRenameParams; result: SessionRenameResult }
  'session.listArchived': { params: Record<string, never>; result: SessionSummary[] }
  'session.archive': { params: SessionArchiveParams; result: SessionArchiveResult }
  'session.setPermission': { params: SessionSetPermissionParams; result: SessionSetPermissionResult }
  'session.setPlanMode': { params: SessionSetPlanModeParams; result: SessionSetPlanModeResult }
  'session.compact': { params: SessionCompactParams; result: SessionCompactResult }
  'session.continue': { params: SessionContinueParams; result: SessionContinueResult }
  'project.list': { params: Record<string, never>; result: ProjectSummary[] }
  'project.create': { params: ProjectCreateParams; result: ProjectCreateResult }
  'project.rename': { params: ProjectRenameParams; result: ProjectRenameResult }
  'project.update': { params: ProjectUpdateParams; result: ProjectUpdateResult }
  'project.delete': { params: ProjectDeleteParams; result: ProjectDeleteResult }
  'project.setPinned': { params: ProjectSetPinnedParams; result: ProjectSetPinnedResult }
  'agent.submit': { params: AgentSubmitParams; result: AgentSubmitResult }
  'agent.abort': { params: { sessionId: string }; result: { aborted: boolean } }
  'approval.respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
  /** 交互座 4c-2：回答 question.asked（挂起中的 ask_user）；配对错 requestId → InvalidParams */
  'question.respond': { params: QuestionRespondParams; result: { ok: true } }
  /** 交互座 4c-3：裁决 plan.requested（批准切档 / 拒绝附反馈）；带回切换后的会话摘要 */
  'plan.respond': { params: PlanRespondParams; result: { ok: true; summary?: SessionSummary } }
  'credentials.set': { params: CredentialsSetParams; result: CredentialsSetResult }
  'credentials.remove': { params: CredentialsRemoveParams; result: CredentialsRemoveResult }
  'credentials.list': { params: Record<string, never>; result: CredentialsListResult }
  'models.list': { params: Record<string, never>; result: ModelsListResult }
  /** 独立连通性探测：使用已保存配置，不创建会话；网络失败由统一错误帧返回。 */
  'models.test': { params: { providerId: string; modelId: string }; result: { elapsedMs: number } }
  'providers.custom.sync': { params: ProvidersCustomSyncParams; result: ProvidersCustomSyncResult }
  /** MCP 座：server 摘要 + 配置诊断（缺省 user 级视图；带 cwd = 项目合并视图） */
  'mcp.list': { params: { cwd?: string }; result: McpListResult }
  /** MCP 座：全量写 user 级定义（新增/编辑/删除/导入的写路径） */
  'mcp.sync': { params: McpSyncParams; result: McpSyncResult }
  /** MCP 座：全量替换某项的项目级 override（空 patch = 清除回落用户级） */
  'mcp.override': { params: McpOverrideParams; result: McpOverrideResult }
  /** 技能座：技能摘要 + 发现诊断（带 cwd = 两级合并视图） */
  'skills.list': { params: { cwd?: string }; result: SkillListResult }
  /** 技能座：读单枚技能正文（编辑表单回填；zcode skills inspect 同位） */
  'skills.read': { params: SkillDeleteParams; result: SkillReadResult }
  /** 技能座：新增/编辑一枚技能（写 SKILL.md；frontmatter 引擎生成） */
  'skills.save': { params: SkillSaveParams; result: SkillWriteResult }
  /** 技能座：删除技能目录（含目录内附带资源） */
  'skills.delete': { params: SkillDeleteParams; result: SkillWriteResult }
  /** 技能座：写启停状态（user 名单 / project overrides） */
  'skills.setEnabled': { params: SkillSetEnabledParams; result: SkillWriteResult }
  /** 控制台：拉会话的观测条目摘要（时间线数据源；ring 上限内全量，超出只留最近） */
  'inspect.entries': { params: InspectEntriesParams; result: InspectEntriesResult }
  /** 控制台：按 seq 拉单条详情（请求体全文 / SSE 分片 / 系统提示词…） */
  'inspect.entry': { params: InspectEntryParams; result: InspectEntryDetail }
  /** HTTP 门票据签发（D3）：main 经 stdio 发起（血缘全权），Host 存证 */
  'capability.issue': { params: CapabilityIssueParams; result: CapabilityIssueResult }
}

// ———— 事件映射（host → 宿主；骨架期先定形状，随实现细化） ————

export interface ProtocolEvents {
  'outputs.updated': TurnOutputs
  'outputs.error': { sessionId: string; turnId: string; message: string }
  'files.invalidated': Record<string, never>
  'run.started': { sessionId: string; turnId?: string }
  'run.completed': {
    sessionId: string
    /** 最终完整 assistant 回复；renderer 用它替换流式累积，免拼 delta */
    message?: ChatMessage
    /**
     * 分段终态（2026-11-10 additive，工具循环落地）：一个 run 在 pi 里是多轮
     * 循环（assistant(toolCall) → toolResult → assistant(text)…），按发生序
     * 逐段投影 —— 宿主用它替换流式占位可保真 text 与工具卡的交错顺序。
     * message 保持聚合形态（全轮 text 拼接 + toolCalls 合并）：老宿主只读
     * message 不破，新宿主优先 messages。
     * 手动续写沿同一用户回合展示：快照也包含此前assistant前缀及其原用量，
     * 避免宿主整段替换时丢旧回答；本run新增工作观测仍由Host单独记账。
     */
    messages?: ChatMessage[]
    /**
     * pi 停止原因（stop/length/toolUse…）。length = 输出被 token 上限截断
     * （模型上限或端点侧强制上限），UI 据此提示"回复被截断"——截断不是错误，
     * pi 也按正常结束处理，不透出就无从呈现。
     */
    stopReason?: string
  }
  'run.failed': {
    sessionId: string
    message: string
    /** run 级终态原因；缺省按 error 消费，不能用宿主停止按钮或错误文本猜中止。 */
    reason?: 'aborted' | 'error'
    /**
     * 本次显示替换范围的完整终态分段快照，包含 aborted/error 封存尾段；
     * 手动续写还包含此前assistant前缀，不能用空快照删除已有截断正文。
     * 字段在场时直接替换，空数组也是权威结果，不再续接宿主流式占位以免重复；
     * 装配/prompt 前置拒绝等未提供完整快照的路径缺省，宿主沿旧失败收尾。
     */
    messages?: ChatMessage[]
  }
  /**
   * 轮终实报落地（additive）：工具循环的每个 turn_end 发一份
   * 本轮端点实报 usage —— 上下文指示器在 run 进行中实时跟随（此前 usage
   * 只随 run.completed 落账，run 内多轮工具时指示器全程冻结在 run 前的值，
   * 中途触发的压缩看起来"远未到线"）。run 终态后以 segments 内的 usage
   * 为准；compaction.completed 时宿主应弃置 live 值（切压缩后估算）。
   */
  'context.updated': { sessionId: string; usage: MessageUsage }
  /**
   * 流式增量（同一条 assistant 消息内按 kind 分流）：
   * - 'text'（缺省，兼容不带 kind 的旧引擎）：正文增量；
   * - 'thinking'：思考增量（模型开了思考且未结束时先于正文产生）。
   * 同 messageId = 同一条消息的两路累积缓冲，宿主各自拼接。
   */
  'message.delta': { sessionId: string; messageId: string; delta: string; kind?: 'text' | 'thinking' }
  /**
   * 工具开始执行。pi 时序：本事件先于 beforeToolCall 审批钩子发出 —— 写类
   * 工具挂起期间宿主先见 running 卡，随后 approval.request 到达；拒绝/中止后
   * 经 tool.completed(isError) 收口，卡翻 error 态（与历史回查投影同一形状）。
   * summary = 参数一行摘要（引擎生成），工具卡标题与审批卡共用。
   */
  'tool.started': { sessionId: string; callId: string; name: string; kind: ToolKind; summary?: string }
  /**
   * 工具执行结束：summary = 结果一行摘要（截断；错误/拒绝时为原因）。
   * isError 含审批拒绝/中止（blocked 语义在 status 维度，事件里不细分 ——
   * 宿主若关心可在 ChatMessage.toolCalls.status 看到）。
   * diff = edit 工具的展示 diff（与 ToolCallRecord.diff 同源，流式路径数据源，
   * 2026-11-11 additive）。
   */
  'tool.completed': { sessionId: string; callId: string; isError: boolean; summary: string; diff?: string; fileRefs?: FileReference[] }
  /**
   * 工具执行中的流式进度（D5 定稿，additive）：长时工具
   *（当前 = bash）的尾部输出快照，引擎侧 100ms 节流。text = 滚动快照全文
   *（非增量 delta —— 快照语义让 UI 无需自己累积/截断，直接整段替换渲染）。
   * 宿主按 callId 配对到 tool.started 建的工具卡。
   */
  'tool.progress': { sessionId: string; callId: string; text: string }
  /** 审批请求：宿主（最终是用户）裁决后以 approval.respond 回复 */
  'approval.request': {
    sessionId: string
    requestId: string
    toolName: string
    kind: ToolKind
    summary: string
    /**
     * 写类目标在工作区根之外（ask 越界写照常弹面板、用户允许即执行 ——
     * 人是最终裁决者；宿主据此隐藏「始终允许此工作区」：规则是根内信任
     * 记忆，永不覆盖越界）。缺省 = false。
     */
    outsideRoots?: boolean
  }
  /**
   * 任务清单更新（交互座 4c）：todo_write 每次落笔即推全量清单（快照语义，
   * 宿主整段替换渲染）。TodoStrip 的运行中增量源；打开会话的种子走
   * session.messages 的 todos 字段。
   */
  'todos.updated': { sessionId: string; todos: TodoItem[] }
/**
 * 模型提问（交互座 4c-2）：ask_user 工具挂起中 —— 宿主以 question.respond
 * 回答（面板替换输入区，与 approval.request 同款"占位等待"语义；无超时，
 * 宿主输入框变停止钮可 abort）。answers 按问题序，空串 = 跳过该问。
 */
'question.asked': { sessionId: string; requestId: string; questions: AskQuestionParam[] }
  /**
   * 方案审批请求（交互座 4c-3）：submit_plan 工具挂起中 —— 宿主以 plan.respond
   * 裁决（批准 = 关计划开关，档位不动 / 拒绝可附反馈，开关保持开）。
   * plan = 方案全文（markdown，面板预览）。
   */
  'plan.requested': { sessionId: string; requestId: string; plan: string }
  /**
   * 会话摘要变化广播（正交开关 v3 起）：permissionMode / planEnabled 任何引擎侧
   * 变化（手动切换、enter_plan 工具、plan.respond 批准）即推全量摘要 —— 宿主
   * 替换列表项，权限钮/计划钮即时联动（此前只有 RPC 返回值一条路，引擎内
   * enter_plan 开关 UI 无从得知）。
   */
  'session.summaryChanged': { summary: SessionSummary }
  /**
   * 观测条目实时推送（控制台时间线增量）：每产生一条观测记录即推一条摘要，
   * 详情不随流走（按需 inspect.entry）。宿主的控制台没打开也应照常接收/丢弃 ——
   * 引擎侧记录常开，打开时经 inspect.entries 补拉历史。
   */
  'inspect.event': { sessionId: string; entry: InspectEntrySummary }
  /**
   * 上下文压缩开始（D7；pi 内核接管）：reason =
   * threshold（引擎自动阈值）/ manual（session.compact）/ overflow（引擎溢出
   * 恢复路压缩，发生在 run 生命周期内）。摘要生成是一次 LLM 调用（秒级），
   * 宿主可借此呈现压缩中状态。
   */
  'compaction.started': { sessionId: string; reason: 'threshold' | 'manual' | 'overflow' }
  /**
   * 上下文压缩结束（成功/失败共用，看 error 字段）。
   * - summary = checkpoint 摘要全文（宿主折叠条展开可读）；
   * - summarizedUntil = 保留区首条消息 timestamp —— 宿主据此把本地消息
   *   列表里该时刻及之前的条目原位换成折叠条（历史回查路径天然同形态）；
   * - tokensBefore/After = 前后上下文估算（指示器回落依据）。
   * 失败时 tokens/summary 缺省、error 带原因；自动路失败不拦后续 prompt
   * （尽力语义），手动路失败走 session.compact 的错误响应帧。
   */
  'compaction.completed': {
    sessionId: string
    reason: 'threshold' | 'manual' | 'overflow'
    tokensBefore?: number
    tokensAfter?: number
    summary?: string
    summarizedUntil?: number
    /** 摘要请求的用量（D9 验收后增补）：摘要是一次独立 LLM 调用，其 token/
     *  成本不进 run 分段账 —— 经此显式带给宿主呈现（折叠条小字），端点
     *  未报 usage 时缺省 */
    summaryUsage?: MessageUsage
    error?: string
  }
  /**
   * L1 工具结果裁剪（additive）：检查点内 L2 摘要前的确定性降载 ——
   * 全转录超限（8192 code point）的 toolResult 原位改写为保头 4096 / 保尾
   * 1024 + middle 替换 marker，零 LLM 成本。压缩由 pi 内核接管，
   * 引擎不再发射本事件（合同保留供老宿主；pi 的等价能力是压缩时全转录进摘要）。
   */
  'compaction.pruned': {
    sessionId: string
    entries: Array<{
      toolCallId: string
      /** 裁剪前文本总量（code point，跨全部 text 块） */
      originalChars: number
      /** 裁剪后文本总量（头 + marker + 尾） */
      prunedChars: number
    }>
  }
}
