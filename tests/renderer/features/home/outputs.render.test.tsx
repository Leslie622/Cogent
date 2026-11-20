/** 真实卡片与回合组件：终态门、无终答、替换清空、继续旧卡和动作入口。 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnOutputs } from '@shared/outputs'
import { TurnGroup } from '@/features/home/TurnGroup'
import { emptyBucket, useChatStore } from '@/stores/chat/store'
import { useFilePreviewStore } from '@/stores/file-preview'

vi.mock('@/components/ui/message-scroller', () => ({ MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>, MessageScrollerPinnedRow: ({ children }: { children: ReactNode }) => <>{children}</> }))
const user = { id: 'u1', role: 'user' as const, content: '生成报告', timestamp: 100, turnId: 't1' }
const answer = { id: 'a1', role: 'assistant' as const, content: '正文已完成', timestamp: 200, turnId: 't1' }
const item = (name: string) => ({ outputId: name, sourcePath: '/work/' + name, realPath: '/work/' + name, name, size: 10, confirmedAt: 1000, copy: { status: 'saved' as const, relativePath: name, sha256: 'a'.repeat(64) } })
const snapshot = (overrides: Partial<TurnOutputs> = {}): TurnOutputs => ({ version: 1, sessionId: 's1', turnId: 't1', revision: 3, state: 'ready', declared: true, active: [item('报告.txt')], published: [item('报告.txt')], outcome: 'completed', ...overrides })
function seed(doc: TurnOutputs | undefined) { useChatStore.setState({ bySession: { s1: { ...emptyBucket(), outputs: doc === undefined ? {} : { t1: doc } } } }) }
beforeEach(() => { seed(undefined); window.cogent = { engineRequest: vi.fn().mockResolvedValue({ ok: true }), onEngineEvent: () => () => {} } as unknown as typeof window.cogent })

describe('产物卡片呈现', () => {
  it('未申报没有卡；申报运行中不新挂；终态显示正式卡，清空后撤回', () => {
    const view = render(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="live" />)
    expect(screen.queryByLabelText('产物文件')).toBeNull()
    act(() => seed(snapshot({ state: 'running', published: [] })))
    expect(screen.queryByLabelText('产物文件')).toBeNull()
    act(() => seed(snapshot()))
    view.rerender(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="done" />)
    expect(screen.getByLabelText('产物文件')).toHaveTextContent('报告.txt')
    act(() => seed(snapshot({ revision: 4, active: [], published: [] })))
    expect(screen.queryByLabelText('产物文件')).toBeNull()
  })
  it('停止且无终答也显示已确认卡，失败原因和source-only诚实呈现', () => {
    const only = { ...item('大文件.zip'), copy: { status: 'source-only' as const, reason: '超过副本预算' } }
    seed(snapshot({ published: [only], active: [only], outcome: 'aborted' }))
    render(<TurnGroup turn={{ user, items: [] }} sessionId="s1" phase="stopped" />)
    expect(screen.getByLabelText('产物文件')).toHaveTextContent('回合已停止')
    expect(screen.getByText(/仅当前原文件/)).toBeInTheDocument()
  })
  it('手动继续保留旧发布卡并标更新中，超过3项可以完整展开', () => {
    seed(snapshot({ state: 'running', published: ['a.txt', 'b.pdf', 'c.docx', 'd.zip'].map(item) }))
    render(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="live" />)
    expect(screen.getByText('更新中')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-output-card]')).toHaveLength(3)
    fireEvent.click(screen.getByText('展开其余 1 个文件'))
    expect(document.querySelectorAll('[data-output-card]')).toHaveLength(4)
  })
  it('点击卡片交给既有预览owner，携带本会话/回合/版本/产物ID', () => {
    seed(snapshot())
    const open = vi.spyOn(useFilePreviewStore.getState(), 'open').mockResolvedValue(undefined)
    render(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="done" />)
    fireEvent.click(screen.getByText('预览交付副本'))
    expect(open).toHaveBeenCalledWith({ sessionId: 's1', turnId: 't1', refs: [] }, '/work/报告.txt', { sessionId: 's1', turnId: 't1', revision: 3, outputId: '报告.txt', version: 'delivery' })
    open.mockRestore()
  })
})
