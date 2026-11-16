/**
 * 会话运行时 —— pi AgentSession 的托管层。
 *
 * 职责：
 * - 每会话一个 pi AgentSession（经 kernel/pi-session-factory 装配，南缝唯一
 *   实现）；转录真源 = pi JSONL（message_end 逐条追加落盘），本层只管会话域
 *   summary（置顶/归档/项目绑定是 Cogent 的私域）；
 * - 用户文本（agent.submit）→ pi.prompt()，pi 事件流转译为协议事件（notify
 *   回调注入，本文件不直接碰 stdout）；
 * - pi AgentSession 全托管运行期恢复：provider 自动重试、溢出压缩重试、阈值
 *   压缩都发生在 prompt() Promise 生命周期内；Cogent 侧的运行期逻辑只剩
 *   AUTO_CONTINUE 续写（贴线 maxTokens 截断时注入显式 user 续写指令，上限
 *   3 次）与审批挂起（链式 beforeToolCall，见 factory）。
 *
 * 终态纪律：协议 run.completed/run.failed 的发射点在 **agent_settled**（pi
 * 在 _startRun 的 finally 里每轮 prompt 恰发一次）—— 它晚于全部内聚恢复/
 * 重试，天然的单一权威终态（单一发射点消解溢出/续写窗口的终态竞态）。
 *
 * 惰性纪律：恢复的会话启动只读 summary（v2 盘上文档），pi 内核与观测记录器
 * 都在首次使用（submit/compact/inspect 读取）时才建。
 *
 * 边界纪律：
 * - 本类实现 kernel/contract.ts 的 CogentKernel（南缝合同，全局架构 D4），
 *   经 kernel/pi-session-factory 装配 pi AgentSession；
 * - 只依赖 pi-* 与 protocol 与 ../storage，零 Electron import（目录即边界）；
 * - handler 内信任协议类型，不做二次防御（约定.md §1.3，边界校验在 dispatch 入口）。
 */
import type { Agent, AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model, MutableModels, Usage } from '@earendil-works/pi-ai'
// 上下文粗估（2026-11-11 明细区）：与 pi clampMaxTokensToContext 同一实现 ——
// 引擎每轮算 max_tokens 预算用的就是 estimateContextTokens，明细口径与之同源
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { getSystemMessageText } from '@earendil-works/pi-ai/utils/text'
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime
} from '@earendil-works/pi-coding-agent'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
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
import { SessionInspector } from './inspector'
import { McpConfigStore } from './mcp-config'
import { formatSkillsSection } from './skill-prompt'
import { SkillStore } from './skill-store'
import type { ProjectRegistry } from './project'
import type { ApprovalRegistry } from './approvals'
import type { CogentKernel, KernelNotifier } from '../kernel/contract'
import {
  type CompactionBarSource,
  createPiSession,
  PI_AGENT_DIR_NAME,
  readPiTranscript
} from '../kernel/pi-session-factory'
import { importLegacyTranscript } from '../kernel/legacy-import'
// 上下文明细的转录整形（明细区数据源）：convertToLlmMessages 处理
// compactionSummary 等自定义角色后与 pi 预算看到的载荷同源同形
import { convertToLlmMessages, piTriggerRatio } from './compaction'
import type { InspectStore, StorageDriver } from '../storage'
import { SHELL_TOOL_NAME, toolDeclarations, toolMeta } from './tool-meta'
import { resolveWithinRoots } from './write-boundary'

/** 引擎事件出口的类型别名：runtime 通过它上报事件，不关心传输层（形状住在南缝合同） */
export type Notify = KernelNotifier

/**
 * 会话盘上文档形状（v2）：只存会话域 summary —— 转录真源在
 * pi JSONL（<hostRoot>/pi/sessions/…，pi 逐条追加）；置顶/归档/权限模式是
 * Cogent 的私域，pi 不知情，落在本文件。
 */
interface StoredSession {
  version: 2
  summary: SessionSummary
  /** 任务清单（交互座 4c）：todo_write 的活清单快照；缺省 = 无清单。模型侧另有转录回放兜底 */
  todos?: TodoItem[]
  /** 已批准计划（交互座 4c-3）：cogent_plan 段的数据源；缺省 = 无。新批准覆盖旧值 */
  plan?: PlanRecord
}

/**
 * 启动恢复时的盘上数据收窄（信任边界：磁盘旧数据可能被手改/属旧版本格式）。
 * v1（架构重构前的盘上格式）带完整转录 —— 收进 legacyTranscript 等惰性导入 pi 树
 * （见 buildPiSession）；v2 只有 summary。只校验本层依赖的字段；转录内层
 * 结构信任 pi 的写入（引擎自己落的盘）。
 */
function asStoredSession(
  doc: unknown,
  id: string
): { summary: SessionSummary; todos?: TodoItem[]; plan?: PlanRecord; legacyTranscript?: AgentMessage[] } {
  if (typeof doc !== 'object' || doc === null) throw new Error(`会话文档形状不合法（sessions/${id}.json）`)
  const d = doc as {
    version?: unknown
    summary?: SessionSummary
    todos?: unknown
    plan?: unknown
    transcript?: unknown
  }
  if (d.version !== 2 && d.version !== 1) {
    throw new Error(`会话文档版本不合法（sessions/${id}.json），请手工处理后重启`)
  }
  if (typeof d.summary?.id !== 'string') {
    throw new Error(`会话文档形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  if (d.version === 1 && !Array.isArray(d.transcript)) {
    throw new Error(`会话文档转录形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  if (d.todos !== undefined && !Array.isArray(d.todos)) {
    throw new Error(`会话文档任务清单形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  if (d.plan !== undefined && (typeof d.plan !== 'object' || typeof (d.plan as PlanRecord).plan !== 'string')) {
    throw new Error(`会话文档计划形状不合法（sessions/${id}.json），请手工处理后重启`)
  }
  // v2 盘 plan 档迁移（正交开关 v3）：plan 曾是档位联合值，原档已被覆盖无从
  // 考据 → 回 ask 缺省 + 开关开（行为保真：只读约束不丢）。磁盘旧数据属信任
  // 边界，mode 以 string 比较（类型层 'plan' 已删）
  const summary = { ...d.summary }
  if ((d.summary.permissionMode as string) === 'plan') {
    summary.permissionMode = 'ask'
    summary.planEnabled = true
  }
  return {
    summary,
    ...(d.todos !== undefined && { todos: d.todos as TodoItem[] }),
    ...(d.plan !== undefined && { plan: d.plan as PlanRecord }),
    ...(d.version === 1 && { legacyTranscript: d.transcript as AgentMessage[] })
  }
}

/** 内存态会话：pi 内核惰性 —— 恢复的会话在首次 submit/compact 时才装配 */
interface Session {
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
        process.stderr.write(`[host] AGENTS.md 读取失败（跳过 ${root}）: ${(error as Error).message}\n`)
      }
    }
  }

  // 工具段（D2 修订：任何会话都有只读工具，无绑定会话以主目录为基）。讲清
  // 有什么、路径规则（读相对基根/绝对不限；写限工作区根内 + 先审批 —— 边界
  // 在审批层 enforce，越界写得到带可写根提示的错误结果）。不解释参数（工具
  // schema 自描述，模型读 description 比提示词转述更准）
  const bound = boundRoots.length > 0
  const base =
    bound
      ? '相对路径相对工作区主根解析'
      : `相对路径相对用户主目录（${toolRoots[0]}）解析`
  prompt +=
    '\n\n# 工具\n' +
    '你可以调用工具：read（读单个文件，大文件用 offset/limit 分段读）、find（按通配模式找文件）、' +
    'grep（按正则全文搜索，可带上下文行）、ls（列目录一层内容）、' +
    'write（整文件写入，执行前可能需要用户批准）、' +
    'edit（对已有文件做精确文本替换，执行前可能需要用户批准）、' +
    `${SHELL_TOOL_NAME}（执行 shell 命令，工作目录${bound ? '为工作区主根' : '为用户主目录'}，执行前可能需要用户批准）。` +
    '先用 ls/find/grep 定位、再用 read 读内容；修改已有文件优先 edit（带上下文精确匹配），' +
    '整文件新建或重写才用 write。\n' +
    // F6 定稿后不再宣称"写入只能在根内"（那会让模型对越界写自我审查、连
    // 工具都不调 —— 引擎已按模式裁决：auto/autonomous 放行、ask 弹面板）。
    // 审批语义由 cogent_permission 段按活模式动态告知；这里只留弱预期
    `${base}；读取的绝对路径不限位置；工作区外的写入可能需要用户批准后执行。`
  return prompt
}

/**
 * 权限模式通告段：**三档全设正向文案**，
 * 经 before_agent_start 扩展进 systemPromptOptions 的 cogent_permission
 * section（pi 对 sections 变更才追加 patch、回放按名替换 —— 运行中切模式
 * 下一轮即生效且不堆积）。
 * 为什么 ask 也设段（首版曾"非 ask 不设"）：切回 ask 只是把段移除，但会话
 * 历史里还留着此前被拦截的工具 error —— 模型会据历史推断"仍受限"、
 * 连尝试都不尝试。三档全给明确的当下状态（切换 = 内容替换），模型每轮拿到
 * 的是现状而非考古。文案与 decideApproval 的强制面同口径。
 * 只读计划是正交开关（cogent_plan_active 段），不在本段 —— 两个正交维度
 * 各自替换互不干扰（docs/计划/计划模式正交开关.md）。
 */
function permissionSectionText(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
      return '当前会话处于完全访问模式：所有工具调用直接执行，无需用户逐次确认。'
    case 'autonomous':
      return '当前会话处于自主模式：文件写直接执行（不限工作区）；命令执行仍需用户确认。'
    default:
      return '当前会话处于变更前确认模式：文件写入和命令执行会先请求用户批准，你可以正常尝试调用需要的工具。'
  }
}

/**
 * 计划模式段（开关开启时注入、关闭即撤段）：只读约束 + 调研→submit_plan
 * 工作流。zcode runtime-reminders 的 plan still active 提醒同源 —— 每回合
 * 常驻，防模型长对话后忘记自己只读。
 */
function planModeSectionText(): string {
  return (
    '当前会话开启了计划模式（只读）：文件写入与命令执行会被拒绝，只能读取文件、搜索和列目录。不要尝试调用写类或执行类工具。\n' +
    '工作流：先用只读工具完成调研；遇到需要用户拍板的疑点用 ask_user 澄清；' +
    '调研充分后调 submit_plan 提交实现计划并等待批准。' +
    '不要用普通文本或 ask_user 问「这个方案可以吗」—— 那正是 submit_plan 的职责。'
  )
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
const AUTO_CONTINUE_PREFIX = '[cogent:continue]'
const AUTO_CONTINUE_MESSAGE = `${AUTO_CONTINUE_PREFIX} Continue your previous response from exactly where it was cut off. Do not repeat what you already wrote, do not apologize or explain — just continue seamlessly.`
const AUTO_CONTINUE_LIMIT = 3

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
 * 生命周期：streaming 在 submit 受理时置位、**agent_settled**
 * 终态时清位 —— 覆盖 pi 内聚恢复（provider 重试/溢出压缩重试）与 AUTO_CONTINUE
 * 续写链的全窗口，也是 submit 忙判定的单一账本（见 submit）。
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
 * 上下文明细三段估算（悬浮卡分类区数据源）。
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
 * system 段来源：pi 的 system 是提示词状态不进树（只有
 * sections patch 消息落树），领头那条由调用方传入 systemPrompt 现合成 ——
 * 活会话取 piSession.systemPrompt（当前完整渲染），惰性会话取自拼提示词
 * （缺 pi 追加的环境节，≈ 粗估可接受）；工具声明按 toolDeclarations 重建。
 */
function estimateContext(messages: AgentMessage[], systemPrompt?: string): ContextEstimate {
  // 先过 convertToLlmMessages：转录可能含 compactionSummary 自定义角色（无
  // content 数组），pi-ai estimateMessageTokens 对它不认识会炸；转换后与引擎
  // max_tokens 预算看到的载荷同源同形（预算口径只可能更准）
  const llmMessages = convertToLlmMessages(messages)
  if (systemPrompt !== undefined) {
    // 合成领头 system（引擎请求组装的真实形态：文本 + toolsAdded 声明）；
    // 树里的 sections patch 消息照常后行（pi 请求时坍缩进头部，估算近似加总）
    llmMessages.unshift({
      role: 'system',
      content: systemPrompt,
      toolsAdded: toolDeclarations() as never,
      timestamp: 0
    })
  }
  let systemTextTokens = 0
  let toolDefs = 0
  const rest: ReturnType<typeof convertToLlmMessages> = []
  for (const message of llmMessages) {
    if (message.role === 'system') {
      // content 可能是 string 或 TextContent[]；getSystemMessageText 统一成
      // 模型可见的完整文本（含 sections 渲染），与 estimate 内部口径一致
      systemTextTokens += estimateTextTokens(getSystemMessageText(message))
      if (message.toolsAdded) toolDefs += estimateTextTokens(JSON.stringify(message.toolsAdded))
      continue
    }
    rest.push(message)
  }
  return {
    systemPrompt: systemTextTokens,
    toolDefs,
    messages: rest.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
    total: estimateContextTokens(llmMessages).tokens
  }
}

/** 盘上文档格式版本（v2 = summary-only；v1 兼容读取，见 asStoredSession） */
const SESSION_FILE_VERSION = 2
/** 会话集合名（StorageDriver 顶层目录 ~/.cogent/sessions/） */
const SESSION_COLLECTION = 'sessions'
/** 首条消息截断为会话标题的长度上限 */
const TITLE_MAX_CHARS = 24
/** 拒绝附言截断上限（D2：防长附言打爆工具结果，与 D8 截断纪律同源） */
const APPROVAL_MESSAGE_MAX_CHARS = 2_000
const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_PROVIDER = 'anthropic'

export class SessionManager implements CogentKernel {
  private sessions = new Map<string, Session>()
  private streaming = new Map<string, StreamingState>()
  /**
   * 手动压缩进行中的会话（并发护栏）：pi.compact() 是 async RPC，窗口期
   * submit/continueSession 需同步拒绝（pi prompt 对压缩窗口的 throw 发生在
   * 异步段，落不到"受理即拒"的协议形态）。自动压缩（threshold/overflow）由
   * pi 在 prompt 生命周期内自管，不经此集
   */
  private compacting = new Set<string>()
  /**
   * length 续写剩余次数(按会话):submit/手动续写时重置为 3。
   * agent_settled(抑制终态)与 settleRun(注入续写)两处同读 —— 前者据此抑制
   * 终态(续写还会接着跑),后者据此决定是否注入续写消息并扣减
   */
  private continuationBudget = new Map<string, number>()
  /**
   * 挂起中的审批（D4/D5）：approval.request 发出 → 链式 beforeToolCall 的
   * Promise 悬着等 approval.respond。value 存 sessionId（会话删除/退出时按会话
   * 批量收尾 —— 不 resolve 则 pi 的 await 永悬、该 run 永不结束）+ 工具类别
   * （respond 的 always='workspace' 落规则时要知道落哪类，审批交互升级 D3）。
   */
  private pendingApprovals = new Map<
    string,
    { sessionId: string; kind: ToolKind; resolve: (result: { block: boolean; reason?: string }) => void }
  >()
  /**
   * 挂起中的提问（交互座 4c-2，pendingApprovals 同款骨架）：ask_user 的
   * execute 悬着等 question.respond。三路收尾：respond（作答）/
   * signal abort（取消 —— abort 的兜底 resolve，防 Promise 永悬）/
   * settleInteractions（会话删除/退出批量收口）。
   */
  private pendingQuestions = new Map<
    string,
    { sessionId: string; resolve: (result: { answers: AskAnswers; cancelled?: boolean }) => void }
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
  /** 审批规则表（构造注入；审批 ask 判定前查「始终允许此工作区」，D3） */
  private approvals: ApprovalRegistry
  /** MCP 客户端配置 store（构造注入；pi 会话装配时取快照，阶段 4a） */
  private mcpConfig: McpConfigStore
  /** pi 运行时（目录 + 鉴权 + 请求路由；构造注入，index.ts 建于启动期） */
  private modelRuntime: ModelRuntime
  /** Cogent Host 根（pi 域 <root>/pi 的父目录，装配 pi 会话树用） */
  private hostRoot: string

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
    // pi 内置全部 provider 的模型目录（UI 下拉 + submit 模型解析仍走它）；
    // pi 内核的请求路由走 modelRuntime —— custom provider 经 registerNativeProvider
    // 双注册（见 custom-providers.ts），内置 provider 的 key 经凭据 sink 进 runtime
    this.models = builtinModels()
    this.customProviders = new CustomProviderRegistry(this.models, modelRuntime)
    this.customProviders.snapshotBuiltin()
    // 启动恢复：只拉摘要（惰性装配，见 Session.pi / Session.inspector 注释）。
    // 损坏（截断/手改/旧版本形状）逐文件隔离：报错 + 改名 .corrupt 旁置 + 继续
    // 恢复其余会话 —— 单文件损坏若任其炸构造器，引擎进程拒启 = 全部会话陪葬，
    // 这超出了约定.md §1.1「报错而非静默重建」的立法本意（可见性保留：stderr
    // 诊断 + 旁置文件可查，且该会话确实不加载 = 不静默重建）
    for (const id of this.storage.ids(SESSION_COLLECTION)) {
      try {
        const doc = asStoredSession(this.storage.get(SESSION_COLLECTION, id), id)
        this.sessions.set(doc.summary.id, {
          summary: doc.summary,
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
   * 工具的基根（D2 修订）：绑定根，无绑定时兜底用户主目录 —— 桌面应用语境下
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
    session.systemPrompt ??= buildSystemPrompt(this.workspaceRoots(session), this.toolRoots(session))
    return session.systemPrompt
  }

  /** 自定义 provider / 内置 baseUrl 覆盖的全量同步（providers.custom.sync 委托） */
  syncCustomProviders(defs: CustomProviderDef[], overrides: ProviderOverrideDef[]): number {
    return this.customProviders.sync(defs, overrides)
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
    const now = Date.now()
    // 模式缺省解析（F6）：直驱协议/其他宿主不带 permissionMode 时按项目默认
    // 兜底（renderer 走自己的同规则链，显式值优先两不冲突）。项目也没设 →
    // 不带字段 = ask（协议缺省语义，旧宿主不破）
    const defaultMode =
      params.permissionMode !== undefined
        ? params.permissionMode
        : this.projectByIdOrCwd(params.cwd, params.projectId)?.defaultPermissionMode
    // UUID 而非自增序号：自增在持久化后重启必然撞号（旧盘 s-1 vs 新会话 s-1）
    const summary: SessionSummary = {
      id: crypto.randomUUID(),
      title: params.title?.trim() || '新会话',
      createdAt: now,
      updatedAt: now,
      ...(params.cwd !== undefined && { cwd: params.cwd }),
      ...(params.projectId !== undefined && { projectId: params.projectId }),
      ...(defaultMode !== undefined && { permissionMode: defaultMode }),
      ...(params.planEnabled === true && { planEnabled: true })
    }
    this.sessions.set(summary.id, { summary, todos: [] })
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
      回复 —— 转录由 pi 照常落盘，只是会话从主列表消失（agent_settled 不受影响） */
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
    // pi 内核整拆（abort 全部运行中工作 + 拆钩，agent-session dispose 语义）
    session.pi?.dispose()
    // 挂起审批/提问先收尾再拆会话：resolve 让挂起中的 await 落地、
    // run 正常走完收尾路径（事件转译要能找到会话，先 settle 后删）
    this.settleApprovals(sessionId, '会话已删除')
    this.settleInteractions(sessionId)
    // pi 转录真源随删（JSONL 只被本会话引用；惰性未装配的会话没有 pi 文件）
    const piFile = session.pi?.sessionManager.getSessionFile()
    if (piFile !== undefined) {
      try {
        rmSync(piFile, { force: true })
      } catch (error) {
        // 删文件失败不拦会话删除（外部世界失败是常态）；孤儿 JSONL 留待手清
        process.stderr.write(`[host] pi 会话文件删除失败（${sessionId}）: ${(error as Error).message}\n`)
      }
    }
    this.sessions.delete(sessionId)
    this.streaming.delete(sessionId)
    this.compacting.delete(sessionId)
    this.storage.delete(SESSION_COLLECTION, sessionId)
    // 观测记录随会话清理（聊天转录同生共死，不留孤儿文件）
    this.inspectStore.delete(sessionId)
    return true
  }

  /**
   * 会话消息转录（session.messages 响应）：pi 消息[] → ChatMessage[]。
   * 呈现口径恒走 pi JSONL 全量回查（factory readPiTranscript：影子区/多代
   * 压缩条全保留，D9 保留式；pi 的 agent.state.messages 是**上下文口径**的
   * 裁剪投影，压缩后影子区消失，不能作历史呈现源）。pi JSONL 不存在时回落
 * v1 旧转录（未导入的历史会话）。运行中的半截流式消息不在 JSONL
 * （message_end 才落盘）—— 流式期宿主以事件流增量呈现为主，不受影响。
   */
  messages(sessionId: string): ChatMessage[] {
    const session = this.requireSession(sessionId)
    const source: AgentMessage[] =
      readPiTranscript(this.workspaceRoots(session)[0] ?? homedir(), this.hostRoot, sessionId) ??
      session.legacyTranscript ??
      []
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
    const systemPrompt = session.pi?.systemPrompt ?? this.ensureSystemPrompt(session)
    for (let i = projected.length - 1; i >= 0; i--) {
      const m = projected[i]
      if (m.role === 'assistant' && m.usage) {
        m.usage = { ...m.usage, contextEstimate: estimateContext(source, systemPrompt) }
        break
      }
    }
    return projected
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

  /** pi catalog → 协议模型摘要（UI 下拉数据源；key 配置状态在 credentials.list 单独查） */
  listModels(): { models: ModelSummary[]; defaultModel: { provider: string; id: string } } {
    return {
      defaultModel: { provider: DEFAULT_PROVIDER, id: DEFAULT_MODEL },
      models: this.models.getModels().map((m) => {
        // 压缩触发占比随目录下发：pi reserve 制真值口径
        // （1 − min(16384, ctx/4)/ctx）—— 指示器预警线画引擎真实触发线，
        // 画线偏离真值 = 用户看到"未到线就压了"
        const ratio = piTriggerRatio(m.contextWindow)
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
          // NaN（窗口缺数据的怪模型）不带 → 渲染端回落 0.9
          ...(Number.isFinite(ratio) && { compactionThresholdRatio: ratio })
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
  //
  // 受理与执行的时序（owner 小图，涉及会话状态/异步链路，约定.md 硬规则 5）：
  //
  //   submit(同步段)          异步段（driveRun）                    终态（事件）
  //   ───────────────         ───────────────────────              ────────────
  //   requireSession          ensurePiSession（惰性+导入）          agent_settled
  //   根目录复查              setModel/setThinkingLevel             ├ errorMessage→run.failed
  //   busy 查 streaming/      pi.prompt(text)                      │   （pi 内聚恢复
  //     compacting            └→ pi 内聚：重试/溢出压缩             │    已全部消化完）
  //   模型目录解析(同步throw)     /阈值压缩（不外显）               ├ lengthContinuable
  //   标题/updatedAt/persist  settleRun：AUTO_CONTINUE              │   → 抑制（续写链接管）
  //   run.started             链（每段又是一个 prompt               └ 否则 → run.completed
  //   streaming.set           生命周期，逐段 agent_settled）
  //
  //   streaming 的生灭窗口 ⊇ pi 的运行窗口（受理→终态），故 busy 判定只查它。

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
  submit(sessionId: string, text: string, model?: string, thinkingLevel?: string, provider?: string): void {
    const session = this.requireSession(sessionId)
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

    // 首条消息命名会话（恢复的旧会话标题已命名，不会覆盖）
    if (session.summary.title === '新会话') {
      session.summary.title = text.trim().slice(0, TITLE_MAX_CHARS) || session.summary.title
    }
    session.summary.updatedAt = Date.now()
    this.persist(sessionId)

    this.notify('run.started', { sessionId })
    this.ensureInspector(session).runStarted(text, this.ensureSystemPrompt(session), thinkingLevel ?? 'off')
    this.streaming.set(sessionId, {
      messageId: `m-${crypto.randomUUID()}`,
      segments: [],
      text: '',
      thinking: '',
      tools: []
    })
    this.continuationBudget.set(sessionId, AUTO_CONTINUE_LIMIT)
    // 异步段的三类失败（装配炸 / prompt 前置校验拒 / 续写链异常）都收口到
    // run.failed —— run.started 已发，宿主在等终态事件，不能让拒绝裸奔
    void this.driveRun(session, text, target, thinkingLevel).catch((error: unknown) => {
      this.streaming.delete(sessionId)
      this.notify('run.failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
    })
  }

  /** submit 异步段：装配 pi 内核 → 应用模型/思考档 → prompt → 续写链收尾 */
  private async driveRun(
    session: Session,
    text: string,
    model: Model<Api> | undefined,
    thinkingLevel: string | undefined
  ): Promise<void> {
    const pi = await this.ensurePiSession(session)
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
    await pi.prompt(this.skillStore.expandSkillCommand(text, this.workspaceRoots(session)[0]))
    await this.settleRun(session, pi)
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
  private async settleRun(session: Session, pi: AgentSession): Promise<void> {
    const sessionId = session.summary.id
    for (;;) {
      // 失败/中止：终态已由 agent_settled 发出（errorMessage 留痕于 pi Agent）
      if (pi.agent.state.errorMessage) return
      if (!this.lengthContinuable(pi.agent, sessionId)) return
      this.continuationBudget.set(sessionId, (this.continuationBudget.get(sessionId) ?? 0) - 1)
      await pi.prompt(AUTO_CONTINUE_MESSAGE)
    }
  }

  /**
   * 手动续写入口(session.continue,截断动作条「继续生成」):对末条 length
   * 截断注入显式 continue 消息再跑。与自动路同消息同链,预算重新给满
   * (用户点按钮 = 明确要继续);自动路的单 run 已收尾,这里是 UI 眼里的
   * 新一段(run.started + 新 streaming),完成后 run.completed 的 stopReason
   * 非 length 会自然熄掉宿主的截断提示。
   */
  async continueSession(sessionId: string): Promise<{ ok: true }> {
    const session = this.requireSession(sessionId)
    if (this.streaming.has(sessionId) || this.compacting.has(sessionId)) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '会话正在回复中，无法续写')
    }
    const pi = await this.ensurePiSession(session)
    const last = pi.agent.state.messages.at(-1)
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
    try {
      await pi.prompt(AUTO_CONTINUE_MESSAGE)
      await this.settleRun(session, pi)
    } catch (error) {
      // pi.prompt 前置拒绝（鉴权/压缩窗口竞态等）：run.started 已发，宿主等
      // 终态 —— 清 streaming 补发 run.failed 后把错误照常交给 dispatch 转错
      // 误响应帧（手动动作要双通道显式反馈）
      this.streaming.delete(sessionId)
      this.notify('run.failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
    return { ok: true }
  }

  /**
   * 手动压缩入口（session.compact）→ pi AgentSession.compact()。
   * 无可压缩/刚压过以协议错误显式反馈（手动动作要明确结果；pi 的抛错文案
   * "Already compacted" / "Nothing to compact" 映射于此），失败原样上抛。
 * 压缩进度经 compaction_start/end 事件（转译层 → compaction.started/
 * completed）。
   */
  async compactSession(sessionId: string): Promise<{ tokensBefore: number; tokensAfter: number }> {
    const session = this.requireSession(sessionId)
    if (this.streaming.has(sessionId) || this.compacting.has(sessionId)) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, '会话正在回复中，请等待完成后再压缩')
    }
    this.compacting.add(sessionId)
    try {
      const pi = await this.ensurePiSession(session)
      const result = await pi.compact()
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
      this.compacting.delete(sessionId)
    }
  }

  abort(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    // pi.abort 是 async（等 run 收尾）；受理即返回（同步合同）。挂起审批经
    // signal listener 收尾（见 decideApproval），run 必然落地终态
    if (session.pi !== undefined) void session.pi.abort()
    return true
  }

  /** 进程退出前统一收尾（引擎随宿主关闭；pi dispose 内聚 abort 全部运行） */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.pi?.dispose()
    for (const sessionId of this.sessions.keys()) {
      this.settleApprovals(sessionId, '引擎退出')
      this.settleInteractions(sessionId)
    }
    this.sessions.clear()
    this.streaming.clear()
    this.compacting.clear()
  }

  // ———— 审批（docs/计划/工具系统与审批.md 第 4 步，D4/D5）————

  /**
   * 宿主裁决回流：resolve 挂起中的审批 Promise（审批交互升级 D2 扩
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
    // always 的语义校验在消费 pending 之前：无绑定根会话不落规则（防"全放主
    // 目录"的过大授权，D3 —— UI 不显示此项但协议直达，引擎侧是最后一道闸）；
    // 报错时请求未被消费，宿主仍可改发普通 respond
    if (always === 'workspace') {
      const roots = this.workspaceRoots(session)
      if (roots.length === 0) {
        throw new ProtocolError(RpcErrorCode.InvalidParams, '无绑定工作区的会话不支持「始终允许」')
      }
      // 允许本次 + 落工作区级规则（同 roots 集合幂等，见 ApprovalRegistry.add）
      this.approvals.add(roots, pending.kind)
    }
    this.pendingApprovals.delete(requestId)
    // 「允许，并切换为 X」（F6 定稿，zcode 同款）：本次放行 + 会话切模式 +
    // 记为项目默认（同一项目的新会话沿用）。无项目归属的会话只切当前会话
    let summary: SessionSummary | undefined
    if (switchMode !== undefined) {
      session.summary.permissionMode = switchMode
      this.persist(session.summary.id)
      summary = { ...session.summary }
      // 与 setPermission/setPlanMode 同款北向广播：审批面板切档是引擎侧改档，
      // 不广播则宿主权限钮不联动（session.summaryChanged 的统一语义）
      this.notify('session.summaryChanged', { summary })
      const projectId = this.projectIdOf(session)
      if (projectId !== undefined) this.projects.setDefaultPermissionMode(projectId, switchMode)
    }
    // 拒绝附言（D2「告诉模型接下来怎么做」）：进 block reason → pi 工具错误结果
    // 给模型。截断上限防打爆工具结果（与 D8 截断纪律同源）；加前缀让模型明确
    // 这是拒绝后的用户指示而非工具输出
    const denyReason =
      !approved && message !== undefined && message.trim() !== ''
        ? `用户拒绝了本次操作。用户指示：${message.trim().slice(0, APPROVAL_MESSAGE_MAX_CHARS)}`
        : '用户拒绝了本次操作'
    pending.resolve(approved ? { block: false } : { block: true, reason: denyReason })
    return { ok: true, ...(summary !== undefined && { summary }) }
  }

  /**
   * 会话级权限切换（权限模式菜单）：summary 记账 + 落盘；审批判定读活值
   * （decideApproval 每次现读 summary.permissionMode），运行中切换即生效。
   * 提示词层通告由 factory 的 before_agent_start 扩展每轮现读活 mode 设
   * cogent_permission 节（D6）—— 本方法只管记账，不碰提示词。
   */
  setPermission(sessionId: string, mode: PermissionMode): SessionSummary {
    const session = this.requireSession(sessionId)
    session.summary.permissionMode = mode
    this.persist(sessionId)
    const summary = { ...session.summary }
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
    if (enabled) session.summary.planEnabled = true
    else delete session.summary.planEnabled
    this.persist(sessionId)
    const summary = { ...session.summary }
    this.notify('session.summaryChanged', { summary })
    return summary
  }

  /**
   * 工具调用裁决（链式 beforeToolCall 的桥端，D4 判定矩阵：ToolKind ×
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
  private decideApproval(
    session: Session,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<{ block: boolean; reason?: string }> {
    const meta = toolMeta(toolName)
    // 未知名字兜底 read：与事件转译同口径（pi 只执行注册过的工具，未知 =
    // 注册表 bug，stderr 已在转译层留诊断，这里按无害的只读放行）
    const kind = meta?.kind ?? 'read'
    if (kind === 'read') return Promise.resolve({ block: false })
    // 计划开关短路优先于档位放行（zcode permission/service.ts:148 同序）：
    // 「完全访问 + 计划开着」= 只读 —— 开关语义不受档位影响
    if (session.summary.planEnabled === true) {
      return Promise.resolve({ block: true, reason: '计划模式（只读）下写类与执行类工具被禁止' })
    }
    const mode = session.summary.permissionMode ?? 'ask'
    if (mode === 'auto') return Promise.resolve({ block: false })
    // 写类根内判定（软边界瘦身为"规则适用域"）：越界与否不再决定放拦，
    // 只决定 ask 是否可吃「始终允许」规则 —— 信任记忆的范围 = 根内写
    const roots = this.toolRoots(session)
    const withinRoots =
      kind !== 'write' && kind !== 'edit'
        ? true
        : typeof args.path !== 'string' || resolveWithinRoots(args.path, roots) !== null
    // 自主模式（D6 定稿）：文件写信任放行（不限根内 —— 越界也放，F6 定稿），
    // exec 等风险类照旧走询问（落到下方 ask 流程）
    if (mode === 'autonomous' && (kind === 'write' || kind === 'edit')) return Promise.resolve({ block: false })
    // ask（含 autonomous 的 exec）：根内（或非写类）先查规则表 —— 会话工作
    // 区根与某条同类别规则任一根命中即放行；无绑定根天然不命中，无根会话
    // 不落规则的 UI 语义在引擎侧自洽
    if (withinRoots && this.approvals.allows(this.workspaceRoots(session), kind)) {
      return Promise.resolve({ block: false })
    }
    // 弹审批面板并挂起（D5：无超时 —— 用户不点就一直等，宿主输入框变停止
    // 钮可 abort；signal abort 兜底 resolve）
    const requestId = `appr-${crypto.randomUUID()}`
    const sessionId = session.summary.id
    return new Promise((resolve) => {
      // 先登记再发事件：respondApproval 走这张表找 resolver，时序上不存在
      // 「事件未到、respond 先行」的窗口（宿主是收到事件才可能裁决）
      this.pendingApprovals.set(requestId, { sessionId, kind, resolve })
      this.notify('approval.request', {
        sessionId,
        requestId,
        toolName,
        kind,
        summary: meta !== undefined ? meta.summarize(args) : `${toolName}(?)`,
        ...(!withinRoots && { outsideRoots: true })
      })
      signal?.addEventListener('abort', () => {
        // 已被 respondApproval 消费则不动（用户裁决与中止竞态，先到先得）
        if (this.pendingApprovals.delete(requestId)) {
          resolve({ block: true, reason: '已中止' })
        }
      })
    })
  }

  /** 某会话的全部挂起审批以 block 收尾（删除/退出兜底；abort 走 signal listener，D5） */
  private settleApprovals(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.sessionId !== sessionId) continue
      this.pendingApprovals.delete(requestId)
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
    this.pendingPlans.delete(requestId)
    let summary: SessionSummary | undefined
    if (approved) {
      const session = this.requireSession(pending.sessionId)
      delete session.summary.planEnabled
      session.plan = { plan: pending.plan, approvedAt: Date.now() }
      this.persist(session.summary.id)
      summary = { ...session.summary }
      this.notify('session.summaryChanged', { summary })
    }
    const trimmed = message?.trim()
    pending.resolve(
      approved
        ? { approved: true }
        : { approved: false, ...(trimmed !== undefined && trimmed !== '' && { message: trimmed }) }
    )
    return { ok: true, ...(summary !== undefined && { summary }) }
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
    const building = this.buildPiSession(session).then((pi) => {
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
    const boundRoots = this.workspaceRoots(session)
    // MCP 快照（Pi-meme 快照语义）：pi 内核装配时定格 user+project 合并结果，
    // 之后改配置不影响本会话（新会话生效）。诊断（项目级越权条目等）不拦装配
    // —— 坏条目已在快照里剔除，MCP 是增益面，stderr 留痕即可
    const mcpSnapshot = this.mcpConfig.snapshot(boundRoots[0] ?? homedir())
    if (mcpSnapshot.errors.length > 0) {
      process.stderr.write(`[host] MCP 配置诊断（会话 ${sessionId}）: ${mcpSnapshot.errors.join('；')}\n`)
    }
    // 技能座（4b）：发现诊断装配期留痕一次（此后随 skills.list 回 UI；
    // 清单本身每回合活算 = 热刷新，诊断不拦装配 —— 技能是增益面）
    const skillDiagnostics = this.skillStore.snapshot(boundRoots[0] ?? homedir()).errors
    if (skillDiagnostics.length > 0) {
      process.stderr.write(`[host] 技能目录诊断（会话 ${sessionId}）: ${skillDiagnostics.join('；')}\n`)
    }
    const { session: pi, piSessionManager, createdNew } = await createPiSession({
      // pi 的 cwd = 工作区主根（无绑定时主目录兜底，同 toolRoots 语义）：
      // 项目发现（.gitignore/AGENTS.md）与会话目录编码都锚在它上；
      // 工具集 = pi 内置（tool-meta 的 COGENT_TOOL_NAMES，shell 按平台）
      cwd: boundRoots[0] ?? homedir(),
      hostRoot: this.hostRoot,
      sessionId,
      modelRuntime: this.modelRuntime,
      systemPrompt: this.ensureSystemPrompt(session),
      // 自定义段每回合活算（factory 的 before_agent_start 钩子消费）：权限
      // 通告读活 mode（运行中切档下一轮生效）；skills/todos/plan 快照无缓存
      //（UI 改动与手动改文件都下一回合生效 = 回合边界热刷新）
      sections: () => {
        const todos = todosSectionText(session.todos)
        return {
          cogent_permission: permissionSectionText(session.summary.permissionMode ?? 'ask'),
          ...(session.summary.planEnabled === true && { cogent_plan_active: planModeSectionText() }),
          skills: formatSkillsSection(this.skillStore.snapshot(boundRoots[0] ?? homedir()).skills),
          ...(todos !== null && { cogent_todos: todos }),
          ...(session.plan !== undefined && { cogent_plan: planSectionText(session.plan) })
        }
      },
      // 交互座（4c）：todo_write 落笔 → 会话状态 + 持久化 + 北向事件；
      // ask_user 挂起 → question.asked → respond/abort/settle 三路收尾；
      // plan 闭环 → enter_plan 开关 + submit_plan 挂起审批（plan.respond）
      customTools: [
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
              this.pendingQuestions.set(requestId, { sessionId, resolve })
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
      approval: {
        decide: (toolName, _toolCallId, args, signal) =>
          this.decideApproval(session, toolName, args, signal)
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

    // v1 旧转录一次性导入（只在 pi 树是新建时 —— 已有 JSONL 说明早前导入过，
    // 重导会整段重复）。compactionSummary → 压缩条（firstKeptEntryId=null 语义
    // 对齐），其余角色逐条 append；导入后清引用 + 盘上重写 v2（v2 文档不带
    // transcript 字段）
    if (createdNew && session.legacyTranscript !== undefined) {
      const legacy = session.legacyTranscript
      if (legacy.length > 0) {
        const { imported, skipped } = importLegacyTranscript(piSessionManager, legacy)
        if (skipped > 0) {
          process.stderr.write(
            `[host] 旧转录导入跳过 ${skipped} 条（非持久化角色，见 kernel/legacy-import.ts）\n`
          )
        }
        pi.refreshContext()
        if (imported > 0) {
          process.stderr.write(`[host] 旧转录已导入 pi 会话树（${imported} 条，会话 ${sessionId}）\n`)
        }
      }
      session.legacyTranscript = undefined
      this.persist(sessionId)
    }
    return pi
  }

  /**
   * 观测三钩挂载（factory 的 observe 回调）：**链式包裹**而非直赋 —— sdk.ts
   * 构造 Agent 时已占用三钩做扩展事件桥（before_provider_request 等），
   * 直赋会拆掉 pi 的接线。观测先行、原钩子后行、透传其返回值（onPayload
   * 契约 = 返回 undefined 保留原载荷 / 变换后载荷）。
   */
  private attachInspector(agent: Agent, session: Session): void {
    const inspector = (): SessionInspector => this.ensureInspector(session)
    const prevPayload = agent.onPayload
    agent.onPayload = (payload, model) => {
      inspector().apiRequest(payload, model)
      return prevPayload?.(payload, model)
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
   * summary 仍在内存，下次变更点重写补上。
   */
  private persist(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const doc: StoredSession = {
      version: SESSION_FILE_VERSION,
      summary: session.summary,
      // 空清单不落字段（旧文档形状不变；清单事件本身就是"清空"的真相源）
      ...(session.todos.length > 0 && { todos: session.todos }),
      ...(session.plan !== undefined && { plan: session.plan })
    }
    try {
      this.storage.put(SESSION_COLLECTION, sessionId, doc as unknown as Record<string, unknown>)
    } catch (error) {
      process.stderr.write(`[host] 会话落盘失败（${sessionId}，下次变更重试）: ${(error as Error).message}\n`)
    }
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
            // 段封存（计划 D6）：本轮 text/thinking + 本轮工具调用 → 一段
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
        session.inspector?.toolCompleted(
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
      case 'compaction_start': {
        // pi 压缩启动（manual = session.compact；threshold/overflow = pi 自动路，
        // 后者发生在 run 生命周期内，宿主据此可呈"压缩中"状态）
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
          // 摘要请求自身的账（D9）：不走 run 分段、不进回合统计 —— 宿主折叠
          // 条小字呈现；端点未报 usage 时缺省
          ...(result.usage !== undefined && { summaryUsage: projectUsage(result.usage) })
        })
        return
      }
      case 'agent_settled': {
        // 终态（每轮 prompt 生命周期恰一次，晚于全部内聚恢复/重试 —— 见类头
        // "终态纪律"）。正/负路径都在此收口
        const streaming = this.streaming.get(sessionId)
        if (!this.sessions.has(sessionId)) {
          this.streaming.delete(sessionId)
          return
        }
        session.summary.updatedAt = Date.now()

        // pi 约定：失败/中止在 Agent.state.errorMessage 留痕（stream error /
        // abort 也汇于此）→ run.failed
        if (session.pi?.agent.state.errorMessage) {
          const message = session.pi.agent.state.errorMessage
          this.streaming.delete(sessionId)
          session.inspector?.runFailed(message)
          // 分段终态：失败/中止前已封存的轮次照常投影 —— abort
          // 场景此前只有 message，已完成轮的 usage 不落宿主消息流，指示器
          // 在停止后停在旧值（数据其实在 pi 树，重开会话才回来）。已封存段
          // 里可能有 running 工具卡（打断在工具处）→ 标 blocked 同 store 侧
          // 失败收尾口径；相邻纯文本段并回（续写形态同 completed）
          if (streaming !== undefined) {
            if (streaming.usage) {
              // 分支内 session.pi 已收窄非空（errorMessage 守卫），直取；
              // systemPrompt getter 恒返 string（pi 渲染当前 options），无缺省路
              const estimate = estimateContext(
                session.pi.agent.state.messages,
                session.pi.systemPrompt
              )
              streaming.usage.contextEstimate = estimate
              const lastSegment = streaming.segments.at(-1)
              if (lastSegment?.usage) lastSegment.usage.contextEstimate = { ...estimate }
            }
            const segments = SessionManager.mergeContinuedSegments(streaming.segments)
            this.notify('run.failed', {
              sessionId,
              message,
              ...(segments.length > 0 && { messages: segments })
            })
            return
          }
          this.notify('run.failed', { sessionId, message })
          return
        }
        // length 截断可续写：抑制终态、streaming 保活 ——
        // settleRun 注入显式 continue 消息接着跑;预算尽或续写完成时由下一轮
        // agent_settled 正常收尾。抑制意味着本轮转录不重写盘:续写中途崩溃
        // 丢当前段（pi JSONL 已逐条落盘的除外），与"尽力落盘"语义一致可接受
        if (session.pi !== undefined && this.lengthContinuable(session.pi.agent, sessionId)) return
        this.streaming.delete(sessionId)

        // 上下文明细估算挂到本回合 usage 上（turn_end 逐轮累加的 usage 已聚合；
        // 明细只描述"此刻转录长什么样"，与轮次无关，算一次即可）。挂 usage 而非
        // 单独字段：renderer 旧数据无此字段自然降级（additive，见
        // MessageUsage.contextEstimate）。聚合与末段各挂一份 —— 指示器分子读的是
        // "末条带 usage 的消息"（分段终态下 = 末段），聚合份供兼容形态与观测
        // 快照，两处是独立对象不共享。盘上转录（pi 树）不带明细 —— 历史回查
        // 路径在 messages() 按需现算，两条路各自出同源数据（estimateContext
        // 纯转录函数，见其注释）
        if (streaming?.usage) {
          // system 段：piSession.systemPrompt = 当前完整渲染（自拼 + pi
          // 追加节），与请求组装同源；与历史回查路径（messages()）同表达式
          const estimate = estimateContext(
            session.pi?.agent.state.messages ?? [],
            session.pi?.systemPrompt ?? this.ensureSystemPrompt(session)
          )
          streaming.usage.contextEstimate = estimate
          const lastSegment = streaming.segments.at(-1)
          if (lastSegment?.usage) lastSegment.usage.contextEstimate = { ...estimate }
        }

        // 观测快照吃结构类型（顶层 text/thinking）—— 段化后顶层缓冲已清空，
        // 传各段聚合值（口径 = 拼接后总字符）
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
        // 相邻纯文本段合并（续写的呈现形态）：length 段 + 续写段
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
      // agent_start、message_start/end、agent_end（pi 版带 willRetry，终态已归
      // agent_settled）、queue_update、auto_retry_*、session_info_changed 等：
      // 协议暂无对应事件，转译为空（需要时再扩展协议）
      default:
        return
    }
  }

}

/**
 * pi Message[] → ChatMessage[]：取 user/assistant 的纯文本内容 + assistant
 * 用量三件套 + 工具调用投影。system 消息（prompt 载体）与 toolResult 消息
 * （配对进 toolCalls）不单独产出 —— 工具结果对 UI 是工具卡的尾部信息，
 * 不是独立消息（对模型才回灌成消息）。
 *
 * 输入源：pi 会话树投影（pi.agent.state.messages，压缩条以
 * compactionSummary 角色存活，session-manager 投影实证）或 v1 旧转录 ——
 * 两源同为 AgentMessage[]，投影规则不变。
 *
 * 2026-11-12 提为模块级导出函数（原 session 类私有方法，无实例状态）：
 * 单测直测（tests：D9 时间序落点/延迟 flush 的引擎侧回归钉），session
 * 内调用点不变。
 */
export function toChatMessages(messages: Array<AgentMessage | CompactionBarSource>): ChatMessage[] {
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
  // D9 保留式呈现位 = 时间序（压缩时刻），非转录切点：压缩条在转录里插在
  // 切点（影子区/活区的语义边界，保留区 20K 之前），但 UI 上应落在压缩
  // **发生**的地方（Codex 标记行形态，与渲染层 completed 手术同规则）——
  // 先暂存，遇到 timestamp 晚于它的首条消息前再落；转录其余部分本就
  // 时间序追加，此规则恰为"按时间序归位"。末尾 flush 兜底（压缩后无新
  // 回合的会话）。防御：两条 bar 间无消息时先落旧的保序（正常流不发生
  // —— 刚压完时间戳守卫拒绝无新内容的再压缩）
  let pendingBar: Omit<ChatMessage, 'id'> | undefined
  const flushBar = (): void => {
    if (pendingBar !== undefined) {
      result.push({ ...pendingBar, id: `c-${result.length}` })
      pendingBar = undefined
    }
  }
  for (const message of messages) {
    // pi Message 联合类型按 role 收窄
    if (message.role === 'compactionSummary') {
      flushBar()
      // 投影源的压缩条可能带 usage（readPiTranscript 自 CompactionEntry 补挂，
      // 见 CompactionBarSource）—— 历史折叠条的小字账由此与事件侧同源；
      // tokensAfter 树里无存（pi 只在 compaction_end 事件携带），保持缺省
      const bar = message as CompactionBarSource
      pendingBar = {
        role: 'compaction',
        content: message.summary,
        compaction: {
          tokensBefore: message.tokensBefore,
          ...(bar.usage !== undefined && { summaryUsage: projectUsage(bar.usage) })
        },
        timestamp: message.timestamp
      }
      continue
    }
    if (pendingBar !== undefined && message.timestamp > pendingBar.timestamp) flushBar()
    if (message.role === 'user') {
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
        // 用量三件套同投影：pi 转录的 assistant 消息 usage 必有，历史会话与
        // 流式结束态同一套数据源，老会话 UI 上也可见统计
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
  flushBar()
  return result
}
