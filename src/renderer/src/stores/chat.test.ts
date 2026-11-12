/**
 * chat store 纯逻辑单元测试（docs/计划-测试体系.md S3）：IPC 剥壳 / 段展平 /
 * 终态替换并回（审批锚回 + 压缩条时间序合并，D9 —— run.completed 整段替换
 * 吞 pruned/bar = 「已裁剪」行消失的回归钉）。事件驱动的 store 行为（伪事件
 * 序列经 bindEngineEvents）见 chat-store.test.tsx；本文件只测可纯调的函数。
 */
import type { ChatMessage, ToolCallRecord } from '@/env.d'
import { describe, expect, it } from 'vitest'
import { flatWithApprovals, flatWithCompaction, flattenSegments, unwrapIpcError } from './chat'
import type { ApprovalItem, MessageItem, PrunedItem, ToolItem } from './chat'

// ———— fixture 工厂 ————

const call = (callId: string, name = 'read'): ToolCallRecord => ({
  callId,
  name,
  kind: name,
  summary: `${name}(a.ts)`,
  status: 'ok'
})

const segment = (id: string, content: string, toolCalls?: ToolCallRecord[]): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp: Number(id.replace(/\D/g, '')) || 1,
  ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {})
})

describe('unwrapIpcError', () => {
  it('剥掉 Electron 统一前缀（带 "Error: " 内层）', () => {
    expect(unwrapIpcError(new Error("Error invoking remote method 'engine:request': Error: 会话正在回复中，请先停止或等待完成"))).toBe(
      '会话正在回复中，请先停止或等待完成'
    )
  })
  it('不带内层 "Error: " 的形态同样剥', () => {
    expect(unwrapIpcError(new Error("Error invoking remote method 'engine:request': InvalidParams: x"))).toBe('InvalidParams: x')
  })
  it('协议自身的错误消息原样保留（无前缀不误伤）', () => {
    expect(unwrapIpcError(new Error('会话正在回复中'))).toBe('会话正在回复中')
  })
  it('非 Error 输入走 String()', () => {
    expect(unwrapIpcError(42)).toBe('42')
  })
})

describe('flattenSegments', () => {
  it('每段先落工具卡再落消息本体；纯工具段不落本体（只留卡）', () => {
    const out = flattenSegments([
      segment('a1', '先说两句', [call('t1')]),
      segment('a2', '', [call('t2'), call('t3')]), // 纯工具段
      segment('a3', '收尾')
    ])
    expect(out.map((i) => i.id)).toEqual(['t1', 'a1', 't2', 't3', 'a3'])
    // 卡形状：ToolItem 全字段投影
    const card = out[0] as ToolItem
    expect(card).toMatchObject({ id: 't1', type: 'tool', name: 'read', toolKind: 'read', status: 'ok' })
    // 消息本体剥掉 toolCalls（卡已独立，不双记）
    expect((out[1] as ChatMessage).toolCalls).toBeUndefined()
  })

  it('无正文但有思考的段落消息本体（thinking 也要可见）', () => {
    const out = flattenSegments([{ ...segment('a1', ''), thinking: 'hmm' }])
    expect(out).toHaveLength(1)
    expect((out[0] as ChatMessage).thinking).toBe('hmm')
  })
})

describe('flatWithApprovals（终态替换的审批锚回）', () => {
  const approval = (id: string, name = 'write'): ApprovalItem => ({
    id,
    type: 'approval',
    toolName: name,
    toolKind: name,
    summary: `${name}(a.ts)`,
    status: 'approved'
  })
  const tool = (id: string, name = 'read'): ToolItem => ({
    id,
    type: 'tool',
    name,
    toolKind: name,
    summary: `${name}(a.ts)`,
    status: 'ok'
  })

  it('痕迹行锚回名+摘要匹配的卡之前（时序：先裁决后执行）；配不上退尾部', () => {
    const flat: MessageItem[] = [tool('t1'), assistantTail('a1'), tool('t2', 'write')]
    const out = flatWithApprovals(flat, [approval('r1', 'write')])
    expect(out.map((i) => i.id)).toEqual(['t1', 'a1', 'r1', 't2'])
    // 缺卡兜底
    const out2 = flatWithApprovals([tool('t1')], [approval('r9', 'bash')])
    expect(out2.map((i) => i.id)).toEqual(['t1', 'r9'])
  })

  it('kept 空 → 原引用直通', () => {
    const flat: MessageItem[] = [tool('t1')]
    expect(flatWithApprovals(flat, [])).toBe(flat)
  })

  const assistantTail = (id: string): ChatMessage => ({ id, role: 'assistant', content: 'done', timestamp: 5 })
})

describe('flatWithCompaction（终态替换的压缩条/副行并回，D9 回归钉）', () => {
  const bar = (id: string, at: number): ChatMessage => ({
    id,
    role: 'compaction',
    content: 'S',
    compaction: { tokensBefore: 1, tokensAfter: 2 },
    timestamp: at
  })
  const pruned = (id: string, at: number): PrunedItem => ({
    id,
    type: 'pruned',
    entries: [{ toolCallId: 't9', originalChars: 9, prunedChars: 5 }],
    timestamp: at
  })

  it('bar 按时间序插回：首个 timestamp 更大的项之前（验收钉：整段替换吞条 = 「已裁剪」行消失）', () => {
    const flat: MessageItem[] = [
      { id: 's1', role: 'assistant', content: '段1', timestamp: 10 },
      { id: 's2', role: 'assistant', content: '段2', timestamp: 50 }
    ]
    const out = flatWithCompaction(flat, [bar('b1', 30)])
    expect(out.map((i) => i.id)).toEqual(['s1', 'b1', 's2'])
  })

  it('工具卡用执行终点（endedAt ?? startedAt）参与时间序', () => {
    const flat: MessageItem[] = [
      { id: 't1', type: 'tool', name: 'read', toolKind: 'read', summary: 's', status: 'ok', startedAt: 5, endedAt: 20 },
      { id: 's2', role: 'assistant', content: '段', timestamp: 40 }
    ]
    // bar(30)：t1 终点 20 < 30 不挡位，s2 40 > 30 → 插 s2 之前
    const out = flatWithCompaction(flat, [bar('b1', 30)])
    expect(out.map((i) => i.id)).toEqual(['t1', 'b1', 's2'])
  })

  it('全部早于 extra → 退尾部；kept 空 → 原引用', () => {
    const flat: MessageItem[] = [{ id: 's1', role: 'assistant', content: 'x', timestamp: 10 }]
    expect(flatWithCompaction(flat, [bar('b1', 99)]).map((i) => i.id)).toEqual(['s1', 'b1'])
    expect(flatWithCompaction(flat, [])).toBe(flat)
  })

  it('bar + pruned 成对并回（completed 手术同款形态）', () => {
    const flat: MessageItem[] = [
      { id: 's1', role: 'assistant', content: '段1', timestamp: 10 },
      { id: 's2', role: 'assistant', content: '段2', timestamp: 50 }
    ]
    const out = flatWithCompaction(flat, [bar('b1', 30), pruned('p1', 30)])
    // pruned 与 bar 同 timestamp：先插 bar，pruned 随后（首个 > 30 仍是 s2）→ 紧随 bar
    expect(out.map((i) => i.id)).toEqual(['s1', 'b1', 'p1', 's2'])
  })
})
