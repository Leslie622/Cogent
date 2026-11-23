/**
 * compaction.ts 单元测试（docs/模块/测试.md）—— 两个纯函数面：触发线
 * （models.list 预警线口径）与保留式投影（estimateContext 的转录整形）；
 * 与 tests/integration/compaction.test.ts 的黑盒场景流互补。
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
  adaptCompactionToWindow,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  convertToLlmMessages,
  piTriggerRatio
} from '../../../src/host/runtime/compaction'

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

// ———— 触发线（pi reserve 制真值口径） ————

describe('piTriggerRatio', () => {
  it('目录缺数据的怪模型（ctx ≤ 0）→ NaN（下发处 isFinite 守卫跳过）', () => {
    expect(Number.isNaN(piTriggerRatio(0))).toBe(true)
    expect(Number.isNaN(piTriggerRatio(-1))).toBe(true)
  })

  it('标准窗：reserve 恒 16384 —— 100K → 0.83616、128K → 0.875、200K → 0.9192', () => {
    expect(piTriggerRatio(100_000)).toBeCloseTo((100_000 - 16_384) / 100_000, 10)
    expect(piTriggerRatio(128_000)).toBeCloseTo(0.872, 3)
    expect(piTriggerRatio(200_000)).toBeCloseTo((200_000 - 16_384) / 200_000, 10)
  })

  it('小窗 reserve 被 ctx/4 钳制 —— 16K → 0.75（reserve 4000）、8K → 0.75（reserve 2048…同 3/4 线）', () => {
    // floor(16000/4)=4000 < 16384 → 12000/16000 = 0.75；floor(8000/4)=2000 → 6000/8000 = 0.75
    expect(piTriggerRatio(16_000)).toBe(0.75)
    expect(piTriggerRatio(8_000)).toBe(0.75)
  })

  it('旧预警公式（100K 窗画 90%）与真值（83.6%）的错位正是验收报的"未到线就压"', () => {
    expect(piTriggerRatio(100_000)).toBeLessThan(0.9)
  })
})

describe('adaptCompactionToWindow（1.4 小窗自适应）', () => {
  const piDefaults = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }

  it('标准窗零变化 —— keep 边界 2×keep=40K、reserve 边界 4×reserve=65536，之上两个 min 都取原值', () => {
    expect(adaptCompactionToWindow(piDefaults, 200_000)).toEqual(piDefaults)
    expect(adaptCompactionToWindow(piDefaults, 65_536)).toEqual(piDefaults)
    // 64000 恰低于 reserve 边界（floor(64000/4)=16000<16384）：reserve 轻微
    // 收敛、keep 不动 —— 64K 窗触发线从 47616 挪到 48000，行为面不变
    expect(adaptCompactionToWindow(piDefaults, 64_000)).toEqual({ ...piDefaults, reserveTokens: 16_000 })
  })

  it('小窗收敛：16K → keep 8000 / reserve 4000；8K → 4096 / 2048', () => {
    expect(adaptCompactionToWindow(piDefaults, 16_000)).toEqual({ ...piDefaults, keepRecentTokens: 8000, reserveTokens: 4000 })
    expect(adaptCompactionToWindow(piDefaults, 8_192)).toEqual({ ...piDefaults, keepRecentTokens: 4096, reserveTokens: 2048 })
  })

  it('非整除向下取整（17K 窗 keep=8500/reserve=4250）；窗口未知（≤0）原样返回', () => {
    expect(adaptCompactionToWindow(piDefaults, 17_001)).toEqual({ ...piDefaults, keepRecentTokens: 8500, reserveTokens: 4250 })
    expect(adaptCompactionToWindow(piDefaults, 0)).toBe(piDefaults)
    expect(adaptCompactionToWindow(piDefaults, -1)).toBe(piDefaults)
  })
})

// ———— 保留式投影 ————

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
