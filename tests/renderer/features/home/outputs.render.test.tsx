/** 真实卡片与回合组件：终态门、无终答、替换清空、继续旧卡和动作入口。 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
afterEach(() => vi.restoreAllMocks())

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
    fireEvent.click(screen.getByRole('button', { name: '打开 报告.txt' }))
    expect(open).toHaveBeenCalledWith({ sessionId: 's1', turnId: 't1', refs: [] }, '/work/报告.txt', { sessionId: 's1', turnId: 't1', revision: 3, outputId: '报告.txt', version: 'delivery' })
    open.mockRestore()
  })
  it('正常文件只显示名称、类型和打开组合钮，说明与另存操作不占文件行', () => {
    seed(snapshot({ published: [{ ...item('报告.txt'), note: '测试报告说明' }] }))
    render(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="done" />)
    const card = document.querySelector('[data-output-card]') as HTMLElement
    expect(card).toHaveTextContent('报告.txt')
    expect(card).toHaveTextContent('TXT')
    expect(card.querySelector('[data-file-icon]')).toHaveAttribute('data-file-icon', 'document')
    expect(card).not.toHaveTextContent(/字节|已保存交付副本|测试报告说明|另存为/)
    expect(screen.getByLabelText('产物文件')).not.toHaveTextContent('交付文件')
    expect(within(card).getAllByRole('button')).toHaveLength(2)
  })
  it.each([
    { label: '系统打开交付副本', action: 'open', version: 'delivery' },
    { label: '另存为…', action: 'save', version: 'delivery' },
    { label: '编辑当前原文件', action: 'editor', version: 'current' },
    { label: '在原目录定位', action: 'reveal', version: 'current' }
  ])('下拉菜单的 $label 使用正确版本并释放文件登记', async ({ label, action, version }) => {
    const interaction = userEvent.setup()
    const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>().mockResolvedValue({ leaseId: 'output-file' })
    const fileAction = vi.fn<(params: unknown) => Promise<unknown>>().mockResolvedValue(undefined)
    window.cogent.fileViewsRequest = ((method: string, params: unknown) => method === 'fileViews.action' ? fileAction(params) : engineRequest(method, params)) as typeof window.cogent.fileViewsRequest
    seed(snapshot())
    render(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="done" />)
    await interaction.click(screen.getByRole('button', { name: '报告.txt 更多操作' }))
    await interaction.click(await screen.findByRole('menuitem', { name: label }))
    expect(engineRequest).toHaveBeenCalledWith('fileViews.acquire', { source: { kind: 'output', target: { sessionId: 's1', turnId: 't1', revision: 3, outputId: '报告.txt', version } }, operationId: expect.any(String) as string })
    expect(fileAction).toHaveBeenCalledWith({ leaseId: 'output-file', action })
    await waitFor(() => expect(engineRequest).toHaveBeenCalledWith('fileViews.release', { leaseId: 'output-file' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
  it.each(['resolve', 'action'])('编辑原件在%s阶段失败用弹窗提示，文件行不插入错误，关闭后可重试', async (failure) => {
    const interaction = userEvent.setup()
    const missing = new Error('ENOENT: no such file or directory, realpath /work/报告.txt')
    const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>().mockResolvedValue({ leaseId: 'output-file' })
    const fileAction = vi.fn<(params: unknown) => Promise<unknown>>().mockResolvedValue(undefined)
    if (failure === 'resolve') engineRequest.mockRejectedValueOnce(missing)
    else fileAction.mockRejectedValueOnce(missing)
    window.cogent.fileViewsRequest = ((method: string, params: unknown) => method === 'fileViews.action' ? fileAction(params) : engineRequest(method, params)) as typeof window.cogent.fileViewsRequest
    seed(snapshot())
    render(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="done" />)
    const card = document.querySelector('[data-output-card]') as HTMLElement
    await interaction.click(screen.getByRole('button', { name: '报告.txt 更多操作' }))
    await interaction.click(await screen.findByRole('menuitem', { name: '编辑当前原文件' }))
    const dialog = await screen.findByRole('alertdialog', { name: '文件操作失败' })
    expect(dialog).toHaveTextContent(missing.message)
    expect(card).not.toHaveTextContent('ENOENT')
    expect(screen.queryByRole('menu')).toBeNull()
    if (failure === 'action') expect(engineRequest).toHaveBeenCalledWith('fileViews.release', { leaseId: 'output-file' })
    else expect(fileAction).not.toHaveBeenCalled()
    await interaction.click(within(dialog).getByRole('button', { name: '知道了' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await interaction.click(screen.getByRole('button', { name: '报告.txt 更多操作' }))
    await interaction.click(await screen.findByRole('menuitem', { name: '编辑当前原文件' }))
    expect(fileAction).toHaveBeenLastCalledWith({ leaseId: 'output-file', action: 'editor' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
  it('简化后仍显示最终版本未确认警告', () => {
    seed(snapshot({ published: [{ ...item('报告.txt'), warning: '最终版未确认，保留最近确认版本' }] }))
    render(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="done" />)
    expect(screen.getByRole('status')).toHaveTextContent('最终版未确认，保留最近确认版本')
  })
  it('不同产物使用同一套文件类型匹配，文件名里的百分号和井号按字面处理', () => {
    seed(snapshot({ published: ['报告 #%.txt', '数据.csv', '说明.md'].map(item) }))
    render(<TurnGroup turn={{ user, items: [answer] }} sessionId="s1" phase="done" />)
    expect(Array.from(document.querySelectorAll('[data-output-card] [data-file-icon]')).map((icon) => icon.getAttribute('data-file-icon'))).toEqual(['document', 'table', 'markdown'])
  })
})
