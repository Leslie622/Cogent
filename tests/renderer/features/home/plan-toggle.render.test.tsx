/** 计划状态与关闭动作分离；真实 store 验证新聊天暂存及已有会话的 IPC 回流。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/env.d'
import { PlanToggle } from '@/features/home/PlanToggle'
import { useChatStore } from '@/stores/chat'
import { useHomeStore, type HomeSession } from '@/stores/home'

const SID = 's-plan-toggle'
const summary = (planEnabled: boolean): SessionSummary => ({
  id: SID,
  title: '计划开关测试会话',
  createdAt: 0,
  updatedAt: 0,
  permissionMode: 'auto',
  planEnabled
})
const initialChat = useChatStore.getState()
const initialHome = useHomeStore.getState()
const engineRequest = vi.fn()

beforeEach(() => {
  engineRequest.mockReset()
  engineRequest.mockResolvedValue({ summary: summary(false) })
  window.cogent = { engineRequest } as unknown as typeof window.cogent
})

afterEach(() => {
  useChatStore.setState(initialChat, true)
  useHomeStore.setState(initialHome, true)
})

function mount(kind: HomeSession['kind'], planEnabled = true) {
  const session: HomeSession = kind === 'new'
    ? { kind: 'new', draftId: 'plan-draft', permissionMode: 'auto', planEnabled }
    : { kind: 'chat', chatId: SID }
  useHomeStore.setState({ session })
  useChatStore.setState({ activeSessionId: SID, sessions: [summary(planEnabled)] })
  return render(<PlanToggle session={session} />)
}

describe('计划状态的关闭命中范围', () => {
  it.each(['new', 'chat'] as const)('%s：点击文字、计划图标或主体空白不关闭', async (kind) => {
    mount(kind)
    const label = screen.getByText('计划')
    const chip = label.parentElement!
    fireEvent.click(label)
    fireEvent.click(chip.querySelector('svg')!)
    fireEvent.click(chip)

    await waitFor(() => expect(screen.getByText('计划')).toBeInTheDocument())
    expect(engineRequest).not.toHaveBeenCalled()
    expect(useHomeStore.getState().session).toMatchObject(
      kind === 'new' ? { planEnabled: true } : { kind: 'chat' }
    )
    expect(useChatStore.getState().sessions[0]).toMatchObject({ planEnabled: true })
  })

  it('新聊天：悬停后点击独立关闭钮只更新暂存位，保留权限档', async () => {
    const user = userEvent.setup()
    mount('new')
    await user.hover(screen.getByText('计划'))
    await user.click(screen.getByRole('button', { name: '关闭计划模式' }))

    expect(screen.queryByText('计划')).not.toBeInTheDocument()
    expect(useHomeStore.getState().session).toMatchObject({ planEnabled: false, permissionMode: 'auto' })
    expect(engineRequest).not.toHaveBeenCalled()
  })

  it('已有会话：独立关闭钮发出一次关闭请求，摘要回流后整组消失', async () => {
    const user = userEvent.setup()
    const { container } = mount('chat')
    await user.hover(screen.getByText('计划'))
    await user.click(screen.getByRole('button', { name: '关闭计划模式' }))

    expect(engineRequest).toHaveBeenCalledExactlyOnceWith('session.setPlanMode', {
      sessionId: SID,
      enabled: false
    })
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(useChatStore.getState().sessions[0]).toMatchObject({ planEnabled: false, permissionMode: 'auto' })
  })

  it.each(['{Enter}', ' '])('Tab 直接聚焦独立关闭钮，%s 可关闭', async (key) => {
    const user = userEvent.setup()
    mount('new')
    await user.tab()
    expect(screen.getByRole('button', { name: '关闭计划模式' })).toHaveFocus()
    await user.keyboard(key)

    expect(screen.queryByText('计划')).not.toBeInTheDocument()
    expect(useHomeStore.getState().session).toMatchObject({ planEnabled: false })
  })

  it.each(['new', 'chat'] as const)('%s：计划未开启时不渲染分隔线和关闭钮', (kind) => {
    const { container } = mount(kind, false)
    expect(container).toBeEmptyDOMElement()
  })
})
