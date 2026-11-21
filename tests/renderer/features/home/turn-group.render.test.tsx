/**
 * TurnGroup 组件测试（docs/模块/测试.md，RTL + jsdom）—— 聚焦
 * 「分组 → 渲染」的边界分支，文案即验收口径：
 * - 压缩条独立行（D9：不套「用时」头条，压缩不是 run）；
 * - 零内容 done 组只渲染用户泡（第七轮验收"双用时"回归）；
 * - live 零内容组仍含流内 WorkingLine（等待首片时也保留活动信号）；
 * - 「用时 X.XX 秒」带秒数（第八轮验收 startedAt 继承回归）。
 * MessageRow / MessageScrollerItem mock 掉（几何归 scroller 集成回归），
 * RunTrace / CompactionBar / PrunedBar 用真件 —— 它们的文案正是被验收的呈现。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '@/env.d'
import { describe, expect, it, vi } from 'vitest'
import type { ChatTurn } from '@/features/home/TurnGroup'
import { TurnGroup } from '@/features/home/TurnGroup'
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
vi.mock('@/features/home/MessageRow', () => ({
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
    expect(screen.getAllByText(/用时|已停止/)).toHaveLength(1)
    const trigger = screen.getByRole('button', { name: '已停止' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('上下文已压缩')).not.toBeVisible()
    fireEvent.click(trigger)
    // 默认收起不改变bar归属，用户展开后仍能看到原位留痕。
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('上下文已压缩')).toBeVisible()
  })

  it('回合外压缩（手动「立即压缩」）：bar 独立成行直接可见，不套「用时」头条（手动压缩独立成行）', () => {
    const turn: ChatTurn = { items: [compactionBar('bar1')] }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('上下文已压缩')).toBeInTheDocument()
    expect(screen.queryByText(/用时/)).not.toBeInTheDocument()
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

  it('done 相位：只渲染用户泡，不挂「用时」空壳（第七轮验收"双用时"回归）', () => {
    const turn: ChatTurn = { user: userMsg('u1'), items: [] }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByTestId('msg-u1')).toBeInTheDocument()
    expect(screen.queryByText(/用时/)).not.toBeInTheDocument()
  })

  it('live 相位：乐观消息刚上屏就有唯一流内工作行与码表', () => {
    const turn: ChatTurn = { user: userMsg('u1', Date.now()), items: [] }
    const { container } = render(<TurnGroup turn={turn} phase="live" />)
    const source = container.querySelector('[data-slot="live-working-line-source"]')!
    expect(screen.getAllByText('工作中')).toHaveLength(1)
    expect(source).not.toBeNull()
    expect(source).toContainElement(screen.getByText('工作中'))
    expect(source).toContainElement(screen.getByText(/\d+\.\d\d 秒/))
    expect(source.closest('[aria-hidden="true"]')).toBeNull()
  })

  it('live 零内容组不渲染空过程容器（工作中→出错了瞬时翻相零高度跳动回归）', () => {
    // 空容器会多吃一个 gap-3：回合底缘比终态「出错了」头条高 12px，贴底
    // 跟随时立马失败会让上方内容整体下沉 —— 断言用户泡与工作行之间无空盒子
    const turn: ChatTurn = { user: userMsg('u1'), items: [] }
    const { container } = render(<TurnGroup turn={turn} phase="live" />)
    const children = Array.from(container.children)
    expect(children).toHaveLength(2)
    expect(children[0].getAttribute('data-message-id')).toBe('u1')
    expect(children[1].getAttribute('data-slot')).toBe('live-working-line-source')
  })

  it.each([
    ['done', '用时'],
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

describe('TurnGroup 终态头条（用时时长口径）', () => {
  it('墙钟 = user.timestamp → 末条内容消息 timestamp，带秒数（第八轮验收回归）', () => {
    const turn: ChatTurn = {
      user: userMsg('u1', 1_000),
      items: [assistantMsg('a1', 5_100)] // 4100ms → 4.10s
    }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('用时 4.10 秒')).toBeInTheDocument()
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
    expect(screen.getByText('用时 10.37 秒')).toBeInTheDocument()
    expect(screen.queryByText('用时 7.85 秒')).not.toBeInTheDocument()
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
    expect(screen.getByText('用时 8.20 秒')).toBeInTheDocument()
  })

  it('无 user 头组（压缩条截断出的续组）用继承的 startedAt 起算 —— 有秒数不裸奔', () => {
    const turn: ChatTurn = { items: [assistantMsg('a1', 5_100)], startedAt: 1_000 }
    render(<TurnGroup turn={turn} phase="done" />)
    expect(screen.getByText('用时 4.10 秒')).toBeInTheDocument()
  })
})

describe('TurnGroup 用时头条下分割线已取消（2026-11-20 定调，推翻决定 18 的常驻线）', () => {
  it('头条后直接进折叠面板，不存在 run-trace-divider', () => {
    // 两条 assistant：末条为终答，前条进过程体 —— 有过程才有折叠机构
    const turn: ChatTurn = { user: userMsg('u1'), items: [assistantMsg('a1', 3_000), assistantMsg('a2', 5_100)] }
    const { container } = render(<TurnGroup turn={turn} phase="done" />)
    expect(container.querySelector('[data-slot=run-trace-divider]')).toBeNull()
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
    expect(wrapped.some((el) => el.textContent.includes('读取'))).toBe(false)
    // 顶层定位包装不受影响：刻度/scrollToMessage 的目标（user 与终答）
    expect(wrapped.map((el) => el.getAttribute('data-message-id'))).toEqual(['u1', 'a1'])
  })
})

describe('TurnGroup 工具读取记录', () => {
  it.each(['live', 'done'] as const)('%s：成功读取只展示一份路径，不额外挂文件快捷入口', (phase) => {
    const path = 'C:/Users/41631/Desktop/版本.txt'
    const tool: MessageItem = {
      id: 'read-version', type: 'tool', name: 'read', toolKind: 'read',
      summary: `read(${path})`, status: 'ok', resultSummary: '版本B', fileRefs: [{ path }]
    }
    const turn: ChatTurn = { user: userMsg('u1'), items: [tool] }
    render(<TurnGroup turn={turn} phase={phase} sessionId="read-session" />)
    if (phase === 'done') fireEvent.click(screen.getByRole('button', { name: /用时/ }))
    expect(screen.getAllByText(path)).toHaveLength(1)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /读取/ }))
    expect(screen.getByText('版本B')).toBeVisible()
    expect(tool.fileRefs).toEqual([{ path }])
  })
})

describe('TurnGroup 审批痕迹收进工具行', () => {
  it.each(['live', 'done'] as const)('%s：相同命令按 callId 归属，不重复占行', (phase) => {
    const turn: ChatTurn = {
      user: userMsg('u1'),
      items: [
        { id: 't1', type: 'tool', name: 'powershell', toolKind: 'exec', summary: 'powershell(Get-ComputerInfo)', status: 'ok' },
        { id: 'r2', callId: 't2', type: 'approval', toolName: 'powershell', toolKind: 'exec', summary: 'powershell(Get-ComputerInfo)', status: 'approved' },
        { id: 't2', type: 'tool', name: 'powershell', toolKind: 'exec', summary: 'powershell(Get-ComputerInfo)', status: 'ok' }
      ]
    }
    const { container } = render(<TurnGroup turn={turn} phase={phase} />)
    if (phase === 'done') fireEvent.click(screen.getByRole('button', { name: /用时/ }))
    const lines = Array.from(container.querySelectorAll('[data-slot="trace-line"]')).filter((line) => line.textContent.includes('Get-ComputerInfo'))
    expect(lines).toHaveLength(2)
    expect(lines[0].querySelector('[aria-label="已允许"]')).toBeNull()
    expect(lines[1].querySelector('[aria-label="已允许"]')).not.toBeNull()
    expect(screen.getAllByText('Get-ComputerInfo')).toHaveLength(2)
    expect(screen.queryByText('已允许')).not.toBeInTheDocument()
    expect(turn.items).toHaveLength(3)
  })

  it.each(['denied', 'cancelled'] as const)('%s 的裁决保留在对应工具行，不伪装成允许', (status) => {
    const turn: ChatTurn = { items: [
      { id: 'r1', callId: 't1', type: 'approval', toolName: 'write', toolKind: 'write', summary: 'write(a.ts)', status },
      { id: 't1', type: 'tool', name: 'write', toolKind: 'write', summary: 'write(a.ts)', status: 'error' }
    ] }
    render(<TurnGroup turn={turn} phase="live" />)
    expect(screen.getByRole('img', { name: status === 'denied' ? '已拒绝' : '已取消' })).toBeVisible()
    expect(screen.queryByRole('img', { name: '已允许' })).not.toBeInTheDocument()
    expect(screen.getByText('执行失败')).toBeVisible()
    expect(screen.queryByText('已写入')).not.toBeInTheDocument()
  })

  it('旧事件或缺卡保留独立审批行，不按相同摘要猜归属', () => {
    const turn: ChatTurn = { items: [
      { id: 'r1', type: 'approval', toolName: 'write', toolKind: 'write', summary: 'write(a.ts)', status: 'approved' },
      { id: 'r2', callId: 'missing', type: 'approval', toolName: 'write', toolKind: 'write', summary: 'write(a.ts)', status: 'cancelled' },
      { id: 't1', type: 'tool', name: 'write', toolKind: 'write', summary: 'write(a.ts)', status: 'ok' }
    ] }
    const { container } = render(<TurnGroup turn={turn} phase="live" />)
    expect(Array.from(container.querySelectorAll('[data-slot="trace-line"]')).filter((line) => line.textContent.includes('a.ts'))).toHaveLength(3)
    expect(screen.getAllByText('审批')).toHaveLength(2)
    expect(screen.getByText('已允许')).toBeVisible()
    expect(screen.getByText('已取消')).toBeVisible()
  })
})

describe('TurnGroup 封段正文衔接（计划/正文衔接连续性修复）', () => {
  it('工具封段（占位翻 placeholder 归过程 + 新占位另起）前后正文行同一 DOM 节点', () => {
    const poem = '先出的一段长正文'.repeat(4)
    const before: ChatTurn = {
      user: userMsg('u1'),
      items: [{ ...assistantMsg('p1'), placeholder: true, content: poem }]
    }
    const view = render(<TurnGroup turn={before} phase="live" />)
    const el1 = screen.getByText(poem)
    // 封段后的真实形态：旧段 id 不变翻 placeholder、工具卡随其后、新占位尾部另起
    view.rerender(<TurnGroup turn={{
      user: before.user,
      items: [
        { ...assistantMsg('p1'), placeholder: false, content: poem },
        { id: 'c1', type: 'tool', name: 'read', toolKind: 'read', summary: 'read(a)', status: 'running' },
        { ...assistantMsg('p2'), placeholder: true, content: '' }
      ]
    }} phase="live" />)
    // 同 key（seg-0）同父同位置：React 复用同一节点 —— 选区/渐显状态不丢
    expect(screen.getByText(poem)).toBe(el1)
    expect(el1.isConnected).toBe(true)
    expect(screen.getByTestId('msg-p2')).toBeInTheDocument()
  })
})
