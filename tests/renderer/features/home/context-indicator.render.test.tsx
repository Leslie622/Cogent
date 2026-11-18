/** 上下文触发入口的可访问用量标签与详情保持同源。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextIndicator } from '@/features/home/ContextIndicator'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { useEngineStore } from '@/stores/engine'

const initialChat = useChatStore.getState()
const initialEngine = useEngineStore.getState()
const session = { kind: 'chat' as const, chatId: 'context-usage' }

beforeEach(() => {
  useEngineStore.setState({ models: [{ id: 'model', name: '模型', provider: 'deepseek', reasoning: false, thinkingLevels: ['off'], contextWindow: 128_000, maxTokens: 8192 }], keyConfigured: { deepseek: true }, activeModelId: 'model', activeProviderId: 'deepseek' })
  useChatStore.setState({ activeSessionId: session.chatId, bySession: { [session.chatId]: {
    ...emptyBucket(), messages: [{ id: 'answer', role: 'assistant', timestamp: 0, content: '回答', usage: { input: 39_000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 40_000 } }],
  } } })
})

afterEach(() => {
  useChatStore.setState(initialChat, true)
  useEngineStore.setState(initialEngine, true)
})

describe('上下文用量入口', () => {
  it('显示末轮占用比例，点击仍打开原用量详情', async () => {
    const { container } = render(<ContextIndicator session={session} />)
    expect(container.querySelector('.context-ring circle[pathLength]')).toHaveAttribute('stroke-dashoffset', '68.75')
    fireEvent.click(screen.getByRole('button', { name: '上下文窗口用量：31.25%' }))
    await waitFor(() => expect(screen.getByText('上下文容量')).toBeVisible())
    expect(screen.getByText(/40K\/128K/)).toBeVisible()
    expect(screen.queryByText(/自动压缩上下文/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '立即压缩上下文' })).not.toBeInTheDocument()
  })

  it('超过容量时用量比例止于100%', () => {
    useChatStore.setState((state) => ({ bySession: { ...state.bySession, [session.chatId]: {
      ...state.bySession[session.chatId]!, runtime: { ...emptyBucket().runtime, contextLive: { input: 160_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 160_000 } },
    } } }))
    render(<ContextIndicator session={session} />)
    expect(screen.getByRole('button', { name: '上下文窗口用量：100.00%' })).toBeInTheDocument()
  })
})
