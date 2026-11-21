/** 历史呈现与搜索共用的纯投影；不装配模型、不做磁盘或上下文估算。 */
import type { Usage } from '@earendil-works/pi-ai'
import type { ChatMessage, MessageUsage, ToolCallRecord } from '../../protocol'
import type { AttachmentMessage, CompactionBarSource } from '../kernel/transcript'
import { toolMeta } from './tool-meta'
const AUTO_CONTINUE_PREFIX = '[cogent:continue]'

/**
 * 工具结果 → 一行摘要（tool.completed 事件与 ToolCallRecord.resultSummary 共用）。
 * 取 result.content 的文本块拼接（模型 facing 的结果即用户可读的结果），截 200
 * 字符 —— 摘要服务"一眼看懂发生了什么"，全文模型已在循环里消费过。
 */
export function summarizeToolResult(result: unknown): string {
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
export function extractResultDiff(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const details = (result as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return undefined
  const diff = (details as { diff?: unknown }).diff
  return typeof diff === 'string' ? diff : undefined
}

/** pi Usage → 协议 MessageUsage：只投影 UI 所需（cost 明细不带，total 一项即总账） */
export function projectUsage(usage: Usage): MessageUsage {
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
export function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

/**
 * 用量累加（工具循环多轮时 turn_end 逐轮到达，当前无工具 = 恒单轮直通）。
 * 口径 = 各轮之和：每轮请求都携带全量上下文重发，端点账单就是逐轮相加，
 * 这也是"本次回答共消耗多少"的计费真相，而非只看末轮。
 */
export function accumulateUsage(current: MessageUsage | undefined, add: MessageUsage): MessageUsage {
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
export function toChatMessages(messages: Array<AttachmentMessage | CompactionBarSource>): ChatMessage[] {
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
        sources: message.sourceId === undefined ? undefined : [{ id: message.sourceId, start: 0, end: (message.attachmentInput?.text ?? text).length }],
        role: 'user',
        turnId: message.fileContext?.turnId,
        fileContext: message.fileContext,
        content: (message as AttachmentMessage).attachmentInput?.text ?? text,
        ...((message as AttachmentMessage).attachmentInput !== undefined && { attachments: (message as AttachmentMessage).attachmentInput!.attachments }),
        ...((message as AttachmentMessage).attachmentInput?.directories !== undefined && { directories: (message as AttachmentMessage).attachmentInput!.directories }),
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
          fileRefs: Object.entries(message.toolFileRefs ?? {}).filter(([id]) => id === block.id || id.startsWith(block.id + '/')).flatMap(([, refs]) => refs),
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
        const offset = prev.content.length
        if (message.sourceId !== undefined) prev.sources = [...(prev.sources ?? []), { id: message.sourceId, start: offset, end: offset + content.length }]
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
        sources: message.sourceId === undefined ? undefined : [{ id: message.sourceId, start: 0, end: content.length }],
        role: 'assistant',
        turnId: message.fileContext?.turnId,
        fileContext: message.fileContext,
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
