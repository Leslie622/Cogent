/**
 * groupTurns 单元测试（docs/计划-测试体系.md S3）—— 渲染期回合分组的
 * 纯逻辑。重点钉 D9 保留式分组：压缩条自成一组且**截断当前组**（第三轮
 * 验收"压缩后无回复"= bar 组吞掉后续回复的回归钉）与第八轮验收的
 * startedAt 继承（无 user 续组的墙钟起点，否则「已工作」没秒数）。
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

describe('groupTurns 压缩条分组（D9）', () => {
  it('bar 自成一组且截断当前组：[user|过程项] [bar] [续组=回复]，回复不被吞（第三轮验收回归钉）', () => {
    const turns = groupTurns([
      userMsg('u1', 10),
      toolItem('t1'),
      compactionBar('bar1', 30), // 压缩打断在工具之后、回复之前
      assistantMsg('a1', 40)
    ])
    expect(shape(turns)).toEqual([
      { user: 'u1', startedAt: undefined, items: ['t1'] }, // 截断：过程留在原组
      { user: undefined, startedAt: 10, items: ['bar1'] }, // bar 组继承 user 的墙钟起点
      { user: undefined, startedAt: 10, items: ['a1'] } // 续组（无头）也继承 —— turnDurationMs 有起点
    ])
  })

  it('bar 后随 pruned 副行：副行开续组（ProcessItem 的 PrunedBar 分支渲染），bar 组保持纯 bar', () => {
    const turns = groupTurns([userMsg('u1', 10), compactionBar('bar1', 30), prunedItem('p1', 30), assistantMsg('a1', 40)])
    expect(shape(turns)).toEqual([
      { user: 'u1', startedAt: undefined, items: [] },
      { user: undefined, startedAt: 10, items: ['bar1'] },
      { user: undefined, startedAt: 10, items: ['p1', 'a1'] }
    ])
  })

  it('多次压缩多条 bar 各自成组、各自截断（bar 组继承最近 user 的墙钟起点）', () => {
    const turns = groupTurns([
      userMsg('u1', 10),
      assistantMsg('a1', 20),
      compactionBar('bar1', 30),
      userMsg('u2', 40),
      assistantMsg('a2', 50),
      compactionBar('bar2', 60),
      assistantMsg('a3', 70)
    ])
    expect(shape(turns)).toEqual([
      { user: 'u1', startedAt: undefined, items: ['a1'] },
      { user: undefined, startedAt: 10, items: ['bar1'] },
      { user: 'u2', startedAt: undefined, items: ['a2'] }, // user 组起点 = user.timestamp（startedAt 只属无头组）
      { user: undefined, startedAt: 40, items: ['bar2'] }, // 继承的是最近 user（u2）
      { user: undefined, startedAt: 40, items: ['a3'] }
    ])
  })

  it('bar 之后来新 user：正常开新组，不落在续组里', () => {
    const turns = groupTurns([userMsg('u1', 10), compactionBar('bar1', 30), userMsg('u2', 40), assistantMsg('a2', 50)])
    expect(shape(turns)).toEqual([
      { user: 'u1', startedAt: undefined, items: [] },
      { user: undefined, startedAt: 10, items: ['bar1'] },
      { user: 'u2', startedAt: undefined, items: ['a2'] }
    ])
  })
})
