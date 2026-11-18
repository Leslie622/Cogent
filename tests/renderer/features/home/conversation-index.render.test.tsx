/** 索引悬浮预览：问题常显，回答只消费父层已确认完成的摘要，点击定位不变。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationIndex, conversationPreviewText } from '@/features/home/ConversationIndex'

const { scrollToMessage } = vi.hoisted(() => ({ scrollToMessage: vi.fn() }))
vi.mock('@/components/ui/message-scroller', () => ({ useMessageScroller: () => ({ scrollToMessage }) }))
const messages = [{ id: 'u1', role: 'user' as const, content: '你是谁', timestamp: 0 }]

describe('对话索引预览', () => {
  it('悬停显示问题和已完成回答，点击仍定位同一用户消息', async () => {
    render(<ConversationIndex messages={messages} answers={new Map([['u1', '我是 **Cogent**，可以帮助你处理工作区。']])} />)
    const trigger = screen.getByRole('button', { name: '定位消息：你是谁' })
    await userEvent.hover(trigger)
    await waitFor(() => expect(screen.getByText('我是 Cogent，可以帮助你处理工作区。')).toBeVisible())
    expect(screen.getByText('你是谁')).toBeVisible()
    fireEvent.click(trigger)
    expect(scrollToMessage).toHaveBeenCalledWith('u1', { align: 'center', behavior: 'smooth' })
  })

  it('未完成时只显示问题，完成后同一浮窗才出现回答摘要', async () => {
    const view = render(<ConversationIndex messages={messages} />)
    await userEvent.hover(screen.getByRole('button', { name: '定位消息：你是谁' }))
    await waitFor(() => expect(screen.getByText('你是谁')).toBeVisible())
    expect(screen.queryByText('已经完成的回答')).not.toBeInTheDocument()
    view.rerender(<ConversationIndex messages={messages} answers={new Map([['u1', '已经完成的回答']])} />)
    expect(screen.getByText('已经完成的回答')).toBeVisible()
  })

  it('摘要保留链接文字、压平空白，不显示图片地址和代码围栏', () => {
    expect(conversationPreviewText('## 回答\n\n这是 [文档](https://example.com) ![图](secret.png)\n```ts\nsecret()\n```')).toBe('回答 这是 文档')
  })
})
