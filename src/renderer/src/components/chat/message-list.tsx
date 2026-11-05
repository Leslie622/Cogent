import { useEffect, useRef } from 'react'
import { Loader2, Wrench } from 'lucide-react'
import type { ChatItem, MessageItem, ToolItem } from '@/hooks/use-agent'

export function MessageList({ items }: { items: ChatItem[] }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [items])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        {items.map((item) =>
          item.kind === 'message' ? <MessageBubble key={item.key} message={item} /> : <ToolCard key={item.key} tool={item} />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: MessageItem }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground">
          {message.text}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {message.thinking && (
        <details className="rounded-lg border bg-card/50 px-3 py-2">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">思考过程</summary>
          <div className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{message.thinking}</div>
        </details>
      )}
      {message.text && (
        <div className="whitespace-pre-wrap text-sm leading-7">
          {message.text}
          {message.streaming && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground align-text-bottom" />}
        </div>
      )}
      {message.errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {message.errorMessage}
        </div>
      )}
    </div>
  )
}

function ToolCard({ tool }: { tool: ToolItem }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5">
      <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{tool.name}</span>
          {tool.status === 'running' ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <span className="text-xs text-muted-foreground">完成</span>
          )}
        </div>
        {tool.summary && <p className="mt-1 truncate text-xs leading-5 text-muted-foreground">{tool.summary}</p>}
      </div>
    </div>
  )
}
