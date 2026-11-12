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
import { contentText, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model, MutableModels, Usage } from '@earendil-works/pi-ai'
// 上下文粗估（2026-11-11 明细区）：与 pi clampMaxTokensToContext 同一实现 ——
// 引擎每轮算 max_tokens 预算用的就是 estimateContextTokens，明细口径与之同源
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import { getSystemMessageText } from '@earendil-works/pi-ai/utils/text'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProtocolError, RpcErrorCode } from '../../protocol'
import type {
  ChatMessage,
  ContextEstimate,
  CustomProviderDef,
  InspectEntryDetail,
  InspectEntrySummary,
  MessageUsage,
  ModelSummary,
  PermissionMode,
  ProviderOverrideDef,
  ProtocolEvents,
  SessionSummary,
  ToolCallRecord,
  ToolKind
} from '../../protocol'
import type { CredentialRegistry } from './credentials'
import { CustomProviderRegistry } from './custom-providers'
import { SessionInspector } from './inspector'
import type { ProjectRegistry } from './project'
import type { ApprovalRegistry } from './approvals'
import {
  buildSummarizationContext,
  buildSummarizationInstruction,
  compactionThreshold,
  convertToLlmMessages,
  KEEP_RECENT_TOKENS,
  prepareCompaction,
  pruneToolResults,
  applyCompactionInPlace,
  rebuildTranscript,
  shouldCompact,
  summarizationFailure,
  summarizationThinkingLevel,
  formatFileOperations,
  type CompactionPreparation
} from './compaction'
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
    'grep（按正则全文搜索，可带上下文行）、ls（列目录一层内容）、' +
    'write（整文件写入，须在可写根内，执行前可能需要用户批准）、' +
    'edit（对已有文件做精确文本替换，边界同 write，执行前可能需要用户批准）、' +
    `bash（执行 shell 命令${process.platform === 'win32' ? '，Windows 上为 PowerShell 语法' : ''}，工作目录${bound ? '为工作区主根' : '为用户主目录'}，执行前可能需要用户批准）。` +
    '先用 ls/glob/grep 定位、再用 read 读内容；修改已有文件优先 edit（带上下文精确匹配），' +
    '整文件新建或重写才用 write。\n' +
    `${base}；读取的绝对路径不限位置，写入只能在${bound ? '工作区根目录内' : '用户主目录内'}。`
  return prompt
}

/**
 * 权限模式通告文本（D6，plan 随权限菜单首次真接线）：ask 是缺省行为不声明，
 * 只讲例外。通告不进 buildSystemPrompt（leading 固化后运行中切换改不动），
 * 而是作为独立 system 消息落在 transcript —— pi 的 systemPrompt 是全部
 * system 消息的重放拼接，各方言组装请求时会把中部 system 合并到领头
 * （pi-ai collapseSystemMessages），追加是官方支持的改提示词通道。
 */
const PERMISSION_NOTICE_PREFIX = '[cogent:permission]'

/**
 * 续写注入消息(R6③,Claude Code 的 append 式续写取向):显式 user 消息让
 * 模型明确「从截断处接着写」—— pi 的无痕 finishTurn{continue} 续跑可能开
 * 新话题。带 [cogent:continue] 前缀:投影层据此跳过成泡并把相邻 assistant
 * 段合并(保真在转录,聚合在投影);LLM 侧原样可见(它是引出续文的正当
 * 提示)。上限 3 次 —— 连环 length 时闸住,升级 UI 动作条交还用户
 */
const AUTO_CONTINUE_PREFIX = '[cogent:continue]'
const AUTO_CONTINUE_MESSAGE = `${AUTO_CONTINUE_PREFIX} Continue your previous response from exactly where it was cut off. Do not repeat what you already wrote, do not apologize or explain — just continue seamlessly.`
const AUTO_CONTINUE_LIMIT = 3

function permissionNotice(mode: Exclude<PermissionMode, 'ask'>): string {
  const body =
    mode === 'plan'
      ? '# 权限\n你处于 plan（只读）模式：写类工具一律被阻止。只做阅读、分析与方案输出，不修改任何文件。'
      : mode === 'autonomous'
        ? '# 权限\n你处于自主模式：文件修改直接执行；shell 命令属于风险操作，执行前需用户逐次确认。'
        : '# 权限\n用户已授予完全访问：写类工具直接执行，无需用户逐次确认。'
  return `${PERMISSION_NOTICE_PREFIX}\n${body}`
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

/**
 * 工具结果 details → 展示 diff（edit 工具专用，D4 定稿进协议）。流式路径从
 * tool_execution_end 的 result 取，历史回查从 toolResult 消息的 details 取
 * （pi 转录持久化 details）—— 两条路径同源同形。非 edit / 无 diff 自然
 * 返回 undefined（协议 optional，UI 不渲染）。
 */
function extractResultDiff(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const details = (result as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return undefined
  const diff = (details as { diff?: unknown }).diff
  return typeof diff === 'string' ? diff : undefined
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

/**
 * 上下文明细三段估算（悬浮卡分类区数据源，2026-11-11）。
 *
 * 为什么用 pi 的 estimate 而不是自己数：clampMaxTokensToContext（simple-options.js）
 * 每轮算 max_tokens 预算用的就是 estimateContextTokens —— 明细与引擎真实预算
 * 同源自洽，这是 tiktoken/count_tokens 都给不了的（另一套词表对真实预算反而失真）。
 * 代价：3.5 chars/token 的字符粗估对中文偏松，UI 据此带 ≈ 标记。
 *
 * 三段拆法：pi 把系统提示词与工具声明合并放在 leading system message
 * （toolsAdded 字段，estimateMessageTokens 对 system 消息 = 文本 + 工具 schema），
 * 按字段拆开各算各的；其余消息（user/assistant/toolResult）全归"消息"段。
 * total 直接取 estimateContextTokens().tokens（= 末轮实报 usage + 其后 trailing
 * 估算，即预算式里的"占用"），保证三段和与引擎看到的占用一致。
 *
 * 无对话时（首问前）estimateContextTokens 返回 0/无 usage 锚点，照常算 ——
 * 调用方只在回合结束（有 usage）时才挂到消息上，空转录不会走到这。
 */
function estimateContext(messages: AgentMessage[]): ContextEstimate {
  // 先过 convertToLlmMessages：批次 4 起转录可能含 compactionSummary 自定义
  // 角色（无 content 数组），pi-ai estimateMessageTokens 对它不认识会炸；
  // 转换后与引擎 max_tokens 预算看到的载荷同源同形（预算口径只可能更准）
  const llmMessages = convertToLlmMessages(messages)
  let systemPrompt = 0
  let toolDefs = 0
  const rest: ReturnType<typeof convertToLlmMessages> = []
  for (const message of llmMessages) {
    if (message.role === 'system') {
      // content 可能是 string 或 TextContent[]；getSystemMessageText 统一成
      // 模型可见的完整文本（含 sections 渲染），与 estimate 内部口径一致
      systemPrompt += estimateTextTokens(getSystemMessageText(message))
      if (message.toolsAdded) toolDefs += estimateTextTokens(JSON.stringify(message.toolsAdded))
      continue
    }
    rest.push(message)
  }
  return {
    systemPrompt,
    toolDefs,
    messages: rest.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
    total: estimateContextTokens(llmMessages).tokens
  }
}

/** 盘上文档格式版本（将来字段演进据此迁移，同 credentials.json 的 version 手法） */
const SESSION_FILE_VERSION = 1
/** 会话集合名（StorageDriver 顶层目录 ~/.cogent/sessions/） */
const SESSION_COLLECTION = 'sessions'
/** 首条消息截断为会话标题的长度上限 */
const TITLE_MAX_CHARS = 24
/** 拒绝附言截断上限（D2：防长附言打爆工具结果，与 D8 截断纪律同源） */
const APPROVAL_MESSAGE_MAX_CHARS = 2_000
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
   * 压缩进行中的会话（并发护栏，批次 4）：摘要发生在 prompt 之前 —— pi 尚未
   * 置 isStreaming，submit 的忙碌检查在压缩窗口内裸奔；窗口期第二个 submit 会
   * 与首个 run 的压缩/prompt 交错（双压缩 + 双 prompt）。入集/出集在
   * runCompaction 的同步段/finally，submit 与 compactSession 都先查它
   */
  private compacting = new Set<string>()
  /**
   * 溢出恢复单次闸(完备化 R5,pi _overflowRecoveryAttempted 同款):provider
   * 报 context overflow → 删失败轮 → L1/L2 → 原请求重试一次;闸住防「压缩
   * 没压下来 → 再溢出 → 再压缩」的循环。每次用户 submit 重置(新一轮用户
   * 输入重新获得一次恢复权)
   */
  private overflowRetried = new Set<string>()
  /**
   * length 续写剩余次数(完备化 R6③,按会话):submit/手动续写时重置为 3。
   * agent_end 与 settleRun 两处同读 —— 前者据此抑制终态(预算未尽时续写
   * 还会接着跑),后者据此决定是否注入续写消息
   */
  private continuationBudget = new Map<string, number>()
  /**
   * 挂起中的审批（D4/D5）：approval.request 发出 → beforeToolCall 的 Promise 悬着
   * 等 approval.respond。value 存 sessionId（会话删除/退出时按会话批量收尾 ——
   * 不 resolve 则 pi 的 await 永悬、该 run 永不结束）+ 工具类别（respond 的
   * always='workspace' 落规则时要知道落哪类，审批交互升级 D3）。
   */
  private pendingApprovals = new Map<
    string,
    { sessionId: string; kind: ToolKind; resolve: (result: BeforeToolCallResult) => void }
  >()
  private models: MutableModels
  private customProviders: CustomProviderRegistry
  /** 项目注册表（构造注入；submit/createAgent 时解析 projectId → 项目多根目录） */
  private projects: ProjectRegistry
  /** 审批规则表（构造注入；beforeToolCall ask 判定前查「始终允许此工作区」，D3） */
  private approvals: ApprovalRegistry

  constructor(
    private credentials: CredentialRegistry,
    private storage: StorageDriver,
    private notify: Notify,
    projects: ProjectRegistry,
    approvals: ApprovalRegistry,
    private inspectStore: InspectStore
  ) {
    this.projects = projects
    this.approvals = approvals
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
    this.compacting.delete(sessionId)
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
    const source = session.agent ? session.agent.state.messages : session.transcript
    const projected = this.toChatMessages(source)
    // 上下文明细按需现算挂"末条带 usage 的消息"（历史回查路径，重启/切换会话
    // 走这）：agent_end 只把估算挂到事件侧 streaming 对象随 run.completed 飞走，
    // 盘上 transcript 是 pi 形状（其 Usage 无此字段，塞协议字段会浑浊真源）——
    // 不现算的话明细只在运行当次可见，重启即丢（2026-11-11 用户报障）。
    // estimateContext 是纯转录函数，读时重算幂等、免盘上迁移，旧会话也由此
    // 直接有明细（免"无字段降级"）。挂点 = 从后往前首条带 usage 的 assistant，
    // 与指示器分子的读取序一致；纯工具段末条无正文本体的边角与事件路径同缺
    // （flattenSegments 不落本体），不另补
    for (let i = projected.length - 1; i >= 0; i--) {
      const m = projected[i]
      if (m.role === 'assistant' && m.usage) {
        m.usage = { ...m.usage, contextEstimate: estimateContext(source) }
        break
      }
    }
    return projected
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
      models: this.models.getModels().map((m) => {
        // 有效压缩触发阈值随目录下发（完备化 R1）：指示器预警线画引擎真值，
        // 消灭 renderer 侧 0.9 常量镜像 —— 小窗模型触发线显著前移（20K ≈59%）
        const threshold = compactionThreshold(m.contextWindow, m.compaction)
        return {
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
          userDefined: this.customProviders.isUserDefined(m.provider, m.id),
          // Infinity（窗口缺数据的怪模型）不带 → 渲染端回落 0.9
          ...(Number.isFinite(threshold) && { compactionThresholdRatio: threshold / m.contextWindow })
        }
      })
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
    // 在受理入口显式拒绝成协议错误，而不是放它落进异步段崩进程；压缩窗口同理
    //（见 compacting 字段注释 —— prompt 前的摘要期 isStreaming 还是 false）
    if (agent.state.isStreaming || this.compacting.has(sessionId)) {
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
      // 思考预算跟随模型（完备化 R7）：预算是模型属性，切模型换预算
      agent.thinkingBudgets = target.thinkingBudgets
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
    // catch 只兜"受理检查通过后、pi 尚未发出任何事件前"的启动窗口拒绝 —— 外部世界
    // 失败是常态（约定.md 1.1），必须转成 run.failed 给 UI 一个终态。
    // 压缩（D7 自动路）插在 prompt 之前：超阈值先摘要再发 —— 摘要是一次秒级
    // LLM 调用，事件流此刻是 run.started 已发、首条 delta 未到的窗口，
    // compaction.started/completed 事件就落在这里（宿主可呈压缩中状态）。
    // prompt 落定后进收尾驱动（完备化 R5/R6）：溢出恢复与 length 续写在
    // settleRun 循环里消化，可续跑的失败/截断在 agent_end 已被抑制（不发
    // 终态、streaming 保活）—— UI 全程只看到这一个 run
    this.overflowRetried.delete(sessionId)
    this.continuationBudget.set(sessionId, AUTO_CONTINUE_LIMIT)
    void this.maybeCompactBeforePrompt(session, agent).then(
      () => agent.prompt(text),
      () => undefined
    ).then(() => this.settleRun(session, agent)).catch((error: unknown) => {
      this.streaming.delete(sessionId)
      this.notify('run.failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
    })
  }

  // ———— 上下文压缩（批次 4，D7 双路；纯函数见 runtime/compaction.ts） ————

  /**
   * submit 前的阈值检查(自动路):超线先走 L1→L2 检查链再放行 prompt。压缩
   * 失败不拦提交(尽力语义:摘要服务抖一下不该吞掉用户消息;真溢出会由
   * provider 报错走 run.failed 显式暴露)—— 失败只记 stderr。
   */
  private async maybeCompactBeforePrompt(session: Session, agent: Agent): Promise<void> {
    const model = agent.state.model
    const contextTokens = estimateContextTokens(convertToLlmMessages(agent.state.messages)).tokens
    if (!shouldCompact(contextTokens, model.contextWindow, model.compaction)) return
    await this.compactWithPrune(session, agent, contextTokens)
  }

  /**
   * 检查点内的 L1→L2 链(完备化 R3):先 L1 裁剪(确定性、零 LLM、缓存断点
   * 最少)再重计量,仍超线才 L2 摘要 —— L1 单独够时零摘要请求(microcompact/
   * dsh prune 先行双重验证的路线)。手动路(session.compact)不进此链:用户
   * 点名要的是语义蒸馏,且被摘要区进摘要本就截 2000 字符,L1 对摘要请求无增益。
   * 返回 true = 转录被改动(L1 或 L2 任一落账),轮间钩子据此对齐 loop 工作副本;
   * L2 失败不抛(尽力语义内聚在此,两个检查点共用)。
   */
  private async compactWithPrune(
    session: Session,
    agent: Agent,
    contextTokens: number
  ): Promise<boolean> {
    const sessionId = session.summary.id
    // L1:全转录裁剪(含保留区,dsh pruneSession 同款,取舍见 pruneToolResults 注释)。
    // **原位写回**(同 runCompaction 的 L2:S2 验收 bug —— 轮间钩子触发时 loop
    // 还持着同一数组旧引用,换引用 = 双写分叉);pruneToolResults 无裁剪时返回
    // 原引用,map 出的新数组逐位 splice 回去
    const { messages, pruned } = pruneToolResults(agent.state.messages)
    if (pruned.length > 0) {
      agent.state.messages.splice(0, agent.state.messages.length, ...messages)
      session.transcript = agent.state.messages
      this.persist(sessionId)
      this.notify('compaction.pruned', { sessionId, entries: pruned })
    }
    // 重计量仍超线才 L2;裁剪后 toolResult 变短,估算自然下降,无需记账
    const afterPrune =
      pruned.length > 0
        ? estimateContextTokens(convertToLlmMessages(agent.state.messages)).tokens
        : contextTokens
    if (!shouldCompact(afterPrune, agent.state.model.contextWindow, agent.state.model.compaction)) {
      return pruned.length > 0
    }
    try {
      await this.runCompaction(session, agent, 'threshold', afterPrune)
      return true
    } catch (error) {
      // runCompaction 内已发 completed(error) 事件;此处只补诊断(自动路静默降级),
      // L1 已生效的话转录仍算改动(调用方对齐 loop 副本用的是 agent.state.messages)
      process.stderr.write(`[agent-service] 自动压缩失败（继续按原上下文提交）: ${(error as Error).message}\n`)
      return pruned.length > 0
    }
  }

  // ———— 溢出恢复(完备化 R5,pi 单次闸同款;修正批次 4 D7「不搬」) ————

  /**
   * 失败是否为可恢复的 context overflow:末位是 error assistant、报文匹配
   * pi-ai 聚合的 overflow 模式、且单次闸未用。agent_end 与 submit 链两处
   * 共用同一判定(前者据此抑制 run.failed,后者据此执行恢复)。
   */
  private overflowRecoverable(agent: Agent, sessionId: string): boolean {
    if (this.overflowRetried.has(sessionId)) return false
    const last = agent.state.messages.at(-1)
    if (!last || last.role !== 'assistant' || last.stopReason !== 'error' || !last.errorMessage) {
      return false
    }
    return isContextOverflow(last, agent.state.model.contextWindow)
  }

  /**
   * prompt 落定后的溢出恢复:删失败轮(pi 失败 assistant 恒在末位,请求期失败
   * 无内容产出)→ 落盘 → 超线先 L1/L2 → agent.continue() 原请求重试一次。
   * agent.continue 从末位 user/toolResult 续跑(pi 官方恢复路径),新 run 的
   * errorMessage 在 runWithLifecycle 起点自动清零,成功后走正常 agent_end。
   * 闸在入口消费:重试再溢出时 overflowRecoverable 为 false,agent_end 按
   * 原样发 run.failed(显式暴露,不劣于批次 4 行为)。
   */
  private async recoverOverflow(session: Session, agent: Agent): Promise<void> {
    const sessionId = session.summary.id
    if (!agent.state.errorMessage || !this.overflowRecoverable(agent, sessionId)) return
    this.overflowRetried.add(sessionId)
    // 原位删失败轮(run 已结束,此刻无 loop 引用并发,但统一原位手法防患)
    agent.state.messages.splice(-1, 1)
    session.transcript = agent.state.messages
    this.persist(sessionId)
    const model = agent.state.model
    const contextTokens = estimateContextTokens(convertToLlmMessages(agent.state.messages)).tokens
    if (shouldCompact(contextTokens, model.contextWindow, model.compaction)) {
      await this.compactWithPrune(session, agent, contextTokens)
    }
    try {
      await agent.continue()
    } catch (error) {
      // continue 启动失败(末位消息角色不符等极端):按失败收尾,run 终态不悬空
      this.streaming.delete(sessionId)
      this.notify('run.failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 末条是否为可续写的 length 截断(R6③):纯文本/思考被截(pi 对带工具的
   * length 消息已原生 fail + 自愈重发,run 不会停在那)且续写预算未尽。
   * **正文非空才续**(完备化验收修复 2026-11-12):正文为空 = 输出预算被
   * 夹到趋零(room 耗尽),续写只会立即再截 —— 实测 20K 窗空回复连烧 11 次
   * 请求毫无产出。此时截断是「真没地方写」,正确出路是压缩腾地(动作条
   * 「立即压缩」),不是续写。agent_end(抑制终态)与 settleRun(注入续写)
   * 两处同读,消费方扣减。
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
   * prompt 落定后的收尾驱动(完备化 R5/R6):溢出恢复(单次闸)与 length
   * 续写(≤3 次)在同一循环消化 —— 每轮落定后重查:可恢复溢出 →
   * recoverOverflow(内部 agent.continue 再跑);可续写截断 → 注入显式
   * continue 消息再跑。两者都会回到循环头,直到 run 以终态(成功 / 失败 /
   * 预算尽后的截断)落定 —— agent_end 只在循环不再续跑的那一轮发射终态。
   */
  private async settleRun(session: Session, agent: Agent): Promise<void> {
    const sessionId = session.summary.id
    for (;;) {
      if (agent.state.errorMessage) {
        if (this.overflowRecoverable(agent, sessionId)) {
          await this.recoverOverflow(session, agent)
          continue
        }
        return // 不可恢复失败:run.failed 已由 agent_end 发出
      }
      if (this.lengthContinuable(agent, sessionId)) {
        this.continuationBudget.set(sessionId, (this.continuationBudget.get(sessionId) ?? 0) - 1)
        await agent.prompt(AUTO_CONTINUE_MESSAGE)
        continue
      }
      return
    }
  }

  /**
   * 手动续写入口(session.continue,截断动作条「继续生成」):对末条 length
   * 截断注入显式 continue 消息再跑。与自动路同消息同循环,预算重新给满
   * (用户点按钮 = 明确要继续);自动路的单 run 已收尾,这里是 UI 眼里的
   * 新一段(run.started + 新 streaming),完成后 run.completed 的 stopReason
   * 非 length 会自然熄掉宿主的截断提示。
   */
  async continueSession(sessionId: string): Promise<{ ok: true }> {
    const session = this.requireSession(sessionId)
    const agent = this.ensureAgent(session)
    if (agent.state.isStreaming || this.compacting.has(sessionId)) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, `会话正在回复中，无法续写: ${sessionId}`)
    }
    const last = agent.state.messages.at(-1)
    if (last === undefined || last.role !== 'assistant' || last.stopReason !== 'length') {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '末条回复不是输出截断，无需续写')
    }
    // 空正文截断(room 耗尽)不受理续写:续了立即再截,白烧一次请求 —— 错误
    // 文案直接指路(压缩腾地),比静默成功诚实
    const hasText = last.content.some((block) => block.type === 'text' && block.text.trim() !== '')
    if (!hasText) {
      throw new ProtocolError(
        RpcErrorCode.InvalidRequest,
        '回复为空截断（输出预算已耗尽），续写无意义 —— 请先压缩上下文腾出空间'
      )
    }
    this.continuationBudget.set(sessionId, AUTO_CONTINUE_LIMIT)
    session.summary.updatedAt = Date.now()
    this.notify('run.started', { sessionId })
    this.streaming.set(sessionId, {
      messageId: `m-${crypto.randomUUID()}`,
      segments: [],
      text: '',
      thinking: '',
      tools: []
    })
    await agent.prompt(AUTO_CONTINUE_MESSAGE)
    await this.settleRun(session, agent)
    return { ok: true }
  }

  /**
   * 手动压缩入口（session.compact）。与自动路的差异：无可压缩/失败都以协议
   * 错误显式反馈（手动动作要明确结果），且会话回复中直接拒绝（上游手动路先
   * abort 再压，我们不打断生成中的回复 —— 让用户等完更可预期）。
   */
  async compactSession(sessionId: string): Promise<{ tokensBefore: number; tokensAfter: number }> {
    const session = this.requireSession(sessionId)
    const agent = this.ensureAgent(session)
    if (agent.state.isStreaming || this.compacting.has(sessionId)) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, `会话正在回复中，请等待完成后再压缩: ${sessionId}`)
    }
    const contextTokens = estimateContextTokens(convertToLlmMessages(agent.state.messages)).tokens
    const outcome = await this.runCompaction(session, agent, 'manual', contextTokens)
    if (outcome === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '会话无可压缩内容（刚压缩过或近期内容不足保留窗口）')
    }
    return outcome
  }

  /**
   * 执行一次压缩（阈值/手动共用）。返回 undefined = prepareCompaction 判定
   * 无可压缩（手动路转错误、自动路静默跳过）；成功返回前后 token 估算。
   * 失败 throw（completed(error) 事件已发，调用方决定呈现方式）。
   */
  private async runCompaction(
    session: Session,
    agent: Agent,
    reason: 'threshold' | 'manual',
    contextTokens: number
  ): Promise<{ tokensBefore: number; tokensAfter: number } | undefined> {
    const sessionId = session.summary.id
    // agent.state.model 的声明宽到 Model<any>（pi 内部态通用签名），而
    // Models.completeSimple 收 Model<Api> —— 运行时是同一对象（模型都出自
    // models 目录），窄化只平息 no-unsafe-argument 的 any 闸，无真实收窄
    const model = agent.state.model as Model<Api>
    // 保留窗口按模型夹紧：20K 对小窗口模型可能大于窗口本身，保一半
    const keepRecent = Math.min(KEEP_RECENT_TOKENS, Math.floor(model.contextWindow / 2))
    const preparation: CompactionPreparation | undefined = prepareCompaction(
      agent.state.messages,
      keepRecent,
      contextTokens
    )
    if (preparation === undefined) return undefined

    this.compacting.add(sessionId)
    this.notify('compaction.started', { sessionId, reason })
    try {
      const response = await this.models.completeSimple(
        model,
        // 摘要请求 = 主请求的真前缀(R4 指令内联):会话 system 原对象(领头
        // system 的 toolsAdded 与主请求逐字相同)+ 被摘要区原消息直传 +
        // 指令作末条 user —— provider KV cache 复用而非失效;小窗深度占用时
        // 预算守卫自动降级只送被摘要区(否则 max_tokens 被夹死,摘要必截断)
        buildSummarizationContext(
          convertToLlmMessages(agent.state.messages.filter((m) => m.role === 'system')),
          preparation,
          buildSummarizationInstruction(preparation),
          model.contextWindow
        ),
        {
          // 摘要请求独立于会话 run：key 从内存表现取（与 Agent 的 getApiKey 同源）
          apiKey: this.credentials.get(model.provider),
          ...summarizationThinkingLevel(model.reasoning, agent.state.thinkingLevel)
        }
      )
      const failure = summarizationFailure(response)
      if (failure !== undefined) throw new Error(failure)
      const summary = contentText(response.content) + formatFileOperations(preparation.fileOps)

      // tokensAfter 要进压缩条本身，只能先建 draft 估算再建真值条 —— 两次重建
      // 只差 tokensAfter 几个数字位，对估算无感；数组拼接零成本。
      // **必须原位写回**(applyCompactionInPlace,S2 验收 bug 修复):轮间钩子
      // 触发时 pi loop 手里还持着同一数组的旧引用(当轮 toolResult push/流式
      // partial 替换都落在这个引用上),换引用 = loop 旧引用与 agent.state 各写
      // 各的,当轮收尾消息双份落转录 → 请求里 tool_calls 配对重复 → 400。
      // 原位 splice 后所有引用线共享同一数组,submit 前单点检查(无并发引用)
      // 也走同一形态,行为一致
      const draft = rebuildTranscript(agent.state.messages, preparation, summary, 0)
      const tokensAfter = estimateContextTokens(convertToLlmMessages(draft)).tokens
      const transcript = applyCompactionInPlace(agent.state.messages, preparation, summary, tokensAfter)
      session.transcript = transcript
      this.persist(sessionId)
      this.notify('compaction.completed', {
        sessionId,
        reason,
        tokensBefore: contextTokens,
        tokensAfter,
        summary,
        summarizedUntil: preparation.summarizedUntil
      })
      return { tokensBefore: contextTokens, tokensAfter }
    } catch (error) {
      this.notify('compaction.completed', {
        sessionId,
        reason,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    } finally {
      this.compacting.delete(sessionId)
    }
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
    this.compacting.clear()
  }

  // ———— 审批（计划-工具系统与审批.md 第 4 步，D4/D5）————

  /**
   * 宿主裁决回流：resolve 挂起中的 beforeToolCall Promise（审批交互升级 D2 扩
   * message/always）。唔配对 requestId（已裁决过 / abort 已收尾 / 不存在）→
   * InvalidParams —— 双击允许钮、裁决与中止竞态都属于此类，显式报错而非静默成功。
   */
  respondApproval(
    requestId: string,
    approved: boolean,
    message?: string,
    always?: 'workspace'
  ): { ok: true } {
    const pending = this.pendingApprovals.get(requestId)
    if (pending === undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, `审批请求不存在或已被裁决: ${requestId}`)
    }
    // always 的语义校验在消费 pending 之前：无绑定根会话不落规则（防"全放主
    // 目录"的过大授权，D3 —— UI 不显示此项但协议直达，引擎侧是最后一道闸）；
    // 报错时请求未被消费，宿主仍可改发普通 respond
    if (always === 'workspace') {
      const roots = this.workspaceRoots(this.requireSession(pending.sessionId))
      if (roots.length === 0) {
        throw new ProtocolError(RpcErrorCode.InvalidParams, '无绑定工作区的会话不支持「始终允许」')
      }
      // 允许本次 + 落工作区级规则（同 roots 集合幂等，见 ApprovalRegistry.add）
      this.approvals.add(roots, pending.kind)
    }
    this.pendingApprovals.delete(requestId)
    // 拒绝附言（D2「告诉模型接下来怎么做」）：进 block reason → pi 工具错误结果
    // 给模型。截断上限防打爆工具结果（与 D8 截断纪律同源）；加前缀让模型明确
    // 这是拒绝后的用户指示而非工具输出
    const denyReason =
      !approved && message !== undefined && message.trim() !== ''
        ? `用户拒绝了本次操作。用户指示：${message.trim().slice(0, APPROVAL_MESSAGE_MAX_CHARS)}`
        : '用户拒绝了本次操作'
    pending.resolve(approved ? { block: false } : { block: true, reason: denyReason })
    return { ok: true }
  }

  /**
   * 会话级权限切换（权限模式菜单）：beforeToolCall 每次触发时读活值，运行中
   * 切换即生效；**提示词时效（D6 评审补）** —— 对已建 agent 以**替换式单条**
   * system 通告落新权限语义（pi 的 systemPrompt 重放全部 system 消息，纯追加
   * 会随来回切换堆积拼接，故按前缀识别原地替换；ask = 移除 —— 切回后无
   * 「已授予完全访问」残留）。惰性会话无 agent 则只记 summary（下次 ensureAgent
   * 建后按 mode 补通告）。运行中（含审批挂起）切换安全：通告在下一轮请求生效，
   * anthropic/openai 方言组装时中部 system 合并领头，不打断 toolUse/toolResult 配对。
   */
  setPermission(sessionId: string, mode: PermissionMode): SessionSummary {
    const session = this.requireSession(sessionId)
    session.summary.permissionMode = mode
    if (session.agent) this.applyPermissionNotice(session.agent, mode)
    this.persist(sessionId)
    return { ...session.summary }
  }

  /** 权限通告的替换式更新：transcript 内至多一条（PERMISSION_NOTICE_PREFIX 识别） */
  private applyPermissionNotice(agent: Agent, mode: PermissionMode): void {
    const messages = agent.state.messages
    const at = messages.findIndex(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(PERMISSION_NOTICE_PREFIX)
    )
    if (mode === 'ask') {
      // 回到缺省：移除通告（无通告则不动 —— setter 拷贝顶层，避免无谓新引用）
      if (at >= 0) agent.state.messages = messages.filter((_, i) => i !== at)
      return
    }
    const notice = { role: 'system' as const, content: permissionNotice(mode), timestamp: Date.now() }
    agent.state.messages =
      at >= 0
        ? messages.map((m, i) => (i === at ? notice : m))
        : [...messages, notice]
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
    // 模式非 ask 则落权限通告（D6）：新会话物化即 plan/auto 时 transcript 还没有
    // 通告；恢复会话的通告已在 transcript（agent_end 落盘带上），替换幂等不重复
    if (session.summary.permissionMode !== undefined && session.summary.permissionMode !== 'ask') {
      this.applyPermissionNotice(agent, session.summary.permissionMode)
    }
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
      // 思考预算（完备化 R7）：ModelDef.thinkingBudgets 经声明合并通道挂在 Model
      // 上，此处同步到 Agent 选项层（pi 的预算消费在请求选项，Agent.thinkingBudgets
      // 会被 createLoopConfig 逐 prompt 带进 streamFn 选项）；模型切换时在 submit 同步
      thinkingBudgets: model.thinkingBudgets,
      // 压缩条（compactionSummary 自定义角色）→ user 消息的转换口（批次 4）：
      // pi 官方扩展点，agent-loop 每轮请求组装前唯一转换通道（agent.ts L242
      // 缺省恒等直通 —— 直通会把未知 role 透给 provider 被拒收，故必须显式给）
      convertToLlm: convertToLlmMessages,
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
        // 自主模式（D6 定稿）：文件写信任放行（工作区根内，越界仍有工具层
        // 软边界兜底），exec/network 风险类照旧走询问
        if (mode === 'autonomous' && (kind === 'write' || kind === 'edit')) return undefined
        // ask 判定前先查「始终允许」规则表（审批交互升级 D3）：会话工作区根与
        // 某条同类别规则任一根命中即放行 —— 规则只能放行"边界内"的写，越界写
        // 在工具执行层（resolveWithinRoots）恒拒，双保险。无绑定根（workspaceRoots
        // 为空）天然不命中，无根会话不落规则的 UI 语义在引擎侧自洽
        if (this.approvals.allows(this.workspaceRoots(session), kind)) return undefined
        // ask：发审批请求并挂起（D5：无超时 —— 用户不点就一直等，宿主输入框
        // 变停止钮可 abort；signal abort 兜底 resolve，否则中止后 Promise 永悬）
        const requestId = `appr-${crypto.randomUUID()}`
        const sessionId = session.summary.id
        return new Promise<BeforeToolCallResult>((resolve) => {
          // 先登记再发事件：respondApproval 走这张表找 resolver，时序上不存在
          // 「事件未到、respond 先行」的窗口（宿主是收到事件才可能裁决）
          this.pendingApprovals.set(requestId, { sessionId, kind, resolve })
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

    // 工具轮间压缩检查点（完备化 R2，pi agent-session 的 _installAgentNextTurnRefresh
    // 同款手法）：pi Agent 原生钩子在每个带工具调用的轮次收尾、下一 assistant
    // 请求派发前触发 —— 此处查阈值，超线走 L1→L2 检查链（compactWithPrune），
    // 回合中途也能腾地（Codex「压缩不打断任务」的时机基础；批次 4 单点检查
    // 救不了工具链进行中的饿死）。与 submit 前检查互补而非替代：纯文本回合
    // 不经此路，仍靠 submit 前那道。构造后直赋即生效（createLoopConfig 每次
    // prompt 动态读属性，pi 官方先例）。返回 context 的关键：loop 的
    // currentContext 是 prompt 起点快照，返回 { messages: agent.state.messages }
    // 让下一请求拿到压缩后形态 —— 配合 compactWithPrune 的**原位写回**（同一
    // 数组对象），loop 当轮持有的旧引用与 agent.state 天然一致，无双写分叉。
    agent.prepareNextTurnWithContext = async (turn) => {
      const model = agent.state.model
      const contextTokens = estimateContextTokens(convertToLlmMessages(agent.state.messages)).tokens
      if (!shouldCompact(contextTokens, model.contextWindow, model.compaction)) return undefined
      const changed = await this.compactWithPrune(session, agent, contextTokens)
      if (!changed) return undefined
      // 返回**浅拷贝**隔离两条线(验收 400 bug 的第二层根因):钩子返回后,当轮
      // 与后续轮的流式 partial/收尾消息会 push 进「loop 的 context.messages」,
      // 同时 Agent.processEvents 的 message_end 会 push 进「agent.state.messages」
      // —— 两个引用若指向同一数组(共享或原位同物),同一消息必然双写(实测:
      // 落盘转录出现两条相邻相同的收尾 assistant)。pi 上游无此问题:它的钩子
      // 返回 session 树投影的独立数组,状态线与请求线天然分离。Cogent 状态线
      // 是真源(agent_end 全量落盘),故请求线必须拷贝分离:压缩形态已由
      // compactWithPrune 原位写进共享底层数组,拷贝此刻快照即是压缩后的完整
      // 前缀;此后状态线继续追加、请求线独立使用,agent_end 落盘干净
      return { context: { ...turn.context, messages: [...agent.state.messages] } }
    }
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

  /**
   * 相邻纯文本段合并（完备化 R6③）：auto-continue 的 length 段 + 续写段 →
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
      prev.content += cur.content
      if (cur.thinking) prev.thinking = (prev.thinking ?? '') + cur.thinking
      // 相邻门保证双方都无工具卡,这里只并正文/思考/账目
      if (cur.usage !== undefined) prev.usage = accumulateUsage(prev.usage, cur.usage)
      prev.durationMs = sumOptional(prev.durationMs, cur.durationMs)
      prev.model = cur.model
    }
    return merged ?? segments
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
      case 'tool_execution_update': {
        // 工具流式进度（当前消费者 = bash 的 OutputAccumulator 快照，100ms 节流
        // 已在工具内做了，这里只透传）。快照语义（整段替换非增量），UI 直接渲染；
        // 文本取尾部 2000 字符 —— 比 resultSummary 的 200 字符宽（bash 直播窗
        // 要看得见量），又比accumulator 全量快照窄（100ms 一帧不搬 50KB）
        const streaming = this.streaming.get(sessionId)
        if (!streaming) return
        const full = summarizeToolResult(event.partialResult)
        if (full === '') return
        const text = full.length > 2000 ? full.slice(-2000) : full
        this.notify('tool.progress', {
          sessionId,
          callId: event.toolCallId,
          text
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
        const diff = extractResultDiff(event.result)
        const record = streaming.tools.find((t) => t.callId === event.toolCallId)
        if (record !== undefined) {
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
          diff
        })
        return
      }
      case 'agent_end': {
        const streaming = this.streaming.get(sessionId)
        const session = this.sessions.get(sessionId)
        if (!session) {
          this.streaming.delete(sessionId)
          return
        }
        session.summary.updatedAt = Date.now()

        // pi 约定：失败/中止在 Agent.state.errorMessage 留痕（stream error 也汇于此）
        if (agent.state.errorMessage) {
          // 溢出可恢复（完备化 R5）：不发 run.failed、streaming 保活 —— submit
          // 链的 settleRun 删失败轮/压缩/continue 重试,重试的流式增量与
          // 终态沿同一 streaming 对象发出,UI 全程只见这一个 run
          if (this.overflowRecoverable(agent, sessionId)) return
          this.streaming.delete(sessionId)
          session.inspector?.runFailed(agent.state.errorMessage)
          this.notify('run.failed', { sessionId, message: agent.state.errorMessage })
          return
        }
        // length 截断可续写（完备化 R6③）：同样抑制终态、streaming 保活 ——
        // settleRun 注入显式 continue 消息接着跑;预算尽或续写完成时由下一轮
        // agent_end 正常收尾。抑制意味着本轮转录不落盘:续写中途崩溃会丢
        // 截断段(下一回合边界重写补上),与"回合边界落盘"语义一致可接受
        if (this.lengthContinuable(agent, sessionId)) return
        this.streaming.delete(sessionId)

        // 回合成功的最终 assistant 消息进持久转录（pi 消息带真实 timestamp，
        // 投影/恢复共用此值）；失败/中止回合 pi 已把半截文本留进转录，
        // 这里同步一次保证盘上盘内一致（pi 语义：半截回复留存、后续请求可见）
        session.transcript = [...agent.state.messages]
        this.persist(sessionId)

        // 上下文明细估算挂到本回合 usage 上（turn_end 逐轮累加的 usage 已聚合；
        // 明细只描述"此刻转录长什么样"，与轮次无关，算一次即可）。挂 usage 而非
        // 单独字段：renderer 旧数据无此字段自然降级（additive，见
        // MessageUsage.contextEstimate）。聚合与末段各挂一份 —— 指示器分子读的是
        // "末条带 usage 的消息"（分段终态下 = 末段），聚合份供兼容形态与观测
        // 快照，两处是独立对象不共享。注意这里只覆盖事件路径：估算挂的是协议侧
        // streaming 对象、随 run.completed 飞走，不进盘上 transcript（pi 形状，
        // 其 Usage 无此字段）—— 历史回查路径在 messages() 按需现算，两条路
        // 各自出同源数据（estimateContext 纯转录函数，见其注释）
        if (streaming?.usage) {
          const estimate = estimateContext(session.transcript)
          streaming.usage.contextEstimate = estimate
          const lastSegment = streaming.segments.at(-1)
          if (lastSegment?.usage) lastSegment.usage.contextEstimate = { ...estimate }
        }

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
        // 相邻纯文本段合并（完备化 R6③ 续写的呈现形态）：length 段 + 续写段
        // → 单段。run 内相邻纯文本段只可能来自续写注入（无工具的轮会终结
        // run，带工具的 length 轮段里必带工具卡），合并无歧义；正文无缝拼接
        // （续写指令就是"从截断处接着写"），用量/耗时相加 = 计费真相
        const segments = SessionManager.mergeContinuedSegments(streaming?.segments ?? [])
        this.notify('run.completed', {
          sessionId,
          // 分段终态（优先消费）：text 段与工具段按发生序 —— 交错保真的代价是
          // 一 run 多条消息，宿主用它整体替换流式占位（含流式期插入的工具卡）
          messages: segments.length > 0 ? segments : undefined,
          // 聚合兼容形态（老宿主只读 message）：全段拼接。思考/正文任一非空
          // 都落消息（只有思考没有正文的极端截断也可见）；usage 三件套是
          // turn_end 的逐轮累计（计费口径，见 accumulateUsage）
          message:
            streaming && segments.some((s) => s.content || s.thinking)
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
      { isError: boolean; text: string; diff?: string; startedAt?: number; endedAt?: number }
    >()
    for (const message of messages) {
      if (message.role === 'toolResult') {
        results.set(message.toolCallId, {
          isError: message.isError,
          text: summarizeToolResult({ content: message.content }),
          diff: extractResultDiff({ details: message.details }),
          endedAt: message.timestamp,
          startedAt: message.durationMs !== undefined ? message.timestamp - message.durationMs : undefined
        })
      }
    }

    const result: ChatMessage[] = []
    for (const message of messages) {
      // pi Message 联合类型按 role 收窄
      if (message.role === 'compactionSummary') {
        // 压缩条（批次 4）：content = 摘要全文（折叠条展开可读），不参与
        // 回合问答切分 —— id 前缀 c- 与 u-/a- 的位置式手法一致
        result.push({
          id: `c-${result.length}`,
          role: 'compaction',
          content: message.summary,
          compaction: { tokensBefore: message.tokensBefore, tokensAfter: message.tokensAfter },
          timestamp: message.timestamp
        })
      } else if (message.role === 'user') {
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
        // 续写注入的指令消息（R6③）：不单独成泡 —— 跳过它让截断段与续写段
        // 在投影里相邻，由下方 assistant 分支合并（保真在转录，聚合在投影）
        if (text.startsWith(AUTO_CONTINUE_PREFIX)) continue
        result.push({
          // 位置式 id（同 assistant 的 a-N 手法）：timestamp 在同一毫秒内可撞
          // （React key 重复），投影位置在单写者下稳定且跨加载不变
          id: `u-${result.length}`,
          role: 'user',
          content: text,
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
            diff: paired?.diff,
            startedAt: paired?.startedAt,
            endedAt: paired?.endedAt
          })
        }
        const content = message.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('')
        // 相邻 assistant 合并（R6③ 续写的历史投影形态）：跳过 [cogent:continue]
        // 指令泡后，截断段与续写段在 result 里直接相邻 → 并回前一条（正文无缝
        // 拼接、用量/耗时相加），与事件路径的段合并同形态，重启前后不漂移。
        // 门 = 双方都无工具卡：工具轮后的文本轮（转录里有 toolResult 隔开、
        // 投影里天然相邻）是正常交错形态，不许并
        const prev = result.at(-1)
        if (
          prev !== undefined &&
          prev.role === 'assistant' &&
          (prev.toolCalls ?? []).length === 0 &&
          toolCalls.length === 0
        ) {
          prev.content += content
          if (thinking !== '') prev.thinking = (prev.thinking ?? '') + thinking
          // 相邻门保证双方都无工具卡,这里只并正文/思考/账目
          prev.usage = accumulateUsage(prev.usage, projectUsage(message.usage))
          prev.durationMs = sumOptional(prev.durationMs, message.durationMs)
          prev.model = message.model
          continue
        }
        result.push({
          id: `a-${result.length}`,
          role: 'assistant',
          content,
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
