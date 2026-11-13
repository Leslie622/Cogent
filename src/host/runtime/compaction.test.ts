/**
 * compaction.ts 单元测试（docs/计划/测试体系.md S2）—— 1.2a 瘦身后的存量
 * 两面：阈值公式（models.list 预警线）与 D9 保留式投影（estimateContext 的
 * 转录整形）。手搓压缩内核（L1 裁剪 / 切点 / 摘要指令）随实现让位 pi 内置
 * 压缩而删（全局架构 D6），对应场景一并退役；与 tests/integration/
 * compaction.test.ts 的黑盒场景流互补。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  SystemMessage,
  UserMessage,
  Usage
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  compactionThreshold,
  convertToLlmMessages
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

/** 压缩条（pi 原生形状：summary / tokensBefore / timestamp） */
const barMsg = (summary: string, at: number): AgentMessage => ({
  role: 'compactionSummary',
  summary,
  tokensBefore: 100,
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
