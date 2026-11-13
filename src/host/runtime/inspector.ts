/**
 * 运行时控制台记录器（SessionInspector）—— 会话级观测数据的采集与留存。
 *
 * 定位（协议形状见 protocol/types.ts inspect 域；UI 消费端在 renderer 控制台窗口）：
 * 引擎每个底层动作（厂商请求 / SSE 分片 / 引擎轮次 / 工具执行）沉淀为一条
 * "摘要 + 按需详情"的观测条目；摘要经 notify('inspect.event') 实时外推，
 * 详情留内存等 inspect.entry 按需取。分离是刻意的：控制台没打开记录也照常进行
 * （打开能回看刚才的运行），而几百 KB 的请求体不进事件流（stdio 一行一帧，
 * 大载荷会把正常事件挤成慢流）。
 *
 * 数据从哪来（pi 原生观测口子，零魔改）：
 * - AgentOptions.onPayload / onResponse / onProviderStreamEvent：厂商 HTTP 往返
 *   三段 —— 发送前一刻的原生请求体（system/messages/tools/采样参数原样）、
 *   响应头、归一化**之前**的 SSE 分片。这是"接口层"条目的全部来源；
 * - SessionManager.translateEvent 旁路：pi AgentEvent 的 turn/run/tool 边界
 *   （"引擎层/会话层/工具层"条目）。归一化流式 delta（message_update）刻意
 *   不逐条记：原始层有 api.stream、归一化聚合有 turn.completed 的消息详情，
 *   再逐条记 delta 只剩噪音。
 *
 * 内存纪律（学习工具不能变成内存炸弹）：
 * - 摘要 / 详情各自环形上限，超限丢最老（详情被丢后 inspect.entry 报"已滚动丢弃"）；
 * - 单个详情块截断上限（长对话请求体可达几百 KB）；
 * - SSE 分片回调是高频路径，只存引用不序列化（pi 契约分片对象只读，引用安全），
 *   冲刷成条目时才一次性序列化。
 *
 * 尽力观测语义（唯一防御位，同 persist() 的外部世界行，约定.md §1.1）：
 * 记录挂在 pi 的请求路径与事件回调上，观测自身的故障（如载荷不可序列化）
 * 绝不许炸掉用户的一次对话 —— safeStringify 内部兜底记 stderr，其余逻辑
 * （数组推送 / notify）与既有代码同待遇不再包 try。
 */
import type { InspectEntryDetail, InspectEntryKind, InspectEntrySummary } from '../../protocol'
import type { InspectRecord } from '../storage'
import type { ProviderResponse } from '@earendil-works/pi-ai'

/** 摘要环形上限（条）。一 run 约 5~10 条，500 条 ≈ 最近几十次对话 */
const MAX_ENTRIES = 500
/** 详情环形上限（条）。详情是大头（每条可达几百 KB），上限显著低于摘要 */
const MAX_DETAILS = 150
/** 单个详情块截断上限（字符）。超长上下文的请求体到此为止，尾部标记截断 */
const MAX_BLOCK_CHARS = 300_000

/** 摘要产出回调：SessionManager 注入（包成 notify('inspect.event')） */
export type InspectEmit = (entry: InspectEntrySummary) => void

/** 详情块（record 内部用；protocol InspectEntryDetail.blocks 的构造形状） */
interface DetailBlock {
  name: string
  format: 'json' | 'text'
  content: string
}

/**
 * 序列化 + 截断。兜底 catch 的理由见文件头"尽力观测"：载荷是厂商 SDK 的请求
 * 对象，理论上可序列化（它自己要上 wire），但观测不该赌这个。
 */
function safeStringify(value: unknown): string {
  // undefined 入参单查（JSON.stringify(undefined) 运行时回 undefined 但签名是 string，
  // 类型上查不出来 —— 在输入侧查才诚实）
  if (value === undefined) return 'undefined'
  try {
    const text = JSON.stringify(value, null, 2)
    return text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS)}\n…[已截断，原始 ${text.length} 字符]` : text
  } catch (error) {
    process.stderr.write(`[host] inspector 载荷不可序列化: ${(error as Error).message}\n`)
    return '(不可序列化)'
  }
}

export class SessionInspector {
  private seq = 0
  private run = 0
  /** 当前 run 内的轮次计数（工具循环一 run 多轮；时间线分组内的 turn 编号） */
  private runTurns = 0
  private summaries: InspectEntrySummary[] = []
  private details = new Map<number, InspectEntryDetail>()
  /**
   * 进行中 API 调用的分片聚合态：onPayload 开档，冲刷点（turn 边界 / 下一请求 /
   * run 结束）关档成条。分片高频到达（一秒多拍），逐拍记条目只会淹没时间线，
   * 聚合成一条"共 N 片 + 逐片详情"才可读。
   */
  private streamAgg: { requestTs: number; firstChunkAt?: number; chunks: unknown[] } | null = null

  constructor(
    private emit: InspectEmit,
    /**
     * 落盘尾部记录（重启回看）：恢复摘要/详情与 seq/run 计数 —— 新 run 接续
     * 历史编号（重启后 Run #4 而非又从 #1 来），seq 同理，与控制台已载条目无缝衔接
     */
    seed: InspectRecord[] = [],
    /** 落盘钩子（InspectStore.append 注入）；缺省 = 纯内存模式 */
    private persist?: (record: InspectRecord) => void
  ) {
    this.summaries = seed.map((r) => r.e)
    for (const r of seed) {
      if (r.d !== undefined) this.details.set(r.e.seq, r.d)
    }
    this.seq = this.summaries.reduce((max, e) => Math.max(max, e.seq), 0)
    this.run = this.summaries.reduce((max, e) => Math.max(max, e.run), 0)
  }

  // ———— 会话层 ————

  /** run 开始（submit 受理后）：分组号 +1，并记本轮生效的系统提示词全文与思考力度 */
  runStarted(userText: string, systemPrompt: string, thinkingLevel: string): void {
    this.run += 1
    this.runTurns = 0
    const preview = userText.trim().slice(0, 24) || '(空)'
    this.record('run.started', `run #${this.run} · “${preview}”`, [
      { label: '思考力度', value: thinkingLevel }
    ])
    // 每个 run 都记（而非只记首个）：AGENTS.md/工具集在会话中途可能变化，
    // 分组内”本轮实际生效的提示词”独立成行才可对照；体积由详情环形上限兜住
    this.record(
      'system.prompt',
      `系统提示词 · ${systemPrompt.length.toLocaleString()} 字符`,
      [{ label: '长度', value: `${systemPrompt.length.toLocaleString()} 字符` }],
      [{ name: '提示词全文', format: 'text', content: systemPrompt }]
    )
  }

  /** run 成功收尾（agent_end 无 errorMessage 时；streaming = 协议侧累积口径） */
  runCompleted(streaming: {
    text: string
    thinking: string
    usage?: { totalTokens: number; totalCost?: number; totalCostFromProvider?: boolean }
    durationMs?: number
    model?: string
    stopReason?: string
  }): void {
    this.flushStream()
    const overview: Array<{ label: string; value: string }> = [
      { label: '轮次', value: String(this.runTurns) },
      { label: '回复', value: `${(streaming.text || streaming.thinking).length.toLocaleString()} 字符` },
      ...(streaming.usage
        ? [
            { label: '总 tokens', value: streaming.usage.totalTokens.toLocaleString() },
            ...(streaming.usage.totalCost !== undefined
              ? [
                  {
                    label: '总成本',
                    // ≈ 前缀 = 目录估价而非端点实报（协议 MessageUsage 同口径）
                    value: `${streaming.usage.totalCostFromProvider ? '' : '≈ '}$${streaming.usage.totalCost.toFixed(6)}`
                  }
                ]
              : [])
          ]
        : []),
      ...(streaming.durationMs !== undefined ? [{ label: '模型耗时', value: `${streaming.durationMs} ms` }] : []),
      ...(streaming.model !== undefined ? [{ label: '模型', value: streaming.model }] : []),
      ...(streaming.stopReason !== undefined ? [{ label: '停止原因', value: streaming.stopReason }] : [])
    ]
    this.record('run.completed', `run 完成 · ${this.runTurns} 轮`, overview)
  }

  /** run 失败收尾（agent_end 带 errorMessage，含用户主动 abort） */
  runFailed(message: string): void {
    this.flushStream()
    this.record(
      'run.failed',
      'run 失败',
      [{ label: '原因', value: message.slice(0, 120) }],
      [{ name: '完整错误', format: 'text', content: message }]
    )
  }

  // ———— 引擎层 ————

  turnStarted(): void {
    this.runTurns += 1
    // 上一轮分片若未在 turn_end 冲掉（异常路径），在下一轮请求前兜底补冲
    this.flushStream()
    this.record('turn.started', `turn ${this.runTurns} 开始`)
  }

  /**
   * turn 结束：pi 的 AssistantMessage 在此已是终态（usage/stopReason/diagnostics
   * 齐），是"引擎层看到的本轮结果"的最佳快照点；详情给归一化后完整消息，
   * 与 api.stream 的原始分片形成归一化前后的两相对照。
   */
  turnCompleted(message: {
    model: string
    provider: string
    api: string
    stopReason: string
    rawStopReason?: string
    /** 请求的思考档（pi loop 回盖到消息：config.reasoning ?? 'off'） */
    thinkingLevel?: string
    /** 端点实际使用的原生力度档（如 openai 的 low/medium/high） */
    providerThinkingLevel?: string
    durationMs?: number
    usage: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      reasoning?: number
      totalTokens: number
      cost: { total: number; totalFromProvider?: boolean }
    }
    diagnostics?: unknown[]
  }): void {
    this.flushStream()
    const overview: Array<{ label: string; value: string }> = [
      { label: '模型', value: message.model },
      { label: 'Provider', value: `${message.provider}（${message.api}）` },
      ...(message.thinkingLevel !== undefined
        ? [
            {
              label: '思考力度',
              // 原生档与请求档不一致时并列展示（thinkingLevelMap 重映射的痕迹）
              value:
                message.providerThinkingLevel !== undefined && message.providerThinkingLevel !== message.thinkingLevel
                  ? `${message.thinkingLevel}（原生: ${message.providerThinkingLevel}）`
                  : message.thinkingLevel
            }
          ]
        : []),
      { label: '停止原因', value: message.rawStopReason !== undefined ? `${message.stopReason}（原生: ${message.rawStopReason}）` : message.stopReason },
      { label: '输入 tokens', value: message.usage.input.toLocaleString() },
      { label: '输出 tokens', value: message.usage.output.toLocaleString() },
      ...(message.usage.cacheRead > 0 ? [{ label: '缓存读', value: message.usage.cacheRead.toLocaleString() }] : []),
      ...(message.usage.cacheWrite > 0 ? [{ label: '缓存写', value: message.usage.cacheWrite.toLocaleString() }] : []),
      ...(message.usage.reasoning !== undefined ? [{ label: '其中思考', value: message.usage.reasoning.toLocaleString() }] : []),
      { label: '总 tokens', value: message.usage.totalTokens.toLocaleString() },
      {
        label: '成本',
        value: `${message.usage.cost.totalFromProvider === true ? '' : '≈ '}$${message.usage.cost.total.toFixed(6)}`
      },
      ...(message.durationMs !== undefined ? [{ label: '耗时', value: `${message.durationMs} ms` }] : []),
      ...(message.diagnostics !== undefined && message.diagnostics.length > 0
        ? [{ label: '诊断', value: `${message.diagnostics.length} 条（见详情）` }]
        : [])
    ]
    this.record(
      'turn.completed',
      `turn ${this.runTurns} · ${message.stopReason}`,
      overview,
      [{ name: 'assistant 消息（pi 归一化终态）', format: 'json', content: safeStringify(message) }]
    )
  }

  // ———— 接口层（pi hooks，全部立即快照）————

  /** 厂商请求体（发送前一刻的原生 JSON）：立即序列化存档，SDK 后续动对象也不受影响 */
  apiRequest(payload: unknown, model: { provider: string; id: string; api: string }): void {
    this.flushStream()
    const body = safeStringify(payload)
    this.streamAgg = { requestTs: Date.now(), chunks: [] }
    this.record(
      'api.request',
      `POST ${model.provider} · ${model.id}`,
      [
        { label: 'Provider', value: model.provider },
        { label: 'API 方言', value: model.api },
        { label: '模型', value: model.id },
        { label: '请求体', value: `${body.length.toLocaleString()} 字符` }
      ],
      [{ name: '请求体（厂商原生 JSON，含 system/messages/tools）', format: 'json', content: body }]
    )
  }

  /** 响应头到达（体被消费前）：独立成条，详情为响应头表 */
  apiResponse(response: ProviderResponse): void {
    this.record(
      'api.response',
      `HTTP ${response.status}`,
      [{ label: '状态', value: String(response.status) }],
      [{ name: '响应头', format: 'json', content: safeStringify(response.headers) }]
    )
  }

  /** SSE 分片（归一化前）：高频回调只攒引用，冲刷点才序列化（见 streamAgg 注释） */
  apiStreamChunk(data: unknown): void {
    if (this.streamAgg === null) this.streamAgg = { requestTs: Date.now(), chunks: [] }
    if (this.streamAgg.firstChunkAt === undefined) this.streamAgg.firstChunkAt = Date.now()
    this.streamAgg.chunks.push(data)
  }

  /** 聚合态 → 一条 api.stream 条目（NDJSON：一行一个分片，正好是 wire 上的样子） */
  private flushStream(): void {
    const agg = this.streamAgg
    this.streamAgg = null
    if (agg === null || agg.chunks.length === 0) return
    const firstDelay = agg.firstChunkAt !== undefined ? agg.firstChunkAt - agg.requestTs : undefined
    this.record(
      'api.stream',
      `SSE 分片 ×${agg.chunks.length}`,
      [
        { label: '分片数', value: String(agg.chunks.length) },
        ...(firstDelay !== undefined ? [{ label: '首块延迟', value: `${firstDelay} ms` }] : [])
      ],
      [
        {
          name: '原始分片（归一化前，一行一条）',
          format: 'text',
          content: agg.chunks.map((chunk) => JSON.stringify(chunk)).join('\n')
        }
      ]
    )
  }

  // ———— 工具层（Cogent 暂未注册工具，先接线占位）————

  toolStarted(toolName: string, args: unknown): void {
    this.record(
      'tool.started',
      `工具 · ${toolName}`,
      undefined,
      [{ name: '调用参数', format: 'json', content: safeStringify(args) }]
    )
  }

  toolCompleted(toolName: string, result: unknown, isError: boolean, durationMs?: number): void {
    this.record(
      'tool.completed',
      `工具 ${isError ? '失败' : '完成'} · ${toolName}`,
      [
        { label: '结果', value: isError ? '错误' : '正常' },
        ...(durationMs !== undefined ? [{ label: '耗时', value: `${durationMs} ms` }] : [])
      ],
      [{ name: '执行结果', format: 'json', content: safeStringify(result) }]
    )
  }

  // ———— 读取（inspect.entries / inspect.entry 的后端）————

  /** 摘要全量（seq 升序）；首条 seq > 0 = 更早条目已被环形丢弃 */
  entries(): InspectEntrySummary[] {
    return this.summaries
  }

  /**
   * 单条详情；undefined = seq 不存在或已被滚动丢弃（调用方转协议错误）。
   * 在册但无详情的条目（概览即全部，如 run.started/completed）回空块而非"不存在" ——
   * 条目存在与有没有详情是两回事，宿主对任何在册 seq 都该拿到合法响应（协议健壮性；
   * 老宿主没按 hasDetail 拦拉取时不至于吃到错误帧）
   */
  detail(seq: number): InspectEntryDetail | undefined {
    const stored = this.details.get(seq)
    if (stored !== undefined) return stored
    if (this.summaries.some((e) => e.seq === seq)) return { seq, blocks: [] }
    return undefined
  }

  // ———— 内部 ————

  private record(
    kind: InspectEntryKind,
    title: string,
    overview?: Array<{ label: string; value: string }>,
    blocks?: DetailBlock[]
  ): void {
    this.seq += 1
    const entry: InspectEntrySummary = {
      seq: this.seq,
      ts: Date.now(),
      kind,
      run: this.run,
      title,
      overview,
      hasDetail: blocks !== undefined
    }
    this.summaries.push(entry)
    if (this.summaries.length > MAX_ENTRIES) this.summaries.shift()
    let record: InspectRecord | undefined
    if (blocks !== undefined) {
      const detail: InspectEntryDetail = { seq: this.seq, blocks }
      this.details.set(this.seq, detail)
      // Map 保持插入序，淘汰最老键。Math.min 展开写法比迭代器 next() 直白，
      // 淘汰触发在溢出后（低频），O(n) 可忽略
      if (this.details.size > MAX_DETAILS) this.details.delete(Math.min(...this.details.keys()))
      record = { e: entry, d: detail }
    } else {
      record = { e: entry }
    }
    this.emit(entry)
    this.persist?.(record)
  }
}
