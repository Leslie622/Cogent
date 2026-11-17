/**
 * groupTurns 单元测试（docs/模块/测试.md）—— 渲染期回合分组的
 * 纯逻辑。重点钉保留式呈现：压缩条是**回合内的过程行**
 * （按时间序原位中插，不截断回合、不自成组 —— 一条用户消息恒一个工作头；
 * bar 自成组截断回合的旧形态被验收否决：一回合多头形似多次独立工作）。
 */
import type { ChatMessage } from '@/env.d'
import { describe, expect, it } from 'vitest'
import { groupTurns } from './TurnGroup'
import type { ChatTurn } from './TurnGroup'
import type { PrunedItem, ToolItem } from '@/stores/chat'

// ———— fixture 工厂 ————

const userMsg = (id: string, at = 1): ChatMessage => ({ id, role: 'user', content: `text-${id}`, timestamp: at })
const assistantMsg = (id: string, at = 2): ChatMessage => ({ id, role: 'assistant', content: `text-${id}`, timestamp: at })
const compactionBar = (id: string, at = 3): ChatMessage => ({
  id,
  role: 'compaction',
  content: 'SUMMARY',
  compaction: { tokensBefore: 100, tokensAfter: 10 },
  timestamp: at
})
const toolItem = (id: string): ToolItem => ({ id, type: 'tool', name: 'read', toolKind: 'read', summary: 'read(a)', status: 'ok' })
const prunedItem = (id: string, at = 3): PrunedItem => ({
  id,
  type: 'pruned',
  entries: [{ toolCallId: 't1', originalChars: 20000, prunedChars: 5155 }],
  timestamp: at
})

const shape = (turns: ChatTurn[]): Array<{ user?: string; startedAt?: number; items: string[] }> =>
  turns.map((t) => ({ user: t.user?.id, startedAt: t.startedAt, items: t.items.map((i) => i.id) }))

describe('groupTurns 基础分组', () => {
  it('user 开组、其后到下一 user 前的项归本组；user 槽不进 items', () => {
    const turns = groupTurns([userMsg('u1'), toolItem('t1'), assistantMsg('a1'), userMsg('u2'), assistantMsg('a2')])
    expect(shape(turns)).toEqual([
      { user: 'u1', startedAt: undefined, items: ['t1', 'a1'] },
      { user: 'u2', startedAt: undefined, items: ['a2'] }
    ])
  })

  it('开头无 user 的项（历史投影尾部前导）→ 无头兜底组，startedAt 缺省', () => {
    const turns = groupTurns([toolItem('t0'), assistantMsg('a0'), userMsg('u1'), assistantMsg('a1')])
    expect(shape(turns)).toEqual([
      { user: undefined, startedAt: undefined, items: ['t0', 'a0'] },
      { user: 'u1', startedAt: undefined, items: ['a1'] }
    ])
  })
})

describe('groupTurns 压缩条分组（D9 + D1 两轮修订）', () => {
  it('直播压缩在后续工作尚未到达时就属于原回合，停止后归属不变', () => {
    const items = [userMsg('u'), assistantMsg('a'), { ...compactionBar('bar'), compactionInRun: true }]
    expect(groupTurns(items)).toHaveLength(1)
    expect(groupTurns([...items, assistantMsg('next')])).toHaveLength(1)
    expect(groupTurns(items)[0].items.map((item) => item.id)).toEqual(['a', 'bar'])
  })

  it('显式回合外压缩不因后续续写被并回', () => {
    const turns = groupTurns([userMsg('u'), assistantMsg('a'), { ...compactionBar('bar'), compactionInRun: false }, assistantMsg('next')])
    expect(turns).toHaveLength(2)
    expect(turns[1].items.map((item) => item.id)).toEqual(['bar'])
  })
  it('轮间自动压缩（bar 早于回合工作收尾）：行内过程行，回合不被截断，一条 user 恒一组', () => {
    const turns = groupTurns([
      userMsg('u1', 10),
      toolItem('t1'),
      compactionBar('bar1', 30), // 压缩打断在工具之后、回复之前
      assistantMsg('a1', 40)
    ])
    expect(shape(turns)).toEqual([{ user: 'u1', startedAt: undefined, items: ['t1', 'bar1', 'a1'] }])
  })

  it('回合外压缩（手动「立即压缩」，bar 后直到下一 user 无工作项）：独立成行，不塞进上一回合（手动压缩独立成行）', () => {
    const turns = groupTurns([
      userMsg('u1', 10),
      assistantMsg('a1', 20),
      compactionBar('bar1', 5_000) // idle 手动压缩
    ])
    expect(shape(turns)).toEqual([
      { user: 'u1', startedAt: undefined, items: ['a1'] },
      { user: undefined, startedAt: undefined, items: ['bar1'] }
    ])
  })

  it('恢复路形态（bar 晚于上一轮但后续还有轮次）：判据向后看，仍算轮间行内', () => {
    const turns = groupTurns([
      userMsg('u1', 10),
      assistantMsg('a1', 20),
      compactionBar('bar1', 30), // 溢出恢复：压缩后 continue 重试
      assistantMsg('a2', 50)
    ])
    expect(shape(turns)).toEqual([{ user: 'u1', startedAt: undefined, items: ['a1', 'bar1', 'a2'] }])
  })

  it('bar 后随 pruned 副行：同组行内（ProcessItem 的 PrunedBar 分支渲染）', () => {
    const turns = groupTurns([userMsg('u1', 10), compactionBar('bar1', 30), prunedItem('p1', 30), assistantMsg('a1', 40)])
    expect(shape(turns)).toEqual([{ user: 'u1', startedAt: undefined, items: ['bar1', 'p1', 'a1'] }])
  })

  it('同一回合多次轮间压缩：多条 bar 都行内，仍恒一组（旧形态会切出 2N+1 组）', () => {
    const turns = groupTurns([
      userMsg('u1', 10),
      assistantMsg('a1', 20),
      compactionBar('bar1', 30),
      assistantMsg('a2', 50),
      compactionBar('bar2', 60),
      assistantMsg('a3', 70)
    ])
    expect(shape(turns)).toEqual([{ user: 'u1', startedAt: undefined, items: ['a1', 'bar1', 'a2', 'bar2', 'a3'] }])
  })

  it('独立 bar 之后来新 user：正常开新组，不落在 bar 组里', () => {
    const turns = groupTurns([
      userMsg('u1', 10),
      { ...assistantMsg('a1', 20), durationMs: 1_000 },
      compactionBar('bar1', 5_000),
      userMsg('u2', 6_000),
      assistantMsg('a2', 7_000)
    ])
    expect(shape(turns)).toEqual([
      { user: 'u1', startedAt: undefined, items: ['a1'] },
      { user: undefined, startedAt: undefined, items: ['bar1'] },
      { user: 'u2', startedAt: undefined, items: ['a2'] }
    ])
  })

  it('开头无 user 只有 bar（盘上旧转录边角）：无头兜底组，bar 是普通项', () => {
    const turns = groupTurns([compactionBar('bar1', 10), assistantMsg('a1', 40)])
    expect(shape(turns)).toEqual([{ user: undefined, startedAt: undefined, items: ['bar1', 'a1'] }])
  })
})
