/**
 * 左栏（v0 稿落地）：产品名头 + 新建聊天 + 「最近使用」会话列表 + 底部设置入口。
 * 数据源：chat store（引擎内存会话；storage 落地后无需改动本组件）。
 * v0 稿里的 定时任务/插件/项目分区 无数据支撑，未引入（接引擎能力后再加）。
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
import { ChevronDown, PencilLine, Search, Settings, Trash2 } from 'lucide-react'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

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
      {/* 产品名头：工作区下拉/搜索属路线空位，按稿占位视觉（搜索无实现，先无 onClick） */}
      <SidebarHeader className="px-5 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-sidebar-foreground">
            Cogent <ChevronDown className="size-4 text-muted-foreground" />
          </span>
          <Button variant="ghost" size="icon" className="size-8 rounded-md text-muted-foreground" aria-label="搜索会话">
            <Search size={16} />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3">
        {/* 新建聊天：v0 稿的导航项样式（h-10 大触摸区 + 16px 文字） */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-10 gap-3 px-2.5 text-base"
              onClick={() => void createSession()}
            >
              <PencilLine className="size-[19px] text-muted-foreground" />
              新建聊天
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarGroup className="mt-7">
          <SidebarGroupLabel className="px-2 text-base font-medium text-muted-foreground">
            最近使用
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {sessions.length === 0 ? (
                <p className="mt-2 px-2.5 text-base text-muted-foreground/55">暂无聊天</p>
              ) : (
                sessions.map((s) => (
                  <SidebarMenuItem key={s.id}>
                    {/* 删除按钮不能嵌在 SidebarMenuButton（button 套 button 非法 HTML）：
                        menu 行改成 div 布局，删除按钮 absolute 悬浮在行尾、hover 才出现 */}
                    <div className="group/menu-item relative flex items-center">
                      <SidebarMenuButton
                        isActive={s.id === activeSessionId}
                        onClick={() => void selectSession(s.id)}
                        className="h-10 min-w-0 flex-1 px-2.5 pr-9 text-base data-active:bg-sidebar-accent/75"
                      >
                        <span className="truncate">{s.title}</span>
                      </SidebarMenuButton>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 hidden size-7 text-muted-foreground group-hover/menu-item:flex"
                        aria-label={`删除会话 ${s.title}`}
                        onClick={() => void deleteSession(s.id)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* 底部：设置入口（真实跳转），v0 稿的 border-t 弱分隔 */}
      <SidebarFooter className="border-t border-sidebar-border/50 p-3">
        <SidebarMenuButton
          className="h-10 gap-3 px-2.5 text-base text-muted-foreground hover:text-sidebar-foreground"
          onClick={() => setView('settings')}
        >
          <Settings className="size-[19px]" />
          设置
        </SidebarMenuButton>
      </SidebarFooter>
    </Sidebar>
  )
}
