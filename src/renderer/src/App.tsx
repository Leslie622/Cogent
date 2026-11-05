import { Composer } from '@/components/chat/composer'
import { MessageList } from '@/components/chat/message-list'
import { useAgent } from '@/hooks/use-agent'

export default function App() {
  const { items, status, running, error, send, abort } = useAgent()
  const configured = status?.configured ?? false

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2.5">
          <span className="size-2.5 rounded-full bg-primary" />
          <span className="text-sm font-semibold tracking-wide">Cogent</span>
        </div>
        <span className="truncate text-xs text-muted-foreground" title={status?.modelId ?? undefined}>
          {status ? (configured ? (status.modelLabel ?? status.modelId) : '未配置 API Key') : '…'}
        </span>
      </header>

      {items.length === 0 ? <EmptyState configured={configured} /> : <MessageList items={items} />}

      {error && (
        <div className="mx-auto w-full max-w-3xl px-4 pb-2">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        </div>
      )}

      <Composer
        disabled={!configured}
        running={running}
        onSend={(text) => {
          void send(text)
        }}
        onAbort={abort}
      />
    </div>
  )
}

function EmptyState({ configured }: { configured: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border bg-card">
        <span className="size-3.5 rounded-full bg-primary" />
      </div>
      <h1 className="text-lg font-semibold">Cogent</h1>
      <p className="max-w-sm text-sm leading-6 text-muted-foreground">
        基于 Electron + pi 的 Agent 应用。
        {configured
          ? '发送一条消息开始对话。'
          : '启动前请设置 ANTHROPIC_API_KEY / OPENAI_API_KEY / ZAI_API_KEY 之一，然后重启应用。'}
      </p>
    </div>
  )
}
