/**
 * TurnGroup 组件测试（docs/模块/测试.md，RTL + jsdom）—— 聚焦
 * 「分组 → 渲染」的边界分支，文案即验收口径：
 * - 压缩条独立行（D9：不套「已工作」头条，压缩不是 run）；
 * - 零内容 done 组只渲染用户泡（第七轮验收"双已工作"回归）；
 * - live 零内容组仍含流内 WorkingLine（等待首片时也保留活动信号）；
 * - 「已工作 X.XXs」带秒数（第八轮验收 startedAt 继承回归）。
 * MessageRow / MessageScrollerItem mock 掉（几何归 scroller 集成回归），
 * RunTrace / CompactionBar / PrunedBar 用真件 —— 它们的文案正是被验收的呈现。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '@/env.d'
import { describe, expect, it, vi } from 'vitest'
import type { ChatTurn } from './TurnGroup'
import { TurnGroup } from './TurnGroup'
import type { MessageItem, PrunedItem } from '@/stores/chat'

// mock 忠实带 data-slot / data-message-id（折叠体条目摘除包装的回归钉要查它）
vi.mock('@/components/ui/message-scroller', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/ui/message-scroller')>(),
  MessageScrollerPinnedRow: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MessageScrollerItem: ({ children, messageId }: { children: React.ReactNode; messageId?: string }) => (
    <div data-slot="message-scroller-item" data-message-id={messageId}>
      {children}
    </div>
  )
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

describe('TurnGroup 压缩条两形（D9 保留式 + D1 两轮修订）', () => {
  it('轮间自动压缩：整个回合一个收起的工作头，展开后bar仍在原回合内', () => {
    const turn: ChatTurn = {
      user: userMsg('u1', 1_000),
      items: [assistantMsg('a1', 2_000), compactionBar('bar1', 3_000), assistantMsg('a2', 4_000)]
    }
    render(<TurnGroup turn={turn} phase="stopped" />)
    // 一条 user 恒一个工作头（旧形态 bar 截断回合 → 一条消息 2N+1 个头）
    expect(screen.getAllByText(/已工作|已停止/)).toHaveLength(1)
    const trigger = screen.getByRole('button', { name: '已停止' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('上下文已压缩')).not.toBeVisible()
    fireEvent.click(trigger)
    // 默认收起不改变bar归属，用户展开后仍能看到原位留痕。
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('上下文已压缩')).toBeVisible()
  })

  it('回合外压缩（手动「立即压缩」）：bar 独立成行直接可见，不套「已工作」头条（手动压缩独立成行）', () => {
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

describe('TurnGroup 零内容组', () => {
  it('live停止后详情默认收起，半截终答仍常驻且可继续展开过程', () => {
    const partial = { ...assistantMsg('streaming'), content: '保留的半截终答' }
    const turn: ChatTurn = { user: userMsg('u1'), items: [assistantMsg('middle'), partial] }
    const view = render(<TurnGroup turn={turn} phase="live" />)
    expect(screen.getByTestId('msg-middle')).toBeVisible()
    view.rerender(<TurnGroup turn={{ ...turn, items: [turn.items[0], { ...partial, id: 'final' }] }} phase="stopped" />)
    const trigger = screen.getByRole('button', { name: '已停止' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('msg-middle')).not.toBeVisible()
    const answer = screen.getByTestId('msg-final')
    expect(answer).toBeVisible()
    expect(answer.closest('[data-slot="trace-collapsible-content"]')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByTestId('msg-middle')).toBeVisible()
    expect(screen.getByTestId('msg-final')).toBe(answer)
  })

  it('done 相位：只渲染用户泡，不挂「已工作」空壳（第七轮验收"双已工作"回归）', () => {
    const turn: ChatTurn = { user: userMsg('u1'), items: [] }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByTestId('msg-u1')).toBeInTheDocument()
    expect(screen.queryByText(/已工作/)).not.toBeInTheDocument()
  })

  it('live 相位：乐观消息刚上屏就有唯一流内工作行与码表', () => {
    const turn: ChatTurn = { user: userMsg('u1'), items: [] }
    const { container } = render(<TurnGroup turn={turn} phase="live" />)
    const source = container.querySelector('[data-slot="live-working-line-source"]')!
    expect(screen.getAllByText('工作中')).toHaveLength(1)
    expect(source).not.toBeNull()
    expect(source).toContainElement(screen.getByText('工作中'))
    expect(source).toContainElement(screen.getByText(/\d+\.\d\ds/))
    expect(source.closest('[aria-hidden="true"]')).toBeNull()
  })

  it.each([
    ['done', '已工作'],
    ['stopped', '已停止'],
    ['failed', '出错了'],
  ] as const)('live → %s 时工作行交接给唯一终态头条', (phase, label) => {
    const turn: ChatTurn = { user: userMsg('u1'), items: [] }
    const view = render(<TurnGroup turn={turn} phase="live" />)
    view.rerender(<TurnGroup turn={{ ...turn, items: [assistantMsg('a1')] }} phase={phase} />)
    expect(view.container.querySelector('[data-slot="live-working-line-source"]')).toBeNull()
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(label))).toHaveLength(1)
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

  it('末段 timestamp 是请求开口径：收尾加该段 durationMs，不倒挂于模型耗时', () => {
    // 实测形态：user@1000，末段开口 8850、自身模型耗时 2520ms ——
    // 只算开口差得 7.85s，比统计行的「10.37s 模型」还短（倒挂）
    const turn: ChatTurn = {
      user: userMsg('u1', 1_000),
      items: [{ ...assistantMsg('a1', 8_850), durationMs: 2_520 }]
    }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('已工作 10.37s')).toBeInTheDocument()
    expect(screen.queryByText('已工作 7.85s')).not.toBeInTheDocument()
  })

  it('末条是纯工具段：收尾取工具卡 endedAt（执行收尾打点）', () => {
    const tool: MessageItem = {
      id: 't1',
      type: 'tool',
      name: 'read',
      toolKind: 'read',
      summary: 'read(big.txt)',
      status: 'ok',
      startedAt: 5_000,
      endedAt: 9_200
    }
    const turn: ChatTurn = { user: userMsg('u1', 1_000), items: [assistantMsg('a1', 4_800), tool] }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('已工作 8.20s')).toBeInTheDocument()
  })

  it('无 user 头组（压缩条截断出的续组）用继承的 startedAt 起算 —— 有秒数不裸奔', () => {
    const turn: ChatTurn = { items: [assistantMsg('a1', 5_100)], startedAt: 1_000 }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('已工作 4.10s')).toBeInTheDocument()
  })
})

describe('TurnGroup 已工作头条下分割线常驻（决定 18：不随折叠收起）', () => {
  it('divider 存在且在折叠面板外 —— 放回面板内则收起态 hidden，常驻即破', () => {
    // 两条 assistant：末条为终答，前条进过程体 —— 有过程才有折叠机构与分割线
    const turn: ChatTurn = { user: userMsg('u1'), items: [assistantMsg('a1', 3_000), assistantMsg('a2', 5_100)] }
    const { container } = render(<TurnGroup turn={turn} phase="done" />)
    const divider = container.querySelector('[data-slot=run-trace-divider]')
    expect(divider).not.toBeNull()
    expect(divider?.closest('[data-slot=trace-collapsible-content]')).toBeNull()
  })
})

describe('TurnGroup 终态折叠体条目摘除 scroller item（收起动画卡顿根因回归钉）', () => {
  it('折叠体内工具卡不套 MessageScrollerItem（content-visibility 扰动开合轨道分母）；user/终答顶层包装保留', () => {
    const tool: MessageItem = {
      id: 't1',
      type: 'tool',
      name: 'read',
      toolKind: 'read',
      summary: 'read(a.ts)',
      status: 'ok'
    }
    const turn: ChatTurn = { user: userMsg('u1'), items: [tool, assistantMsg('a1', 5_100)] }
    const { container } = render(<TurnGroup turn={turn} phase="done" />)
    const wrapped = Array.from(container.querySelectorAll('[data-slot=message-scroller-item]'))
    // 收起态折叠体（keepMounted 常驻）里的工具卡不在任何 scroller item 内
    expect(wrapped.some((el) => el.textContent.includes('已读取'))).toBe(false)
    // 顶层定位包装不受影响：刻度/scrollToMessage 的目标（user 与终答）
    expect(wrapped.map((el) => el.getAttribute('data-message-id'))).toEqual(['u1', 'a1'])
  })
})
