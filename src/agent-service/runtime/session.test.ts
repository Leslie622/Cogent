/**
 * toChatMessages 单元测试（docs/计划/测试体系.md S2）—— pi 转录 → UI
 * ChatMessage 投影。重点钉 D9 保留式的**呈现位**：压缩条在转录里插在切点
 * （下标在保留区之前），UI 投影按 timestamp 延迟落位（第三轮 GUI 验收
 * "留痕跳到上面去了"的引擎侧回归钉）；另有 R6③ 相邻段合并与工具配对。
 * 与 compaction.test.ts（纯函数层）、tests/integration/compaction.test.ts
 * （重启回查黑盒）三层互补。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, SystemMessage, ToolResultMessage, Usage, UserMessage } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { toChatMessages } from './session'

// ———— fixture 工厂 ————

let clock = 1_000
const tick = (): number => (clock += 10)

const usage = (n: number): Usage => ({
  input: n,
  output: n * 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: n * 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

const sysMsg = (text: string): SystemMessage => ({ role: 'system', content: text, timestamp: tick() })

const userMsg = (text: string, at?: number): UserMessage => ({ role: 'user', content: text, timestamp: at ?? tick() })

const assistantMsg = (text: string, at?: number): AssistantMessage => ({
  role: 'assistant',
  content: text === '' ? [] : [{ type: 'text', text }],
  api: 'openai-completions',
  provider: 'custom/mock',
  model: 'mock',
  usage: usage(1),
  stopReason: 'stop',
  timestamp: at ?? tick()
})

const toolResultMsg = (
  toolCallId: string,
  text: string,
  at: number,
  opts?: { isError?: boolean; durationMs?: number; details?: { diff: string } }
): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content: [{ type: 'text', text }],
  isError: opts?.isError ?? false,
  details: opts?.details,
  durationMs: opts?.durationMs,
  timestamp: at
})

const barMsg = (summary: string, at: number): AgentMessage => ({
  role: 'compactionSummary',
  summary,
  tokensBefore: 100,
  tokensAfter: 10,
  timestamp: at
})

describe('toChatMessages 基础投影', () => {
  it('user/assistant 直投 + system/toolResult 不单独成条', () => {
    const messages: AgentMessage[] = [
      sysMsg('lead'),
      userMsg('q'),
      assistantMsg('a'),
      toolResultMsg('t1', 'result', tick())
    ]
    const out = toChatMessages(messages)
    expect(out.map((m) => `${m.role}:${m.content}`)).toEqual(['user:q', 'assistant:a'])
    expect(out[0].id).toBe('u-0')
    expect(out[1].id).toBe('a-1') // 位置式 id（N = result.length）
  })

  it('user 多内容块拼接文本；assistant thinking 块整段挂 thinking', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }], timestamp: tick() },
      {
        ...assistantMsg(''),
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'answer' }
        ],
        timestamp: tick()
      }
    ]
    const out = toChatMessages(messages)
    expect(out[0].content).toBe('hello')
    expect(out[1].thinking).toBe('let me think')
    expect(out[1].content).toBe('answer')
  })

  it('工具调用配对：状态/结果摘要/起止重建/diff，与转录顺序无关（按 callId）', () => {
    const at = tick()
    const messages: AgentMessage[] = [
      userMsg('go'),
      {
        ...assistantMsg(''),
        content: [{ type: 'toolCall', id: 'call-9', name: 'edit', arguments: { path: 'a.ts' } }],
        timestamp: tick()
      },
      // 同名工具两条结果（另一条无主）：只配对 callId 命中的
      toolResultMsg('call-9', 'done', at, { durationMs: 40, details: { diff: '+1' } }),
      toolResultMsg('call-x', 'orphan', tick())
    ]
    const out = toChatMessages(messages)
    const assistant = out.find((m) => m.role === 'assistant')
    const call = assistant?.toolCalls?.[0]
    expect(call).toMatchObject({
      callId: 'call-9',
      name: 'edit',
      kind: 'edit',
      status: 'ok',
      resultSummary: 'done',
      diff: '+1',
      endedAt: at,
      startedAt: at - 40 // durationMs 反推
    })
    expect(assistant?.toolCalls).toHaveLength(1)
    // 工具段无正文无思考 → 消息本体不落（只有卡）
    expect(assistant?.content).toBe('')
  })

  it('isError 结果 → status error', () => {
    const at = tick()
    const messages: AgentMessage[] = [
      userMsg('go'),
      {
        ...assistantMsg(''),
        content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'x' } }],
        timestamp: tick()
      },
      toolResultMsg('c1', 'boom', at, { isError: true })
    ]
    const out = toChatMessages(messages)
    expect(out.find((m) => m.role === 'assistant')?.toolCalls?.[0]?.status).toBe('error')
  })
})

describe('toChatMessages 相邻段合并（R6③ 续写的历史投影形态）', () => {
  it('[cogent:continue] 指令泡不单独成条，截断段与续写段并回一条（正文/思考/账目累加）', () => {
    const messages: AgentMessage[] = [
      userMsg('写个故事'),
      { ...assistantMsg('前半段'), durationMs: 100, timestamp: tick() },
      userMsg('[cogent:continue]', tick()), // 引擎注入的续写指令（跳过）
      { ...assistantMsg('后半段', tick()), usage: usage(5), durationMs: 50 }
    ]
    const out = toChatMessages(messages)
    expect(out).toHaveLength(2) // user + 合并后的一条 assistant
    const merged = out[1]
    expect(merged.content).toBe('前半段后半段')
    expect(merged.usage).toMatchObject({ input: 6, output: 12, totalTokens: 18 }) // 1+5
    expect(merged.durationMs).toBe(150)
  })

  it('相邻门 = 双方都无工具卡：工具轮前后的文本段不许并', () => {
    const at = tick()
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantMsg('先说两句'),
      {
        ...assistantMsg(''),
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
        timestamp: tick()
      },
      toolResultMsg('c1', 'ok', at),
      assistantMsg('工具之后的正文')
    ]
    const out = toChatMessages(messages)
    const assistants = out.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(3) // 各自独立
  })
})

describe('toChatMessages 压缩条时间序落位（D9 呈现位回归钉）', () => {
  it('转录里 bar 插在切点（保留区之前），投影延迟到首条更新消息之前 —— 呈现位 = 压缩发生的地方', () => {
    // 时间线：t1..t4 早于 bar(t100)（保留区被压缩前刚发生），t150/t160 晚于（压缩后新回合）
    const messages: AgentMessage[] = [
      sysMsg('lead'),
      userMsg('q1', 10),
      assistantMsg('a1', 20),
      barMsg('SUMMARY', 100), // 转录位置：切点（q2 之前）
      userMsg('q2', 30),
      assistantMsg('a2', 40),
      userMsg('q3', 150),
      assistantMsg('a3', 160)
    ]
    const out = toChatMessages(messages)
    // 期望 UI 序：q1 a1 q2 a2 [bar] q3 a3 —— bar 不在转录下标处（q2 前），在时间序处
    expect(out.map((m) => m.role + ':' + m.content)).toEqual([
      'user:q1',
      'assistant:a1',
      'user:q2',
      'assistant:a2',
      'compaction:SUMMARY',
      'user:q3',
      'assistant:a3'
    ])
    const bar = out[4]
    expect(bar.compaction).toEqual({ tokensBefore: 100, tokensAfter: 10, summaryUsage: undefined })
  })

  it('末尾 flush：压缩后无新回合的会话，bar 兜底落尾', () => {
    const messages: AgentMessage[] = [userMsg('q1', 10), assistantMsg('a1', 20), barMsg('S', 100)]
    const out = toChatMessages(messages)
    expect(out).toHaveLength(3)
    expect(out[2].role).toBe('compaction')
  })

  it('两条 bar 间无消息：先落旧保序（防御路径，正常流被刚压完守卫拦下）', () => {
    const messages: AgentMessage[] = [
      userMsg('q1', 10),
      barMsg('V1', 100),
      barMsg('V2', 200)
    ]
    const out = toChatMessages(messages)
    const bars = out.filter((m) => m.role === 'compaction')
    expect(bars.map((b) => b.content)).toEqual(['V1', 'V2'])
  })
})
