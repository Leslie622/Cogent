/**
 * compaction.ts 单元测试（docs/模块/测试.md）—— 两个纯函数面：触发线
 * （models.list 预警线口径）与保留式投影（estimateContext 的转录整形）；
 * 与 tests/integration/compaction.test.ts 的黑盒场景流互补。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
  Usage
} from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import {
  adaptCompactionToWindow,
  buildCompactionInstructions,
  buildShadowSessionAssetsSection,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  computeL1PruneTrigger,
  convertToLlmMessages,
  piTriggerRatio,
  planStaleToolResultPrunes
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

// ———— L1 工具结果裁剪、中文黑盒摘要指令与压缩后资产恢复 ————

function makeToolResultEntry(id: string, text: string, opts: { isError?: boolean; withImage?: boolean } = {}): SessionEntry {
  const content: ToolResultMessage['content'] = [
    { type: 'text', text },
    ...(opts.withImage ? [{ type: 'image' as const, data: 'AQID', mimeType: 'image/png' }] : [])
  ]
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(tick()).toISOString(),
    message: {
      role: 'toolResult',
      toolCallId: `call-${id}`,
      toolName: 'read',
      content,
      isError: opts.isError === true,
      timestamp: tick()
    }
  }
}

function makeAssistantEntry(id: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(tick()).toISOString(),
    message: assistantMsg('ok')
  }
}

describe('computeL1PruneTrigger', () => {
  it('逼近压缩阈值 85% 或距阈值 2000 tokens 才触发，非法窗口返回 0', () => {
    expect(computeL1PruneTrigger(0, 16_384)).toBe(0)
    // 100K - 16384 = 83616; floor(83616 * 0.85) = 71073 < 81616
    expect(computeL1PruneTrigger(100_000, 16_384)).toBe(Math.floor((100_000 - 16_384) * 0.85))
    // 16K - 4000 = 12000; floor(12000 * 0.85) = 10200 vs 12000 - 2000 = 10000 → 取 10000
    expect(computeL1PruneTrigger(16_000, 4_000)).toBe(10_000)
  })
})

describe('planStaleToolResultPrunes', () => {
  it('保护最近 5 轮工具调用，仅裁剪更早的超大非错误结果，保留图片块且跳过已裁剪项', () => {
    const huge = 'HEAD_' + 'x'.repeat(12_000) + '_TAIL'
    const branch: SessionEntry[] = []
    // 构造 7 轮工具调用（round 1..7），前两轮在保护窗外
    for (let r = 1; r <= 7; r++) {
      branch.push(makeAssistantEntry(`a-${r}`))
      if (r === 1) {
        branch.push(makeToolResultEntry('t-1-ok', huge, { withImage: true }))
        branch.push(makeToolResultEntry('t-1-err', huge, { isError: true }))
      } else if (r === 2) {
        branch.push(makeToolResultEntry('t-2-edited', huge))
        branch.push({
          type: 'context_edit',
          id: 'ce-1',
          parentId: 't-2-edited',
          timestamp: new Date(tick()).toISOString(),
          targetId: 't-2-edited',
          replacement: { content: [{ type: 'text', text: 'already pruned' }] }
        })
      } else {
        branch.push(makeToolResultEntry(`t-${r}`, huge))
      }
    }

    const plan = planStaleToolResultPrunes(branch)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0].targetId).toBe('t-1-ok')
    expect(plan.estimatedSavedTokens).toBeGreaterThanOrEqual(256)
    expect(plan.edits[0].content).toHaveLength(2)
    expect(plan.edits[0].content[1].type).toBe('image')
    const prunedText = plan.edits[0].content[0].type === 'text' ? plan.edits[0].content[0].text : ''
    expect(prunedText).toContain('HEAD_')
    expect(prunedText).toContain('_TAIL')
    expect(prunedText).toContain('已裁剪')
  })

  it('总节省低于最小阈值（256 tokens）时放弃裁剪以保全前缀缓存', () => {
    const smallOver = 'a'.repeat(8_250) // 略超 8192，但裁完后节省远小于 256*4=1024 字符时测试 minTokenSavings
    const branch: SessionEntry[] = []
    for (let r = 1; r <= 6; r++) {
      branch.push(makeAssistantEntry(`a-${r}`))
      branch.push(makeToolResultEntry(`t-${r}`, r === 1 ? smallOver : 'short'))
    }
    const plan = planStaleToolResultPrunes(branch, { minTokenSavings: 2_000 })
    expect(plan.edits).toEqual([])
    expect(plan.estimatedSavedTokens).toBe(0)
  })
})

describe('buildCompactionInstructions & buildShadowSessionAssetsSection', () => {
  it('默认包含中文结构化摘要与黑盒边界要求，并合并用户焦点指令', () => {
    const base = buildCompactionInstructions()
    expect(base).toContain('简体中文')
    expect(base).toContain('黑盒边界')
    const focused = buildCompactionInstructions('保留数据库迁移 SQL 细节')
    expect(focused).toContain('简体中文')
    expect(focused).toContain('用户重点保留要求：保留数据库迁移 SQL 细节')
  })

  it('无压缩时返回 null；压缩后自动恢复影子区附件与目录引用索引', () => {
    const attEntry: SessionEntry = {
      type: 'custom',
      id: 'att-1',
      parentId: null,
      timestamp: new Date(tick()).toISOString(),
      customType: 'cogent.attachment-input.v1',
      data: {
        version: 1,
        userEntryId: 'u-1',
        inputId: 'in-1',
        text: '看附件',
        attachments: [{ id: 'att-uuid-1', name: 'spec.pdf', mime: 'application/pdf', size: 1024 }],
        directories: [{ kind: 'directory', name: 'docs', path: 'C:\\repo\\docs' }]
      }
    }
    const keptEntry = makeAssistantEntry('kept-1')
    expect(buildShadowSessionAssetsSection([attEntry, keptEntry])).toBeNull()

    const compactEntry: SessionEntry = {
      type: 'compaction',
      id: 'cmp-1',
      parentId: 'kept-1',
      timestamp: new Date(tick()).toISOString(),
      summary: '摘要',
      firstKeptEntryId: 'kept-1',
      tokensBefore: 10_000
    }
    const section = buildShadowSessionAssetsSection([attEntry, keptEntry, compactEntry])
    expect(section).not.toBeNull()
    expect(section).toContain('att-uuid-1')
    expect(section).toContain('spec.pdf')
    expect(section).toContain('read_attachment')
    expect(section).toContain('切勿暴露内部 id')
    expect(section).toContain('C:\\\\repo\\\\docs')
  })
})
