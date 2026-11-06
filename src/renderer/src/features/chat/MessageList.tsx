/**
 * 消息流（AI Elements「Chat」pattern 的 Cogent 版）：
 * MessageScroller（流式自动跟随滚动）+ Empty（官方空态）+ Message（消息轮次）。
 * 官方 Message pattern 的角色分支：用户 = muted 气泡（Bubble），助手 = 纯文本直接渲染
 * （Agent 回复不进气泡；将来 pi 接入后用 Markdown/Streamdown 渲染并加 MessageFooter）。
 */
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { MessageSquare } from 'lucide-react'
import { mockMessages } from './mock'

export function MessageList() {
  if (mockMessages.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia>
            <MessageSquare />
          </EmptyMedia>
          <EmptyTitle>开始新的会话</EmptyTitle>
          <EmptyDescription>向 Agent 提问，或让它帮你完成任务。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto max-w-3xl px-4 py-4">
            {mockMessages.map((m) => (
              <MessageScrollerItem key={m.id} scrollAnchor={m.role === 'user'}>
                {/* 官方 pattern 的角色分支：只有用户消息是气泡，助手回复是正文流 */}
                {m.role === 'user' ? (
                  <Message align="end">
                    <MessageContent>
                      <Bubble align="end" variant="muted">
                        <BubbleContent>{m.content}</BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                ) : (
                  <Message>
                    <MessageContent className="gap-2">
                      {/* TODO(pi 事件流): 换成 Markdown(Streamdown) 渲染，支持流式 + 代码块 */}
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.content}</p>
                      <MessageFooter className="px-0">{/* 复制/重试：pi 接入后启用 */}</MessageFooter>
                    </MessageContent>
                  </Message>
                )}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* 回到底部按钮（scroller 自动按需显示） */}
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
