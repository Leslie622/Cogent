/**
 * TurnGroup 组件测试（docs/计划/测试体系.md S4，RTL + jsdom）—— 聚焦
 * 「分组 → 渲染」的边界分支，文案即验收口径：
 * - 压缩条独立行（D9：不套「已工作」头条，压缩不是 run）；
 * - 零内容 done 组只渲染用户泡（第七轮验收"双已工作"回归）；
 * - live 零内容组保留 WorkingLine（乐观消息的工作中行）；
 * - 「已工作 X.XXs」带秒数（第八轮验收 startedAt 继承回归）。
 * MessageRow / MessageScrollerItem mock 掉（markdown 渲染重且与本件无关），
 * RunTrace / WorkingLine / CompactionBar / PrunedBar 用真件 —— 它们的文案
 * 正是被验收的呈现。
 */
import { render, screen } from '@testing-library/react'
import type { ChatMessage } from '@/env.d'
import { describe, expect, it, vi } from 'vitest'
import type { ChatTurn } from './TurnGroup'
import { TurnGroup } from './TurnGroup'
import type { PrunedItem } from '@/stores/chat'

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('./MessageRow', () => ({
  MessageRow: ({ message }: { message: ChatMessage }) => <div data-testid={`msg-${message.id}`}>{message.content}</div>,
  UsageLine: () => <div data-testid="usage-line" />
}))

const userMsg = (id: string, at = 1_000): ChatMessage => ({ id, role: 'user', content: `text-${id}`, timestamp: at })
const assistantMsg = (id: string, at = 2_000): ChatMessage => ({
  id,
  role: 'assistant',
  content: `text-${id}`,
  timestamp: at
})
const compactionBar = (id: string, at = 3_000): ChatMessage => ({
  id,
  role: 'compaction',
  content: 'SUMMARY',
  compaction: { tokensBefore: 90_000, tokensAfter: 10_000 },
  timestamp: at
})

describe('TurnGroup 压缩条独立行（D9）', () => {
  it('bar 组只渲染折叠条：不套「已工作」头条、不带工作中行（压缩不是 run）', () => {
    const turn: ChatTurn = { items: [compactionBar('bar1')] }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('上下文已压缩')).toBeInTheDocument()
    expect(screen.queryByText(/已工作/)).not.toBeInTheDocument()
  })

  it('pruned 副行经 ProcessItem 渲染「已裁剪 N 处工具输出」（live 相位过程摊开可见；终态收进折叠体）', () => {
    const pruned: PrunedItem = {
      id: 'p1',
      type: 'pruned',
      entries: [{ toolCallId: 't1', originalChars: 20_000, prunedChars: 5_155 }],
      timestamp: 3_000
    }
    const turn: ChatTurn = { items: [pruned], startedAt: 1_000 }
    render(<TurnGroup turn={turn} phase="live" />)
    expect(screen.getByText(/已裁剪 1 处工具输出/)).toBeInTheDocument()
  })
})

describe('TurnGroup 零内容组（D9 截断的副产物）', () => {
  it('done 相位：只渲染用户泡，不挂「已工作」空壳（第七轮验收"双已工作"回归）', () => {
    const turn: ChatTurn = { user: userMsg('u1'), items: [] }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByTestId('msg-u1')).toBeInTheDocument()
    expect(screen.queryByText(/已工作/)).not.toBeInTheDocument()
  })

  it('live 相位：乐观消息刚上屏，工作中行还在（WorkingLine 计时形态 /\\d+\\.\\d\\ds/）', () => {
    const turn: ChatTurn = { user: userMsg('u1'), items: [] }
    render(<TurnGroup turn={turn} phase="live" />)
    expect(screen.getByText(/\d+\.\d\ds/)).toBeInTheDocument()
  })
})

describe('TurnGroup 终态头条（已工作时长口径）', () => {
  it('墙钟 = user.timestamp → 末条内容消息 timestamp，带秒数（第八轮验收回归）', () => {
    const turn: ChatTurn = {
      user: userMsg('u1', 1_000),
      items: [assistantMsg('a1', 5_100)] // 4100ms → 4.10s
    }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('已工作 4.10s')).toBeInTheDocument()
    expect(screen.getByTestId('msg-a1')).toBeInTheDocument()
  })

  it('无 user 头组（压缩条截断出的续组）用继承的 startedAt 起算 —— 有秒数不裸奔', () => {
    const turn: ChatTurn = { items: [assistantMsg('a1', 5_100)], startedAt: 1_000 }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('已工作 4.10s')).toBeInTheDocument()
  })
})
