/**
 * 中栏：顶栏（标题 + 文档栏开关）+ 消息流 + 底部输入框。
 * 标题跟随 active session（引擎侧由首条消息自动生成）。
 */
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { PanelRight } from 'lucide-react'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'

export function ChatArea() {
  const docPanelOpen = useUiStore((s) => s.docPanelOpen)
  const setDocPanelOpen = useUiStore((s) => s.setDocPanelOpen)
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeTitle = sessions.find((s) => s.id === activeSessionId)?.title ?? '新会话'

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：左折叠按钮 + 标题；右文档栏开关 */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-4" />
        <span className="text-sm font-medium">{activeTitle}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          onClick={() => setDocPanelOpen(!docPanelOpen)}
          aria-label="切换文档栏"
        >
          <PanelRight size={16} />
        </Button>
      </header>

      <MessageList />
      <ChatInput />
    </div>
  )
}
