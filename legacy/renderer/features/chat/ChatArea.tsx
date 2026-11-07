/**
 * 中栏（v0 稿）：无顶栏 —— 折叠开关与文档栏开关做成悬浮在滚动区上的圆角图标按钮，
 * 下方依次是消息流 + 输入框。原顶栏的会话标题随稿移除（空状态大标题已足够标识）。
 */
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { PanelRight } from 'lucide-react'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { useUiStore } from '@/stores/ui'

export function ChatArea() {
  const docPanelOpen = useUiStore((s) => s.docPanelOpen)
  const setDocPanelOpen = useUiStore((s) => s.setDocPanelOpen)

  return (
    <div className="relative flex h-full flex-col">
      {/* 悬浮按钮组：压在消息流上方（z-10）；MessageList 内容区的 pt-16 为其留位 */}
      <div className="absolute left-3 top-3 z-10">
        <SidebarTrigger className="size-9 rounded-lg text-muted-foreground" />
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-3 top-3 z-10 size-9 rounded-lg text-muted-foreground"
        onClick={() => setDocPanelOpen(!docPanelOpen)}
        aria-label="切换文档栏"
      >
        <PanelRight size={18} />
      </Button>

      <MessageList />
      <ChatInput />
    </div>
  )
}
