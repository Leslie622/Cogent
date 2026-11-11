/**
 * 上下文压缩（批次 4，docs/计划-pi借鉴.md §4）—— 纯函数模块，I/O 与事件
 * 在 session.ts（上游同款分工：compaction.ts 头注 "Pure functions for
 * compaction logic. The session manager handles I/O"）。
 *
 * 照搬与裁剪（对照 reference/pi/packages/coding-agent/src/core/compaction/）：
 * - 照搬：compactionSummary 自定义消息角色 + convertToLlm 投影（上游
 *   core/messages.ts 的声明合并手法）、结构化摘要提示词（Goal/Progress/
 *   Key Decisions/Next Steps checkpoint + 迭代更新双提示词）、保留窗口
 *   切点算法（从尾回累计 token）、文件操作 XML 尾缀、对话文本化序列化
 *   （防模型把原文当对话继续）；
 * - 裁剪（线性转录结构差异，偷法第 1 则"接线照 Cogent"）：
 *   ① 切点只取 user 消息边界（回合原子）—— 上游可切 assistant 消息并配
 *   turn-prefix 二次摘要（split-turn），那是树状存储为精确命中预算的复杂度；
 *   线性转录里整回合保留/整回合摘要语义更清晰，单回合超窗口的极端场景
 *   留给 provider 溢出报错显式暴露；
 *   ② 文件操作表不落消息 details 结构化携带 —— 上次摘要的 <read-files>/
 *   <modified-files> XML 已在摘要文本里，UPDATE 提示词的 "PRESERVE exact
 *   file paths" 规则让文本自身成为载体，无需结构化转发；
 *   ③ 溢出恢复（overflow compact-and-retry）不搬 —— D7 定稿只做阈值 +
 *   手动双路，provider 溢出走 run.failed 显式暴露；
 *   ④ branch-summarization 整件不搬（会话树在远期池）。
 *
 * 触发阈值 D7 定稿 = 90% 百分比（上游是 reserveTokens 固定 16384 绝对值，
 * 对小窗口模型反而更严、对大窗口更松；百分比语义在各窗口下一致）。
 */
import type { AgentMessage, ThinkingLevel as SessionThinkingLevel } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message, ThinkingLevel, TranscriptContext } from '@earendil-works/pi-ai'
import { contentText, normalizeContext } from '@earendil-works/pi-ai'
import { estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'

/**
 * 单条消息 token 估算（类型域补丁）：pi-ai estimateMessageTokens 只认标准
 * 角色，压缩条按摘要文本估（与它转成 user 消息后的口径一致）。运行时压缩
 * 条只出现在 prevCompactionIndex 或更前，此处的分支是类型完备性兜底。
 */
function estimateAgentMessage(message: AgentMessage): number {
  return message.role === 'compactionSummary' ? estimateTextTokens(message.summary) : estimateMessageTokens(message)
}

// ———— 转录表示：压缩条消息（上游 core/messages.ts 同款声明合并） ————

/** 压缩条：会话曾在此处压缩，content 投影为 checkpoint 摘要全文 */
export interface CompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  /** 压缩前上下文估算（指示器回落与折叠条文案共用） */
  tokensBefore: number
  /** 压缩后上下文估算（同上；老消息无此字段走缺省） */
  tokensAfter?: number
  timestamp: number
}

/**
 * 声明合并扩展 pi 的 AgentMessage 联合（官方扩展通道，types.ts L355 注释
 * 原话 "Apps can extend via declaration merging"）。必须配合 Agent 的
 * convertToLlm 选项消费（见 convertToLlmMessages），否则 provider 请求
 * 组装遇到未知 role 会拒收。
 */
declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    compactionSummary: CompactionSummaryMessage
  }
}

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`

/**
 * AgentMessage[] → LLM Message[]：压缩条转 user 消息（前缀包裹，模型读作
 * "此前的历史被压缩成了这份摘要"），标准角色直通。两个消费者：
 * - Agent 的 convertToLlm 选项（每轮请求组装，agent-loop.ts L404 唯一转换口）；
 * - 上下文估算前置（estimateMessageTokens 对无 content 数组的自定义角色会炸，
 *   转换后与引擎 max_tokens 预算看到的载荷同源同形）。
 */
export function convertToLlmMessages(messages: AgentMessage[]): Message[] {
  return messages.map((message): Message =>
    message.role === 'compactionSummary'
      ? {
          role: 'user',
          content: [
            { type: 'text', text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX }
          ],
          timestamp: message.timestamp
        }
      : message
  )
}

// ———— 触发判定（D7：阈值 90%，自动默认开） ————

export const COMPACTION_THRESHOLD = 0.9
/** 保留窗口（token）：压缩后保留的近期对话量，上游同值。挂点按窗口夹紧
 *  （小窗口模型的 20K 可能大于窗口本身，保一半） */
export const KEEP_RECENT_TOKENS = 20_000

export function shouldCompact(contextTokens: number, contextWindow: number): boolean {
  // contextWindow <= 0 = 目录缺数据的怪模型，无从谈百分比 —— 不触发
  if (contextWindow <= 0) return false
  return contextTokens > contextWindow * COMPACTION_THRESHOLD
}

// ———— 切点（线性转录改造：user 消息边界 = 回合原子） ————

/**
 * 求保留区起点（原转录下标）。从尾往回累计 token，累计 ≥ keepRecentTokens
 * 时取 ≥ 当前位置的最近 user 边界（上游同向：宁可多保留，切点后移）。
 * 返回 undefined = 没有可切的 user 边界（无对话），或全部累计仍不满保留
 * 窗口（近期内容本就少，无可摘要）。
 *
 * prevCompactionIndex：既有压缩条下标（-1 = 无）。切点必须在其后 ——
 * 上次压缩的保留区归旧摘要管，不重复摘要。
 */
export function findCutPoint(
  messages: AgentMessage[],
  prevCompactionIndex: number,
  keepRecentTokens: number
): number | undefined {
  const cutCandidates: number[] = []
  for (let i = prevCompactionIndex + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') cutCandidates.push(i)
  }
  if (cutCandidates.length === 0) return undefined

  let accumulated = 0
  for (let i = messages.length - 1; i > prevCompactionIndex; i--) {
    // 区间内只会是标准角色（压缩条恒在 prevCompactionIndex 或更前），裸估安全
    accumulated += estimateAgentMessage(messages[i])
    if (accumulated >= keepRecentTokens) {
      // ≥ i 的最近边界；i 之后若无边界（i 在回合中段），后移到下一 user 起点
      return cutCandidates.find((c) => c >= i) ?? cutCandidates[cutCandidates.length - 1]
    }
  }
  return undefined
}

// ———— 压缩准备（纯计算，session.ts 消费） ————

/** 文件操作终表（XML 尾缀进摘要，帮模型压缩后仍记得动过哪些文件） */
export interface FileOperations {
  readFiles: string[]
  modifiedFiles: string[]
}

export interface CompactionPreparation {
  /** 进摘要的对话（标准角色；system 是提示词状态、压缩条归 previousSummary，均不进） */
  messagesToSummarize: AgentMessage[]
  /** 上次压缩的摘要文本（有则走 UPDATE 提示词迭代合并） */
  previousSummary?: string
  /** 保留区起点（原转录下标） */
  firstKeptIndex: number
  /** 压缩前上下文估算（与触发判定同一个数） */
  tokensBefore: number
  fileOps: FileOperations
  /** 被摘要区末条 timestamp —— 宿主折叠条的原位锚点（换掉这条之前的一切） */
  summarizedUntil: number
}

/**
 * 计算压缩方案。返回 undefined = 无可压缩（刚压完无新回合 / 近期内容不满
 * 保留窗口 / 转录没(user 开头的)对话）。system 消息不进摘要（提示词状态
 * 非对话，且重建时整体前置保留 —— 权限通告在转录里，丢了会静默失权限语义）。
 */
export function prepareCompaction(
  messages: AgentMessage[],
  keepRecentTokens: number,
  tokensBefore: number
): CompactionPreparation | undefined {
  // 末条已是压缩条 = 上次压缩后没有任何新内容
  if (messages.at(-1)?.role === 'compactionSummary') return undefined

  let prevCompactionIndex = -1
  let previousSummary: string | undefined
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === 'compactionSummary') {
      // 多条时取最后一条（正常运行至多一条 —— 重建时旧的必落在被摘要区被换掉）
      prevCompactionIndex = i
      previousSummary = message.summary
    }
  }

  const firstKeptIndex = findCutPoint(messages, prevCompactionIndex, keepRecentTokens)
  if (firstKeptIndex === undefined) return undefined

  const summarizeRange = messages.slice(prevCompactionIndex + 1, firstKeptIndex)
  const messagesToSummarize = summarizeRange.filter(
    (m) => m.role !== 'system' && m.role !== 'compactionSummary'
  )
  if (messagesToSummarize.length === 0) return undefined
  const lastSummarized = summarizeRange[summarizeRange.length - 1]

  return {
    messagesToSummarize,
    previousSummary,
    firstKeptIndex,
    tokensBefore,
    fileOps: extractFileOperations(messagesToSummarize),
    summarizedUntil: lastSummarized.timestamp
  }
}

/**
 * 重建压缩后转录：[全部 system 原序前置] + [新压缩条] + [保留区非 system]。
 * system 前置的理由：pi 的 systemPrompt getter 重放转录全部 system 消息，
 * 权限通告（[cogent:permission]）在转录里，随摘要丢弃会静默丢失权限语义；
 * 领头 system 消息（工作区+工具声明）是 ensureAgent 恢复时"已在首位不再
 * 补插"的判据，同样必须保留。压缩条 timestamp = now，恒新于保留区消息 ——
 * pi-ai estimateContextTokens 的时效守卫据此把保留区里的旧 usage 判为
 * "不能描述当前前缀"（estimate.ts L80 注释点名 compaction summary 场景），
 * 压缩后估算自动退回纯字符口径，不会拿着旧账虚报。
 */
export function rebuildTranscript(
  messages: AgentMessage[],
  preparation: CompactionPreparation,
  summary: string,
  tokensAfter: number
): AgentMessage[] {
  const systems = messages.filter((m) => m.role === 'system')
  const kept = messages.slice(preparation.firstKeptIndex).filter((m) => m.role !== 'system')
  const bar: CompactionSummaryMessage = {
    role: 'compactionSummary',
    summary,
    tokensBefore: preparation.tokensBefore,
    tokensAfter,
    timestamp: Date.now()
  }
  return [...systems, bar, ...kept]
}

// ———— 文件操作提取（上游 compaction/utils.ts 照搬；工具名恰好同款） ————

/** 从 assistant 消息的 toolCall 块提取读写文件表：write/edit → modified，
 *  read 只读未改 → read。Cogent 工具名与上游一致（read/write/edit），
 *  照搬即用；bash 等其他工具不入表（上游同口径）。 */
function extractFileOperations(messages: AgentMessage[]): FileOperations {
  const read = new Set<string>()
  const modified = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue
      const path = typeof block.arguments.path === 'string' ? block.arguments.path : undefined
      if (path === undefined) continue
      if (block.name === 'write' || block.name === 'edit') modified.add(path)
      else if (block.name === 'read') read.add(path)
    }
  }
  return {
    readFiles: [...read].filter((f) => !modified.has(f)).sort(),
    modifiedFiles: [...modified].sort()
  }
}

/** 文件表 → XML 尾缀（无操作返回空串，摘要原样收尾） */
export function formatFileOperations(ops: FileOperations): string {
  const sections: string[] = []
  if (ops.readFiles.length > 0) sections.push(`<read-files>\n${ops.readFiles.join('\n')}\n</read-files>`)
  if (ops.modifiedFiles.length > 0) sections.push(`<modified-files>\n${ops.modifiedFiles.join('\n')}\n</modified-files>`)
  return sections.length === 0 ? '' : `\n\n${sections.join('\n\n')}`
}

// ———— 对话文本化（上游 utils.ts serializeConversation 照搬） ————

/** 工具结果进摘要的截断上限（字符）—— 摘要要的是"发生了什么"，不是全文 */
const TOOL_RESULT_MAX_CHARS = 2000

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}

/**
 * 对话序列化成带角色标注的纯文本进 <conversation> 标签 —— 模型读的是
 * "待总结的材料"而非可续写的对话（直接喂消息会被当上下文继续）。
 * thinking 不序列化（上游同口径：重放的思考常被方言丢弃，白占摘要请求）；
 * toolResult 截 2000 字符。
 */
function serializeConversation(messages: AgentMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = contentText(message.content, '')
      if (text !== '') parts.push(`[User]: ${text}`)
    } else if (message.role === 'assistant') {
      const toolCalls: string[] = []
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue
        const args = Object.entries(block.arguments as Record<string, unknown>)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')
        toolCalls.push(`${block.name}(${args})`)
      }
      if (message.content.some((block) => block.type === 'text')) {
        parts.push(`[Assistant]: ${contentText(message.content)}`)
      }
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`)
    } else if (message.role === 'toolResult') {
      const text = contentText(message.content, '')
      if (text !== '') parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`)
    }
  }
  return parts.join('\n\n')
}

// ———— 摘要提示词（上游 compaction.ts 照搬） ————

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

/** 组装摘要请求的用户提示：<conversation> + 可选 <previous-summary> + 指令 */
export function buildSummarizationPrompt(preparation: CompactionPreparation): string {
  let promptText = `<conversation>\n${serializeConversation(preparation.messagesToSummarize)}\n</conversation>\n\n`
  if (preparation.previousSummary !== undefined) {
    promptText += `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n`
  }
  promptText += preparation.previousSummary !== undefined ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT
  return promptText
}

/** 摘要请求的 provider context（独立小请求：系统提示词 + 单条用户消息） */
export function buildSummarizationContext(promptText: string): TranscriptContext {
  return normalizeContext({
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: promptText }], timestamp: Date.now() }]
  })
}

/**
 * 摘要响应的安全判定（上游 getSummarizationFailure 照搬）：error / length
 * 停因的半截文本不能当会话检查点（length 截断的摘要缺尾部章节，续聊会
 * 拿着自以为完整的假检查点工作）。返回错误文案，合格返回 undefined。
 */
export function summarizationFailure(response: AssistantMessage): string | undefined {
  if (response.stopReason === 'error') {
    return `压缩摘要生成失败: ${response.errorMessage ?? '未知错误'}`
  }
  if (response.stopReason === 'length') {
    return '压缩摘要生成失败: 输出被 token 上限截断，摘要不完整'
  }
  if (response.content.some((block) => block.type === 'toolCall')) {
    return '压缩摘要生成失败: 模型尝试调用工具而非输出摘要'
  }
  return undefined
}

/**
 * 摘要 thinkingLevel 选项（上游 createSummarizationOptions 同判定）：仅推理
 * 模型且会话开了思考才带 —— 摘要任务不需要重度推理，跟随会话设置是为了
 * 尊重用户对成本/质量的既有选择。参数是 agent 侧 ThinkingLevel（含 'off'），
 * 返回值是 pi-ai 请求选项的 ThinkingLevel（不含 'off'，两个类型域别混）。
 */
export function summarizationThinkingLevel(
  modelReasoning: boolean,
  sessionLevel: SessionThinkingLevel
): { reasoning: ThinkingLevel } | Record<string, never> {
  return modelReasoning && sessionLevel !== 'off' ? { reasoning: sessionLevel } : {}
}
