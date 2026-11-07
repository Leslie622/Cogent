/**
 * 聊天页（主页，v0 稿布局）：左会话栏（薄荷绿，可折叠）+ 右侧白色圆角嵌入面板
 * （聊天区 + 可拖拽文档栏）。provider 的 bg-sidebar 是嵌入面板圆角处的底色来源。
 */
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { ChatSidebar } from './ChatSidebar'
import { ChatArea } from './ChatArea'
import { DocPanel } from './DocPanel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useUiStore } from '@/stores/ui'

export function ChatPage() {
  const docPanelOpen = useUiStore((s) => s.docPanelOpen)

  return (
    // 官方 wrapper 自带 min-h-svh（假定占满整个视口）；本应用顶部有自绘 TitleBar，
    // 内容区只有"视口 - 48px"，用 min-h-0 压掉它（h-full 不够，min-height 仍会撑高），
    // 再加 overflow-hidden，否则整页溢出出滚动条。bg-sidebar：TitleBar(h-12) 之下
    // 整片薄荷绿底，右侧白色面板的 rounded-tl 圆角压在它上面形成"嵌入"观感。
    // 侧栏宽 340px（v0 稿）经 --sidebar-width 覆盖默认 16rem。
    <SidebarProvider
      className="h-full min-h-0 overflow-hidden bg-sidebar"
      style={{ '--sidebar-width': '21.25rem' } as React.CSSProperties}
    >
      {/* Sidebar 容器官方是 fixed inset-y-0 h-svh（相对视口）；有自绘 TitleBar 时
          必须收为"header 以下"：top-12（TitleBar 高 48px）+ 高度减 3rem，否则侧栏盖过 header 且底部溢出 */}
      <ChatSidebar className="top-12 h-[calc(100vh-3rem)]" />
      {/* 圆角嵌入面板：圆角 + overflow-hidden 裁掉子元素直角 */}
      <SidebarInset className="h-full min-h-0 overflow-hidden rounded-tl-[18px]">
        {/* 拖拽分栏：聊天区 | 文档栏；文档栏关闭时只渲染聊天区，不保留空面板 */}
        {docPanelOpen ? (
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel defaultSize="65%" minSize="40%">
              <ChatArea />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="35%" minSize="25%">
              <DocPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <ChatArea />
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}
