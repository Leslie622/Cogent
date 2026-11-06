/**
 * 左栏：会话列表 + 底部用户区/设置入口。
 * 会话数据为 mock（见 mock.ts），storage 落地后接引擎。
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
import { Settings, SquarePen } from 'lucide-react'
import { mockSessions } from './mock'
import { useUiStore } from '@/stores/ui'

export function ChatSidebar({ className }: { className?: string }) {
  const setView = useUiStore((s) => s.setView)

  return (
    // className 透传给官方 Sidebar 的 fixed 容器（父组件用它收进 TitleBar 以下的区域）
    <Sidebar className={className}>
      <SidebarHeader className="p-2">
        {/* 新建会话：等 agent.submit + storage 后接行为 */}
        <Button variant="outline" className="justify-start gap-2">
          <SquarePen size={16} />
          新建会话
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>会话列表</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mockSessions.map((s) => (
                <SidebarMenuItem key={s.id}>
                  <SidebarMenuButton>
                    <span className="truncate">{s.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{s.time}</span>
                  </SidebarMenuButton>
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
