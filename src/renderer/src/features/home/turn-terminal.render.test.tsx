/**
 * 回合终态与正文视觉收尾分工：用真实 TurnGroup / MessageRow / Markdown 验证
 * 尾回答的已有 DOM 能跨占位 id → 权威 id 保留（段序数 key 对齐，见
 * docs/计划/正文衔接连续性修复.md）；传入的终态相位立即生效。
 * 此处不模拟 store 的 abort 标签推导，CSS 逐帧透明度另由生产浏览器验证。
 */
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/env.d'
import type { MessageItem } from '@/stores/chat'
import { TurnGroup, type ChatTurn, type TurnPhase } from './TurnGroup'

// 滚动几何归 scroller 的真实集成回归；正文、终态头条与 Markdown 管线均使用真件。
vi.mock('@/components/ui/message-scroller', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/ui/message-scroller')>(),
  MessageScrollerPinnedRow: ({ children }: { children: ReactNode }) => <>{children}</>,
  MessageScrollerItem: ({ children, messageId }: { children: ReactNode; messageId?: string }) => (
    <div data-slot="message-scroller-item" data-message-id={messageId}>{children}</div>
  ),
}))

/** 只补 jsdom 缺失的浏览器过渡句柄；target 始终指向真实 reveal span。 */
class PendingOpacityTransition {
  transitionProperty = 'opacity'
  playState: AnimationPlayState = 'running'
  effect: KeyframeEffect
  finished: Promise<Animation>
  private resolve!: (animation: Animation) => void

  constructor(target: Element) {
    this.effect = { target } as KeyframeEffect
    this.finished = new Promise<Animation>((resolve) => { this.resolve = resolve })
  }

  finish(): void {
    this.playState = 'finished'
    this.resolve(this as unknown as Animation)
  }
}

let transitions: PendingOpacityTransition[] = []

beforeEach(() => {
  transitions = []
  vi.stubGlobal('CSSTransition', PendingOpacityTransition)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(Element.prototype, 'getAnimations').mockImplementation(function (this: Element) {
    return transitions.filter((animation) => this.contains(animation.effect.target as Element)) as unknown as Animation[]
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const user: ChatMessage = { id: 'u1', role: 'user', content: '请回答', timestamp: 1_000 }
const live: ChatMessage = { id: 'streaming', placeholder: true, role: 'assistant', content: '尾部文字', timestamp: 1_100 }
const final: ChatMessage = { ...live, id: 'answer-1', placeholder: false, durationMs: 100 }
const tool: MessageItem = {
  id: 'tool-1', type: 'tool', name: 'read', toolKind: 'read', summary: 'read(a.ts)',
  status: 'ok', startedAt: 1_010, endedAt: 1_080,
}

function turn(answer: ChatMessage, withProcess: boolean): ChatTurn {
  return { user, items: withProcess ? [tool, answer] : [answer] }
}

function captureTail(container: HTMLElement) {
  const markdown = container.querySelector<HTMLElement>('.md-body')!
  const spans = Array.from(markdown.querySelectorAll('[data-reveal]'))
  expect(spans.length).toBeGreaterThan(0)
  const transition = new PendingOpacityTransition(spans.at(-1)!)
  transitions.push(transition)
  return { markdown, spans, transition }
}

const terminalPhases: Array<[TurnPhase, string]> = [
  ['done', '已工作 0.20s'], ['stopped', '已停止'], ['failed', '出错了'],
]

describe('尾回答终态保留与即时业务交接', () => {
  for (const withProcess of [false, true]) {
    it.each(terminalPhases)(`${withProcess ? '有过程' : '纯文本'} live → %s 保留旧正文直到过渡结束`, async (phase, label) => {
      const view = render(<TurnGroup turn={turn(live, withProcess)} phase="live" />)
      const before = captureTail(view.container)
      view.rerender(<TurnGroup turn={turn(final, withProcess)} phase={phase} />)

      expect(screen.getByText(label)).toBeInTheDocument()
      expect(screen.queryByText('工作中')).not.toBeInTheDocument()
      expect(view.container.querySelector('[data-slot="live-working-line-source"]')).toBeNull()
      expect(view.container.querySelector('.md-body')).toBe(before.markdown)
      const currentSpans = Array.from(before.markdown.querySelectorAll('[data-reveal]'))
      expect(currentSpans).toHaveLength(before.spans.length)
      currentSpans.forEach((node, index) => expect(node).toBe(before.spans[index]))
      expect(before.markdown.textContent).toBe(final.content)

      await act(async () => { before.transition.finish(); await before.transition.finished })
      expect(view.container.querySelector('.md-body')).toBe(before.markdown)
      expect(before.markdown.querySelector('[data-reveal]')).toBeNull()
      expect(before.markdown.textContent).toBe(final.content)
      expect(screen.getByText(label)).toBeInTheDocument()
    })
  }

  it('终态把thinking剥入过程体时，尾正文仍保留到过渡完成', async () => {
    const thinkingLive: ChatMessage = { ...live, thinking: '先分析问题，再形成答案。' }
    const thinkingFinal: ChatMessage = { ...final, thinking: thinkingLive.thinking, durationMs: 200 }
    const view = render(<TurnGroup turn={turn(thinkingLive, false)} phase="live" />)
    const before = captureTail(view.container)
    view.rerender(<TurnGroup turn={turn(thinkingFinal, false)} phase="done" />)

    expect(screen.getByText('已工作 0.30s')).toBeInTheDocument()
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-slot="live-working-line-source"]')).toBeNull()
    expect(view.container.querySelector('[data-slot="run-trace-divider"]')).not.toBeNull()
    expect(view.container.querySelector('.md-body')).toBe(before.markdown)
    const currentSpans = Array.from(before.markdown.querySelectorAll('[data-reveal]'))
    expect(currentSpans).toHaveLength(before.spans.length)
    currentSpans.forEach((node, index) => expect(node).toBe(before.spans[index]))

    await act(async () => { before.transition.finish(); await before.transition.finished })
    expect(view.container.querySelector('.md-body')).toBe(before.markdown)
    expect(before.markdown.querySelector('[data-reveal]')).toBeNull()
    expect(before.markdown.textContent).toBe(thinkingFinal.content)
    expect(screen.getByText('已工作 0.30s')).toBeInTheDocument()
  })

  it('最终正文非前缀改写时立即采用权威内容，不让旧尾巴挡住替换', () => {
    const view = render(<TurnGroup turn={turn(live, false)} phase="live" />)
    const before = captureTail(view.container)
    view.rerender(<TurnGroup turn={turn({ ...final, content: '权威修订正文' }, false)} phase="done" />)
    expect(screen.getByText('权威修订正文')).toBeInTheDocument()
    expect(view.container.querySelector('.md-body')!.textContent).toBe('权威修订正文')
    expect(view.container.querySelector('[data-reveal]')).toBeNull()
    expect(before.spans.every((node) => !node.isConnected)).toBe(true)
    expect(screen.getByText('已工作 0.20s')).toBeInTheDocument()
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
  })

  it('失败路径权威消息已删除时立即卸载正文，不保留幽灵尾巴', () => {
    const view = render(<TurnGroup turn={turn(live, false)} phase="live" />)
    const before = captureTail(view.container)
    view.rerender(<TurnGroup turn={{ user, items: [] }} phase="failed" />)
    expect(screen.getByText('出错了')).toBeInTheDocument()
    expect(view.container.querySelector('.md-body')).toBeNull()
    expect(view.container.querySelector('[data-reveal]')).toBeNull()
    expect(before.markdown.isConnected).toBe(false)
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
  })

  it('新增下一条user回合时，既有user键回合的正文收尾仍留在原实例', async () => {
    const renderTurns = (turns: Array<{ value: ChatTurn; phase: TurnPhase }>) => <>
      {turns.map(({ value, phase }) => <div key={value.user!.id}><TurnGroup turn={value} phase={phase} /></div>)}
    </>
    const view = render(renderTurns([{ value: turn(live, false), phase: 'live' }]))
    const before = captureTail(view.container)
    const nextUser: ChatMessage = { id: 'u2', role: 'user', content: '下一题', timestamp: 2_000 }
    view.rerender(renderTurns([
      { value: turn(final, false), phase: 'done' },
      { value: { user: nextUser, items: [] }, phase: 'live' },
    ]))
    expect(view.container.querySelector('.md-body')).toBe(before.markdown)
    expect(before.spans.every((node) => node.isConnected)).toBe(true)
    expect(screen.getByText('下一题')).toBeInTheDocument()
    expect(screen.getAllByText('工作中')).toHaveLength(1)
    await act(async () => { before.transition.finish(); await before.transition.finished })
    expect(before.markdown.querySelector('[data-reveal]')).toBeNull()
    expect(screen.getByText('下一题')).toBeInTheDocument()
  })
})
