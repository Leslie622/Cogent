/**
 * compaction.ts 单元测试（docs/计划/测试体系.md S2）—— 纯函数全套：
 * 阈值公式 / D9 保留式投影 / L1 裁剪 / 切点与刚压完守卫 / 原位插入 /
 * 摘要指令组装。每条断言对应一个翻过车或验收过的行为（回归钉，D8：
 * 翻过车的 bug 必钉回归测试），与 tests/integration/compaction.test.ts
 * 的黑盒场景流互补 —— 这里失败时能在秒级定位到具体函数。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  Usage,
  UserMessage
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  buildSummarizationInstruction,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  compactionThreshold,
  convertToLlmMessages,
  formatFileOperations,
  insertCompactionMarker,
  PRUNE_MARKER,
  prepareCompaction,
  pruneToolResults,
  shouldCompact,
  summarizationFailure,
  summarizationThinkingLevel,
  type CompactionPreparation,
  type FileOperations
} from './compaction'

// ———— fixture 工厂（timestamp 单调递增，模拟真实转录时序） ————

let clock = 1_000
const tick = (): number => (clock += 1)

const usage = (): Usage => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

const sysMsg = (text: string): SystemMessage => ({ role: 'system', content: text, timestamp: tick() })

const userMsg = (text: string): UserMessage => ({ role: 'user', content: text, timestamp: tick() })

const assistantMsg = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-completions',
  provider: 'custom/mock',
  model: 'mock',
  usage: usage(),
  stopReason: 'stop',
  timestamp: tick()
})

/** 带工具调用块的 assistant（FileOperations 提取与 toolCall 配对的输入形状） */
const assistantWithCall = (name: string, args: Record<string, string>): AssistantMessage => ({
  ...assistantMsg(''),
  content: [{ type: 'toolCall', id: `call-${tick()}`, name, arguments: args }]
})

const toolResultMsg = (toolCallId: string, text: string): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: tick()
})

/** 压缩条（D9 转录表示） */
const barMsg = (summary: string, at: number): AgentMessage => ({
  role: 'compactionSummary',
  summary,
  tokensBefore: 100,
  tokensAfter: 10,
  timestamp: at
})

// ———— 触发阈值（完备化 R1 公式：max(半窗兜底, min(占比线, 余量线))） ————

describe('compactionThreshold', () => {
  it('目录缺数据的怪模型（ctx ≤ 0）→ Infinity 不触发', () => {
    expect(compactionThreshold(0)).toBe(Number.POSITIVE_INFINITY)
    expect(compactionThreshold(-1)).toBe(Number.POSITIVE_INFINITY)
  })

  it('大窗（> 81920）维持 90% 占比线 —— 100K 窗 → 90K', () => {
    expect(compactionThreshold(100_000)).toBe(90_000)
  })

  it('16K–80K 窗走余量线前移 —— 20K 窗 → 11808（完备化 S1 验收钉：90% 公式要 18000 才触发）', () => {
    expect(compactionThreshold(20_000)).toBe(20_000 - 8_192)
  })

  it('特小窗（< 2×ROOM_FLOOR）被半窗兜底接管 —— 8K 窗 → 4096 而非 0（0 = 每回合必触发）', () => {
    expect(compactionThreshold(8_000)).toBe(4_000)
  })

  it('ModelDef 覆盖：thresholdRatio / roomFloorTokens 双通道', () => {
    expect(compactionThreshold(100_000, { thresholdRatio: 0.5 })).toBe(50_000)
    // 余量线换 floor：100K 窗 floor=16K → min(90K, 84K) = 84K
    expect(compactionThreshold(100_000, { roomFloorTokens: 16_384 })).toBe(100_000 - 16_384)
  })
})

describe('shouldCompact', () => {
  it('严格大于才触发（= 阈值不触发）', () => {
    expect(shouldCompact(90_000, 100_000)).toBe(false)
    expect(shouldCompact(90_001, 100_000)).toBe(true)
  })
})

// ———— D9 保留式投影 ————

describe('convertToLlmMessages', () => {
  it('无压缩条：原引用直通（热路径零拷贝）', () => {
    const messages: AgentMessage[] = [sysMsg('lead'), userMsg('hi'), assistantMsg('hey')]
    expect(convertToLlmMessages(messages)).toBe(messages)
  })

  it('有压缩条：[system 全局原序] + [bar→user 前后缀包裹] + [活区非 system]', () => {
    const barAt = tick()
    const messages: AgentMessage[] = [
      sysMsg('lead'),
      userMsg('old-q'),
      assistantMsg('old-a'),
      barMsg('SUMMARY-1', barAt),
      sysMsg('perm-notice'), // 活区里的 system：不进活区段，但全局收集要捡到
      userMsg('new-q'),
      assistantMsg('new-a')
    ]
    const projected = convertToLlmMessages(messages)
    expect(projected.map((m) => m.role)).toEqual(['system', 'system', 'user', 'user', 'assistant'])
    expect(projected[0].role === 'system' && projected[0].content).toBe('lead')
    expect(projected[1].role === 'system' && projected[1].content).toBe('perm-notice')
    // bar 投影为 user 摘要消息（前缀 + 摘要 + 后缀）
    const barProj = projected[2]
    const barText =
      barProj.role === 'user' && typeof barProj.content !== 'string' && barProj.content[0].type === 'text'
        ? barProj.content[0].text
        : ''
    expect(barText).toBe(COMPACTION_SUMMARY_PREFIX + 'SUMMARY-1' + COMPACTION_SUMMARY_SUFFIX)
    // 活区：new 回合在、影子区旧回合不在
    const texts = JSON.stringify(projected)
    expect(texts).toContain('new-q')
    expect(texts).not.toContain('old-q')
  })

  it('多条压缩条只认最后一条（更早的及其影子区一并丢弃）', () => {
    const messages: AgentMessage[] = [
      userMsg('v1-q'),
      barMsg('SUMMARY-V1', tick()),
      userMsg('v2-q'),
      barMsg('SUMMARY-V2', tick()),
      userMsg('live-q')
    ]
    const projected = convertToLlmMessages(messages)
    const texts = JSON.stringify(projected)
    expect(texts).toContain('SUMMARY-V2')
    expect(texts).not.toContain('SUMMARY-V1')
    expect(texts).not.toContain('v2-q') // V1 与 V2 之间 = 影子区
    expect(texts).toContain('live-q')
  })
})

// ———— L1 裁剪（dsh tool-result-pruner 数值同款） ————

describe('pruneToolResults', () => {
  const big = (n: number): string => 'x'.repeat(n)

  it('全部在线内：原数组引用直通（检查点热路径零拷贝）', () => {
    const messages: AgentMessage[] = [toolResultMsg('t1', big(8_192))]
    expect(pruneToolResults(messages).messages).toBe(messages)
  })

  it('超线：头 4096 + marker + 尾 1024，账目 originalChars/prunedChars 配对', () => {
    const messages: AgentMessage[] = [toolResultMsg('t1', big(20_000))]
    const { messages: out, pruned } = pruneToolResults(messages)
    expect(out).not.toBe(messages)
    const text = out[0].role === 'toolResult' && out[0].content[0].type === 'text' ? out[0].content[0].text : ''
    const markerAt = text.indexOf(PRUNE_MARKER)
    expect(markerAt).toBe(4_096)
    expect(text.length).toBe(4_096 + PRUNE_MARKER.length + 1_024)
    expect(pruned).toEqual([{ toolCallId: 't1', originalChars: 20_000, prunedChars: text.length }])
    // 头尾内容保真
    expect(text.startsWith(big(4_096))).toBe(true)
    expect(text.endsWith(big(1_024))).toBe(true)
  })

  it('影子区不裁（D9 保留式：bar 之前的历史原文不动），活区照裁', () => {
    const barAt = tick()
    const messages: AgentMessage[] = [
      toolResultMsg('shadow', big(20_000)),
      barMsg('S', barAt),
      toolResultMsg('live', big(20_000))
    ]
    const { messages: out, pruned } = pruneToolResults(messages)
    expect(pruned.map((p) => p.toolCallId)).toEqual(['live'])
    expect(out[0]).toBe(messages[0]) // 影子区原对象引用不变
  })

  it('多 text 块按合并口径判线、跨块连续切，非 text 块原样保留', () => {
    // 总量 8416 > 8192（判线看全部 text 块合并）：头块整块保留（终点 4000 < 4096），
    // 尾块跨切线 —— 头侧只保到全局 4096（96 字符）、尾侧保全局末 1024
    const messages: AgentMessage[] = [
      {
        ...toolResultMsg('t1', ''),
        content: [
          { type: 'text', text: big(4_000) }, // 头块：整块在保留区
          { type: 'image', data: '', mimeType: 'image/png' }, // rich 块：顺序不动
          { type: 'text', text: big(4_400) + 'TAILTAILTAILTAIL' } // 尾块：跨切线
        ]
      }
    ]
    const { messages: out, pruned } = pruneToolResults(messages)
    expect(pruned).toHaveLength(1)
    const blocks = out[0].role === 'toolResult' ? out[0].content : []
    expect(blocks[1].type).toBe('image') // rich 块不吞
    // 尾块 = 头侧残余（到全局 4096 为止的 96 字符）+ marker（移除区首个相交块）+ 全局末 1024
    const originalTail = big(4_400) + 'TAILTAILTAILTAIL'
    const tailText = blocks[2].type === 'text' ? blocks[2].text : ''
    expect(tailText).toBe(big(96) + PRUNE_MARKER + originalTail.slice(-1_024))
    expect(tailText.endsWith('TAILTAILTAILTAIL')).toBe(true)
  })

  it('code point 计量：代理对（emoji）算 1 —— 8192 个 emoji 是 16384 个 UTF-16 单元，快路过线而精确计量在线内 → 不裁', () => {
    // UTF-16 快路（text.length 16384 > 8192）放行进精确计量，code point 8192 = 阈值 → 不裁，
    // 且返回原引用 —— 这条钉的是「快路只做上界预筛，判线永远以 code point 为准」
    const within: AgentMessage[] = [toolResultMsg('t2', '😀'.repeat(8_192))]
    expect(pruneToolResults(within).messages).toBe(within)
    // 8193 个 code point 过线 → 裁，marker 落点按 code point 计（不切半代理对）
    const over: AgentMessage[] = [toolResultMsg('t1', '😀'.repeat(8_193))]
    const { pruned } = pruneToolResults(over)
    expect(pruned).toEqual([{ toolCallId: 't1', originalChars: 8_193, prunedChars: 4_096 + PRUNE_MARKER.length + 1_024 }])
  })

  it('幂等：裁后的结果 ≤ 阈值，二次跑原引用直通', () => {
    const once = pruneToolResults([toolResultMsg('t1', big(20_000))])
    const twice = pruneToolResults(once.messages)
    expect(twice.messages).toBe(once.messages)
    expect(twice.pruned).toHaveLength(0)
  })
})

// ———— 切点与压缩准备 ————

describe('findCutPoint / prepareCompaction', () => {
  /** 垫 N 个回合（每回合 user+assistant 各 ~chars/2 字符，前缀带序号防内容重复合并干扰阅读） */
  let padI = 0
  const bigText = (n: number): string => `q${(padI += 1)}`.padEnd(Math.max(n, 8), 'x')
  const padTurns = (turns: number, charsPerTurn: number): AgentMessage[] => {
    const messages: AgentMessage[] = [sysMsg('lead')]
    for (let i = 0; i < turns; i++) {
      messages.push(userMsg(bigText(charsPerTurn / 2)), assistantMsg(bigText(charsPerTurn / 2)))
    }
    return messages
  }

  it('无 user 边界（纯 system 转录）→ undefined', () => {
    expect(prepareCompaction([sysMsg('lead')], 1_000, 0)).toBeUndefined()
  })

  it('近期内容不满保留窗口（小转录大 keepRecent）→ undefined（无可摘要）', () => {
    const messages = padTurns(2, 1_000)
    expect(prepareCompaction(messages, 20_000, 5_000)).toBeUndefined()
  })

  it('正常路：切点落在 user 边界，system 不进被摘要区，summarizedUntil = 区末 timestamp', () => {
    // 4 回合 × ~3000 字符（≈857 token）：keepRecent 1200 token 保住末 1 回合，前 3 回合可摘要
    const messages = padTurns(4, 3_000)
    messages.splice(2, 0, sysMsg('mid-perm')) // 被摘要区里的 system：不进摘要（提示词状态非对话）
    const prep = prepareCompaction(messages, 1_200, 9_999)
    expect(prep).toBeDefined()
    const summarizeTexts = JSON.stringify(prep?.messagesToSummarize)
    expect(summarizeTexts).not.toContain('mid-perm')
    // 切点 = user 边界
    expect(messages[prep!.firstKeptIndex].role).toBe('user')
    // 被摘要区末条 timestamp 作 UI 锚点
    const region = messages.slice(0, prep!.firstKeptIndex)
    expect(prep?.summarizedUntil).toBe(region[region.length - 1].timestamp)
    expect(prep?.tokensBefore).toBe(9_999)
  })

  it('D9 刚压完时间戳守卫：bar 之后没有更新的非 system 消息 → undefined（防保留区被反复重摘要）', () => {
    const barAt = tick()
    const messages: AgentMessage[] = [
      userMsg('old'),
      barMsg('S', barAt),
      // bar 之前... 不，这里构造 bar 之后只有 timestamp 更早的消息不可能（tick 单调）——
      // 真实形态：bar 在末尾（刚压完还没新回合）
      sysMsg('late-notice') // system 不算新回合
    ]
    const prep = prepareCompaction(messages, 1, 5_000) // keepRecent 极小，若守卫失效必产出
    expect(prep).toBeUndefined()
  })

  it('守卫放行：bar 之后确有新回合（timestamp > bar）→ 正常准备且 previousSummary 续传', () => {
    const barAt = tick()
    const messages: AgentMessage[] = [
      userMsg('v1'),
      assistantMsg('a1'),
      barMsg('PREV-SUMMARY', barAt),
      userMsg('v2'),
      assistantMsg('a2'),
      userMsg('v3'), // keepRecent 极小时 v2 回合被摘要、v3 回合保留
      assistantMsg('a3')
    ]
    const prep = prepareCompaction(messages, 1, 5_000)
    expect(prep?.previousSummary).toBe('PREV-SUMMARY')
    expect(prep && messages[prep.firstKeptIndex].role).toBe('user')
    // 被摘要区 = bar 与切点之间（v2 回合）；bar 之前的 v1 属影子区不进
    const texts = JSON.stringify(prep?.messagesToSummarize)
    expect(texts).toContain('v2')
    expect(texts).not.toContain('v1')
  })

  it('FileOperations 提取：read 只读未改 → read；write/edit → modified；两者兼有只记 modified', () => {
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantWithCall('read', { path: 'a.ts' }),
      assistantWithCall('write', { path: 'b.ts' }),
      assistantWithCall('edit', { path: 'a.ts' }), // a.ts 又被改 → 从 read 表除名
      assistantWithCall('read', { path: 'c.ts' }),
      assistantWithCall('bash', { command: 'ls' }), // 非文件工具不入表
      userMsg('done'), // 末回合兜底：让工具回合落进被摘要区（切点取 user 边界）
      assistantMsg('ok')
    ]
    const prep = prepareCompaction(messages, 1, 5_000)
    expect(prep?.fileOps).toEqual<FileOperations>({
      readFiles: ['c.ts'],
      modifiedFiles: ['a.ts', 'b.ts']
    })
  })
})

// ———— 原位插入（S2 400 bug 纪律：不换数组引用） ————

describe('insertCompactionMarker', () => {
  const preparation = (messages: AgentMessage[], firstKeptIndex: number): CompactionPreparation => ({
    messagesToSummarize: messages.slice(0, firstKeptIndex),
    firstKeptIndex,
    tokensBefore: 12_345,
    fileOps: { readFiles: [], modifiedFiles: [] },
    summarizedUntil: messages[firstKeptIndex - 1].timestamp
  })

  it('原位 splice：同一数组引用上插入（换引用 = run 中途两条线各写各的 → 400）', () => {
    const messages: AgentMessage[] = [sysMsg('lead'), userMsg('q1'), assistantMsg('a1'), userMsg('q2')]
    const out = insertCompactionMarker(messages, preparation(messages, 3), 'S', 500)
    expect(out).toBe(messages) // 关键钉子：引用不变
    expect(out[3].role).toBe('compactionSummary')
    // 保留区后移一位、内容不动
    expect(out[4].role === 'user' && out[4].content).toBe('q2')
  })

  it('条上账目：tokensBefore 从 preparation、tokensAfter 参数、timestamp = now', () => {
    const messages: AgentMessage[] = [sysMsg('lead'), userMsg('q1'), assistantMsg('a1'), userMsg('q2')]
    const before = Date.now()
    insertCompactionMarker(messages, preparation(messages, 3), 'S', 500)
    const bar = messages[3]
    expect(bar.role === 'compactionSummary' && bar.tokensBefore).toBe(12_345)
    expect(bar.role === 'compactionSummary' && bar.tokensAfter).toBe(500)
    expect(bar.timestamp).toBeGreaterThanOrEqual(before)
  })
})

// ———— 摘要指令与安全判定 ————

describe('formatFileOperations', () => {
  it('空表 → 空串（摘要原样收尾）', () => {
    expect(formatFileOperations({ readFiles: [], modifiedFiles: [] })).toBe('')
  })
  it('有表 → XML 尾缀双节', () => {
    const out = formatFileOperations({ readFiles: ['a.ts'], modifiedFiles: ['b.ts'] })
    expect(out).toContain('<read-files>\na.ts\n</read-files>')
    expect(out).toContain('<modified-files>\nb.ts\n</modified-files>')
  })
})

describe('buildSummarizationInstruction', () => {
  const basePrep = (previousSummary?: string): CompactionPreparation => ({
    messagesToSummarize: [],
    firstKeptIndex: 1,
    tokensBefore: 0,
    fileOps: { readFiles: [], modifiedFiles: [] },
    summarizedUntil: 0,
    previousSummary
  })

  it('无前代：首次提示词（结构模板）', () => {
    const out = buildSummarizationInstruction(basePrep())
    expect(out).toContain('## Goal')
    expect(out).toContain('Do NOT continue the conversation')
    expect(out).not.toContain('<previous-summary>')
  })
  it('有前代：UPDATE 提示词 + <previous-summary> 迭代合并', () => {
    const out = buildSummarizationInstruction(basePrep('OLD'))
    expect(out).toContain('<previous-summary>\nOLD\n</previous-summary>')
    expect(out).toContain('PRESERVE all existing information')
  })
})

describe('summarizationFailure', () => {
  const msg = (stopReason: AssistantMessage['stopReason'], withToolCall = false): AssistantMessage => ({
    ...assistantMsg('half'),
    stopReason,
    content: withToolCall ? [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }] : []
  })
  it('error / length / 尝试调工具 → 各自错误文案', () => {
    expect(summarizationFailure(msg('error'))).toContain('生成失败')
    expect(summarizationFailure(msg('length'))).toContain('截断')
    expect(summarizationFailure(msg('stop', true))).toContain('调用工具')
  })
  it('正常 stop 纯文本 → undefined', () => {
    expect(summarizationFailure(msg('stop'))).toBeUndefined()
  })
})

describe('summarizationThinkingLevel', () => {
  it('推理模型 + 会话开思考 → 跟随会话级别', () => {
    expect(summarizationThinkingLevel(true, 'high')).toEqual({ reasoning: 'high' })
  })
  it('非推理模型 / 会话 off → 空对象（不带选项）', () => {
    expect(summarizationThinkingLevel(false, 'high')).toEqual({})
    expect(summarizationThinkingLevel(true, 'off')).toEqual({})
  })
})
