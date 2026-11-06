/**
 * 左栏：会话列表 + 底部用户区/设置入口。
 * 数据源：chat store（引擎内存会话；storage 落地后无需改动本组件）。
 */
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { Settings, SquarePen, Trash2 } from 'lucide-react'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

/** 时间戳 → 相对时间文案（会话列表右侧） */
function formatRelativeTime(timestamp: number): string {
  const diffMinutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours} 小时前`
  return `${Math.floor(diffHours / 24)} 天前`
}

export function ChatSidebar({ className }: { className?: string }) {
  const setView = useUiStore((s) => s.setView)
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const selectSession = useChatStore((s) => s.selectSession)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSession = useChatStore((s) => s.deleteSession)

  return (
    // className 透传给官方 Sidebar 的 fixed 容器（父组件用它收进 TitleBar 以下的区域）
    <Sidebar className={className}>
      <SidebarHeader className="p-2">
        <Button variant="outline" className="justify-start gap-2" onClick={() => void createSession()}>
          <SquarePen size={16} />
          新建会话
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>会话列表</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {sessions.map((s) => (
                <SidebarMenuItem key={s.id}>
                  {/* 删除按钮不能嵌在 SidebarMenuButton（button 套 button 非法 HTML）：
                      menu 行改成 div 布局，点击区域与删除按钮平级 */}
                  <div className="group/menu-item relative flex items-center">
                    <SidebarMenuButton
                      isActive={s.id === activeSessionId}
                      onClick={() => void selectSession(s.id)}
                      className="min-w-0 flex-1 pr-1"
                    >
                      <span className="truncate">{s.title}</span>
                    </SidebarMenuButton>
                    <span className="ml-1 flex shrink-0 items-center gap-1">
                      <span className="text-xs text-muted-foreground group-hover/menu-item:hidden">
                        {formatRelativeTime(s.updatedAt)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="hidden size-5 group-hover/menu-item:flex"
                        aria-label={`删除会话 ${s.title}`}
                        onClick={() => void deleteSession(s.id)}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </span>
                  </div>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <Separator className="mb-2" />
        <div className="flex items-center gap-2 px-1">
          <Avatar className="size-7">
            <AvatarFallback>G</AvatarFallback>
          </Avatar>
          <span className="text-sm">用户</span>
          <Button variant="ghost" size="icon" className="ml-auto" onClick={() => setView('settings')} aria-label="设置">
            <Settings size={16} />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
