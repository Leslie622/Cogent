/**
 * 消息流（AI Elements「Chat」pattern 的 Cogent 版）：
 * MessageScroller（流式自动跟随滚动）+ Empty（官方空态）+ Message（消息轮次）。
 * 数据源：chat store（引擎事件流驱动）；助手消息 = 正文流不进气泡（官方 Message pattern）。
 */
import { Message, MessageContent } from '@/components/ui/message'
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
import { CircleAlert, MessageSquare, TriangleAlert } from 'lucide-react'
import { useChatStore } from '@/stores/chat'
import type { ChatMessage } from '@/env.d'

/**
 * 空列表的稳定引用：zustand v5 经 useSyncExternalStore 对接 React，selector 在
 * 快照比对时要求"状态未变则返回同引用"——写成 `?? []` 每次生成新数组字面量，
 * React 判定快照永远在变 → 无限重渲染（Maximum update depth exceeded）。
 */
const EMPTY_MESSAGES: ChatMessage[] = []

export function MessageList() {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const messages = useChatStore((s) =>
    activeSessionId ? (s.messagesBySession[activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const lastError = useChatStore((s) => s.lastError)
  const truncated = useChatStore((s) => s.truncated)

  if (messages.length === 0 && !lastError) {
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
            {messages.map((m) => (
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
                    </MessageContent>
                  </Message>
                )}
              </MessageScrollerItem>
            ))}
            {truncated && (
              <div className="flex items-center gap-2 rounded-md border border-muted bg-muted/40 p-3 text-xs text-muted-foreground">
                <CircleAlert size={14} className="shrink-0" />
                <span>回复因达到输出长度上限被截断（模型 maxTokens 或端点侧限制）。可继续对话让它接着说，或换用输出上限更高的模型。</span>
              </div>
            )}
            {lastError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                <span className="whitespace-pre-wrap">{lastError}</span>
              </div>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* 回到底部按钮（scroller 自动按需显示） */}
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
