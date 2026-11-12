/**
 * 上下文压缩（批次 4，docs/计划-pi借鉴.md §4）—— 纯函数模块，I/O 与事件
 * 在 session.ts（上游同款分工：compaction.ts 头注 "Pure functions for
 * compaction logic. The session manager handles I/O"）。
 *
 * 照搬与裁剪（对照 reference/pi/packages/coding-agent/src/core/compaction/）：
 * - 照搬：compactionSummary 自定义消息角色 + convertToLlm 投影（上游
 *   core/messages.ts 的声明合并手法）、结构化摘要提示词（Goal/Progress/
 *   Key Decisions/Next Steps checkpoint + 迭代更新双提示词）、保留窗口
 *   切点算法（从尾回累计 token）、文件操作 XML 尾缀；
 *   对话文本化序列化（<conversation> 防续写）已被完备化 R4 撤下 —— 摘要
 *   请求改为被摘要区原消息直传 + 指令内联（真前缀缓存复用，见摘要请求节），
 *   防续写意图改由指令护栏段承担；
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
 * 触发阈值：批次 4 D7 定稿 90% 百分比 → 完备化批次 R1 升级为
 * dsh 同构公式 max(ctx×0.5, min(ctx×0.9, ctx−ROOM_FLOOR))（拆小窗输出预算
 * 饿死死锁，见 docs/方案-上下文压缩.md §4 死锁复盘），并支持 ModelDef
 * 的按模型覆盖（触发判定节）。
 *
 * 转录表示（D9 验收修正，2026-11-12）：**保留式** —— 压缩不删除被摘要区，
 * 只在切点原位插入压缩条；影子区（末条压缩条之前的历史）不再发给模型
 * （convertToLlmMessages 投影裁剪），但历史回查/落盘/重启复原完整保留。
 * 对齐 Codex「标记行原位、旧消息可滚」的主流形态（GUI 验收实测销毁式
 * 呈现不可接受）；方案 D7 的追加式远期件由此拉近为保留式变体落地。
 */
import type { AgentMessage, ThinkingLevel as SessionThinkingLevel } from '@earendil-works/pi-agent-core'
import type {
  Api,
  AssistantMessage,
  Message,
  ThinkingLevel,
  ToolResultMessage,
  TranscriptContext
} from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai'
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { CompactionParamsOverride, MessageUsage } from '../../protocol'

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
  /** 摘要调用自身的用量（D9 验收后增补）：摘要不走 run 分段，账不进回合
   *  统计 —— 落在压缩条上随历史持久（重启后折叠条仍可见） */
  summaryUsage?: MessageUsage
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

/**
 * 压缩条投影前导语(dsh CHECKPOINT_PREAMBLE 同款措辞,完备化 R4):把摘要
 * 框定为「既定背景」而非「压缩事件」—— 模型直接续任务,不复述也不承认
 * 检查点。旧的 pi 前缀("history before this point was compacted…")会诱导
 * 模型把压缩本身当话题,dsh 措辞消除这层噪音。标签仍用 Cogent 一贯的
 * <summary>(dsh 是 <compacted-summary>,语义等价,不跟)。
 */
export const COMPACTION_SUMMARY_PREFIX = `This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<summary>
`
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`

/**
 * AgentMessage[] → LLM Message[]（D9 保留式投影）：[全转录 system 原序] +
 * [末条压缩条 → user 摘要消息（前缀包裹，模型读作"此前的历史被压缩成了
 * 这份摘要"）] + [末条压缩条之后的非 system 消息]。影子区（末条压缩条之前
 * 的历史对话）不进请求 —— 保留式转录里它是纯历史，语义已被摘要吸收；
 * 多条压缩条只认最后一条（更早的及其影子区一并丢弃，previousSummary 在
 * 压缩时已合并进末条）。无压缩条时返回原引用直通（热路径零拷贝）。
 * 消费者（全部经此单点，投影一改、请求组装与 token 估算自动一致）：
 * - Agent 的 convertToLlm 选项（每轮请求组装，agent-loop.ts L404 唯一转换口）；
 * - 上下文估算前置 6 处（session.ts 触发判定/溢出恢复/轮间钩子/tokensAfter）；
 * - 摘要请求重放（buildSummarizationContext）。
 */
export function convertToLlmMessages(messages: AgentMessage[]): Message[] {
  let lastBarIndex = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'compactionSummary') lastBarIndex = i
  }
  if (lastBarIndex === -1) return messages as Message[]
  const bar = messages[lastBarIndex] as CompactionSummaryMessage
  // system 全局收集而非只取活区：权限通告等状态消息可能落在影子区（原
  // rebuildTranscript 前置 system 的意图改由投影接管），随摘要丢弃会静默
  // 失权限语义；领头 system 的工具声明重放同理
  const result: Message[] = []
  for (const message of messages) {
    if (message.role === 'system') result.push(message)
  }
  result.push({
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_SUMMARY_PREFIX + bar.summary + COMPACTION_SUMMARY_SUFFIX }],
    timestamp: bar.timestamp
  })
  for (let i = lastBarIndex + 1; i < messages.length; i++) {
    if (messages[i].role !== 'system') result.push(messages[i] as Message)
  }
  return result
}

// ———— 触发判定（完备化 R1：dsh 同构公式 + 特小窗阈值兜底 + 按模型覆盖） ————

/** 占比触发线（缺省；dsh 0.8 / Codex 90% 封顶同量级，pi 靠 reserve 兜） */
export const COMPACTION_THRESHOLD = 0.9
/**
 * 绝对余量下限（token）：触发线取「占比线 / 余量线」先到者。构成 =
 * 4096 边际（pi clampMaxTokensToContext 同款固定边际）+ 2048 思考 typical
 * + 1024 答案保底（pi clampThinkingBudgetToAnswerRoom）+ 余量；dsh
 * headroomTokens 64K 的桌面版。这是 R1 拆小窗死锁的治本件：20K 窗在 59%
 * 即触发，room 恒 ≥ 8K，思考吃不光工具调用的预算。
 */
export const ROOM_FLOOR_TOKENS = 8_192
/**
 * 特小窗阈值兜底占比：触发线恒 ≥ ctx×0.5。绑定区 ctx < 2×ROOM_FLOOR = 16K
 * —— 余量线在那儿低于半窗，不兜底的话 8K 窗阈值 = 8K−8K = 0 每回合必触发。
 * 兜底对象是**阈值**而非 ROOM_FLOOR（后者按字面取 max 在 8K 窗是 no-op，
 * 计划评审修正 2026-11-12）；等价写法 = roomFloor 取 min(ROOM_FLOOR, ctx/2)。
 * 防呆线不是调优钮，不做用户参数。
 */
const SMALL_WINDOW_THRESHOLD_FLOOR = 0.5
/** 保留窗口（token）：压缩后保留的近期对话量，上游同值。挂点按窗口夹紧
 *  （小窗口模型的 20K 可能大于窗口本身，保一半） */
export const KEEP_RECENT_TOKENS = 20_000

/**
 * Model 对象上的压缩参数覆盖通道（声明合并，同上方 CustomAgentMessages 的
 * 官方扩展手法）：custom-providers 的 buildModel 从 ModelDef.compaction 透传，
 * pi 自身不读、缺省无字段 = 走内建默认。解析序照 pi settings-manager 三级
 * 形态：模型覆盖 →（全局设置，S7 随高级面板补）→ 内建默认。
 */
declare module '@earendil-works/pi-ai' {
  // 类型参数表必须与原接口一致（合并语法要求），TApi 未用属刻意 —— 见上行注释
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Model<TApi extends Api> {
    compaction?: CompactionParamsOverride
  }
}

/**
 * 有效触发阈值（token）= max(兜底, min(占比线, 余量线))。两线的分界：
 * 占比线更低 ⟺ ctx×0.9 < ctx−8192 ⟺ ctx > 81920 —— 即 80K+ 窗维持 90%
 * 行为不变；16K–80K 窗走余量线（触发占比 = 1 − 8192/ctx，从 50% 平滑爬到
 * 90%）；<16K 窗被半窗兜底接管。contextWindow ≤ 0 = 目录缺数据的怪模型，
 * 无从谈阈值 → Infinity（不触发）。
 */
export function compactionThreshold(contextWindow: number, override?: CompactionParamsOverride): number {
  if (contextWindow <= 0) return Number.POSITIVE_INFINITY
  const thresholdRatio = override?.thresholdRatio ?? COMPACTION_THRESHOLD
  const roomFloor = override?.roomFloorTokens ?? ROOM_FLOOR_TOKENS
  return Math.max(
    contextWindow * SMALL_WINDOW_THRESHOLD_FLOOR,
    Math.min(contextWindow * thresholdRatio, contextWindow - roomFloor)
  )
}

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  override?: CompactionParamsOverride
): boolean {
  return contextTokens > compactionThreshold(contextWindow, override)
}

// ———— L1 prune(完备化 R3:dsh tool-result-pruner 数值与算法同款) ————

/** 单结果裁剪触发线(code point)—— dsh 源码默认 */
export const PRUNE_THRESHOLD_CHARS = 8_192
/** 保头(code point)—— dsh 源码默认 */
export const PRUNE_HEAD_CHARS = 4_096
/** 保尾(code point)—— dsh 源码默认 */
export const PRUNE_TAIL_CHARS = 1_024
/** middle 替换标记(dsh 同文)—— 模型与 UI 共同的审计痕迹 */
export const PRUNE_MARKER = '[... tool result middle pruned ...]'

/** code point 计量:UTF-16 代理对算 1(dsh 同款,防切半 emoji/CJK 扩展区) */
function codePointLength(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // 高代理且后随低代理 → 跳 2 个 UTF-16 单元计 1 个 code point
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** toolResult 内容块的类型别名(与 pi ToolResultMessage.content 同源) */
type ToolResultContent = ToolResultMessage['content']

/** 内容块的文本总量(code point,跨全部 text 块 —— 多块结果按合并口径判线) */
function measureBlocks(blocks: ToolResultContent): number {
  let n = 0
  for (const block of blocks) {
    if (block.type === 'text') n += codePointLength(block.text)
  }
  return n
}

/**
 * 裁一组内容块:头尾按**全局位置**保留(跨块连续计量,块边界落在保留区内的
 * 整块直通),被移除的 middle 只插一个 marker(首个与移除区相交的块)。
 * dsh pruneContent 同款算法;非 text 块原样保留(rich-block 顺序不动)。
 */
function pruneBlocks(blocks: ToolResultContent, totalChars: number): ToolResultContent {
  const removedStart = PRUNE_HEAD_CHARS
  const removedEnd = totalChars - PRUNE_TAIL_CHARS
  const pruned: ToolResultContent = []
  let consumed = 0
  let markerInserted = false
  for (const block of blocks) {
    if (block.type !== 'text') {
      pruned.push(block)
      continue
    }
    // 按 code point 切(代理对不切半),只有真正要裁的块才付 Array.from 的成本
    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
    const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
    if (marker !== '') markerInserted = true
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
    if (text.length > 0) pruned.push({ ...block, text })
    consumed = blockEnd
  }
  return pruned
}

/** L1 裁剪清单条目(协议 compaction.pruned.entries 的形状) */
export interface PrunedToolResult {
  toolCallId: string
  originalChars: number
  prunedChars: number
}

/**
 * 活区 L1:逐条 toolResult,文本总量超线才裁,**原位改写**消息对象(dsh 追加
 * shadow + surfaceOp 的投影式在 Cogent 线性转录下等价于直接换内容 —— 单写者
 * 无多消费者扣减需求,标记文本自身即审计痕迹)。幂等:裁后的结果 ≤ 阈值自然
 * 跳过。范围 = **活区含保留区**(末条压缩条之后;dsh pruneSession 裁整个当前
 * surface 同款 —— 只裁被摘要区的话小窗场景 L1 几乎必然不够,「L1 单独够、
 * 零摘要请求」不成立;保留区大结果同样只保头尾是 dsh 生产验证的取舍)。
 * 影子区(末条压缩条之前)不裁:D9 保留式下它不进请求,裁它纯浪费且会破坏
 * 保留的历史原文。
 * 无裁剪返回原数组引用(检查点热路径零拷贝)。
 */
export function pruneToolResults(messages: AgentMessage[]): {
  messages: AgentMessage[]
  pruned: PrunedToolResult[]
} {
  // 活区起点 = 末条压缩条之后(保留式;无压缩条 = 全转录)
  let liveStart = 0
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'compactionSummary') liveStart = i + 1
  }
  const pruned: PrunedToolResult[] = []
  const result = messages.map((message, index): AgentMessage => {
    if (index < liveStart || message.role !== 'toolResult') return message
    // 快路:UTF-16 长度 ≥ code point 数,快路不过线就免精确计量
    let utf16 = 0
    for (const block of message.content) {
      if (block.type === 'text') utf16 += block.text.length
    }
    if (utf16 <= PRUNE_THRESHOLD_CHARS) return message
    const originalChars = measureBlocks(message.content)
    if (originalChars <= PRUNE_THRESHOLD_CHARS) return message
    const content = pruneBlocks(message.content, originalChars)
    pruned.push({
      toolCallId: message.toolCallId,
      originalChars,
      prunedChars: measureBlocks(content)
    })
    return { ...message, content }
  })
  return pruned.length > 0 ? { messages: result, pruned } : { messages, pruned }
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
  let prevCompactionIndex = -1
  let previousSummary: string | undefined
  let lastBarTimestamp = 0
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === 'compactionSummary') {
      // 保留式转录可累积多条压缩条，恒取最后一条（其 summary 已合并前代）
      prevCompactionIndex = i
      previousSummary = message.summary
      lastBarTimestamp = message.timestamp
    }
  }
  // 刚压完快速路径（D9 保留式改写）：压缩条原位插在切点、不在末尾，旧判定
  // （末条是压缩条）永不命中 —— 不换守卫的话压缩刚结束再触发（手动连点/
  // 检查点复评）会把保留区重摘要一遍。新判定：末条压缩条之后不存在
  // timestamp 晚于它的非 system 消息（压缩条 timestamp = 压缩时刻，保留区
  // 消息恒早于它，压缩后的新回合恒晚于它）
  if (
    prevCompactionIndex >= 0 &&
    !messages.some(
      (m, i) => i > prevCompactionIndex && m.role !== 'system' && m.timestamp > lastBarTimestamp
    )
  ) {
    return undefined
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
 * 原位插入压缩条（D9 保留式，替代批次 4 的销毁式重建）：在保留区起点
 * （切点，恒为 user 边界 ≥ 1，领头 system 不受影响）插入标记条，被摘要区
 * **原地保留**为影子区 —— 历史回查/落盘/重启复原完整，发给模型的内容由
 * convertToLlmMessages 投影裁剪（system 全局收集的权限语义同样由投影接管，
 * 不再依赖重建时的前置手术）。
 *
 * 仍走 splice 原位手法（不换数组引用，S2 验收 400 bug 的纪律保留）：轮间
 * 钩子触发时 pi loop 手里还持着同一数组的旧引用（当轮 toolResult push、
 * 流式 partial 替换都落在这个引用上），换引用 = 两条线各写各的，当轮收尾
 * 消息双份落转录、请求里 tool_calls 配对重复。单点插入比整段 splice 更少
 * 触碰数组，引用共享语义不变。
 *
 * 压缩条 timestamp = now，恒新于影子区与保留区消息 —— pi-ai
 * estimateContextTokens 的时效守卫据此把保留区里的旧 usage 判为"不能描述
 * 当前前缀"（estimate.ts L80 注释点名 compaction summary 场景），压缩后
 * 估算自动退回纯字符口径，不会拿着旧账虚报。
 */
export function insertCompactionMarker(
  messages: AgentMessage[],
  preparation: CompactionPreparation,
  summary: string,
  tokensAfter: number,
  summaryUsage?: MessageUsage
): AgentMessage[] {
  const bar: CompactionSummaryMessage = {
    role: 'compactionSummary',
    summary,
    tokensBefore: preparation.tokensBefore,
    tokensAfter,
    ...(summaryUsage !== undefined && { summaryUsage }),
    timestamp: Date.now()
  }
  messages.splice(preparation.firstKeptIndex, 0, bar)
  return messages
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

// ———— 摘要请求（完备化 R4：指令内联 —— 摘要请求是主请求的真前缀） ————

/**
 * 摘要指令的护栏段(dsh 手法:指令作为最后一条 user 消息跟在被摘要区原消息
 * 之后,而非独立 summarizer system prompt)。保留会话自己的 system/工具声明/
 * 消息前缀,使这次辅助调用成为上一次真实请求的**真前缀** —— provider KV
 * cache 复用而非失效(dsh summarizer.ts 注释原话 "a genuine prefix of the
 * last routed request")。被摘要区原消息直传(不再 <conversation> 文本化):
 * token 更省、工具调用结构保真;「防把原文当对话续写」的意图由护栏段的
 * 显式规则承担(dsh 模板同款 "Do NOT continue")。
 */
const SUMMARIZATION_INSTRUCTION_GUARD = `You are now acting as a compaction engine for this conversation. Condense the conversation ABOVE into a structured checkpoint summary.

Do NOT continue the conversation. Do NOT respond to any questions in it. Output ONLY the structured summary — do not call any tool.`

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

Keep each section concise. Preserve exact file paths, function names, and error messages. Capture user feedback and explicit corrections faithfully. Do NOT mention this summarization request or that the context was compacted.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- Capture user feedback and explicit corrections faithfully
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

Keep each section concise. Preserve exact file paths, function names, and error messages. Do NOT mention this summarization request or that the context was compacted.`

/**
 * 组装摘要指令(最后一条 user 消息全文):护栏 + 可选 <previous-summary>
 * (迭代合并,旧检查点进指令而非靠模型从重放区里翻)+ 结构模板。
 */
export function buildSummarizationInstruction(preparation: CompactionPreparation): string {
  let instruction = SUMMARIZATION_INSTRUCTION_GUARD
  if (preparation.previousSummary !== undefined) {
    instruction +=
      `\n\nThe checkpoint you produce must merge with and supersede the PRIOR checkpoint in <previous-summary> tags:\n\n` +
      `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>`
  }
  return `${instruction}\n\n${preparation.previousSummary !== undefined ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT}`
}

/**
 * 摘要请求的 provider context(真前缀构造,R4):[会话 system 原序] +
 * [被摘要区原消息(convertToLlm 投影)] + [指令 user]。领头 system 的
 * toolsAdded(工具声明)与主请求逐字相同,中部 system(权限通告)由方言层
 * 合并领头 —— LLM 可见前缀与主请求等价。normalizeContext 在 systemPrompt/
 * tools 双缺省时原样放行 messages(transcript.js:createInitialSystemMessage
 * 双缺省返回 undefined),不会重造领头破坏前缀。
 */
/**
 * 摘要输出的保底预算(token):低于此值时摘要大概率被截断(8 节结构 ≈1–2K),
 * 触发降级。pi clampMaxTokensToContext 的边际是 4096,此处取「边际的一半」
 * 为可生成线 —— available 低于它 = 输出预算被夹死,重放策略必须收缩。
 */
const MIN_SUMMARY_OUTPUT_TOKENS = 2048

/**
 * 摘要请求的 provider context(真前缀构造 + **预算守卫**,R4 + 完备化验收
 * 修复 2026-11-12):首选 [会话 system 原序] + [被摘要区原消息] + [指令 user]
 * —— 与主请求真前缀对齐,KV cache 复用。但 20K 级小窗深度占用时,整转录
 * 重放会把 pi clampMaxTokensToContext 的输出预算夹到趋零
 * (available = ctx − input − 4096 ≈ 0),摘要写一个 token 就截断 —— 而
 * 压缩恰是为了腾空间,「要压缩先得有空间压缩」是鸡生蛋死结(验收实测:
 * 20K 窗 15.9K 占用,摘要必 length)。
 * 守卫:重放估算后若 available < 2048,降级为「被摘要区直传 + 精简指令」
 * —— 放弃前缀缓存(退化为无损失),换摘要请求自己的输出预算
 * (≈ ctx − 被摘要区 − 4096,验收场景 ≈10K,充裕)。被摘要区本身超预算的
 * 极端(单回合巨大)由 pi 夹制兜住,摘要照常尽力生成。
 */
export function buildSummarizationContext(
  systemMessages: Message[],
  preparation: CompactionPreparation,
  instruction: string,
  contextWindow: number
): TranscriptContext {
  const replay = normalizeContext({
    messages: [
      ...systemMessages,
      ...convertToLlmMessages(preparation.messagesToSummarize),
      { role: 'user', content: [{ type: 'text', text: instruction }], timestamp: Date.now() }
    ]
  })
  const replayInput = estimateContextTokens(replay.messages).tokens
  const available = contextWindow - replayInput - 4096
  if (available >= MIN_SUMMARY_OUTPUT_TOKENS || contextWindow <= 0) return replay
  // 降级:只送被摘要区(+指令),不带会话 system(省头 —— 摘要任务不需要
  // 工作区指令;指令自身含角色与护栏)。指令原样复用(迭代合并信息都在)
  return normalizeContext({
    messages: [
      ...convertToLlmMessages(preparation.messagesToSummarize),
      { role: 'user', content: [{ type: 'text', text: instruction }], timestamp: Date.now() }
    ]
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
