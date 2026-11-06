/**
 * 聊天页（主页）：三栏布局 —— 左会话栏（shadcn Sidebar，可折叠）
 * + 中聊天区 + 右文档栏（Resizable 可拖拽，可关闭）。
 * 布局架子先行，各栏内部见子组件。
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
    // 内容区只有"视口 - 32px"，用 min-h-0 压掉它（h-full 不够，min-height 仍会撑高），
    // 再加 overflow-hidden，否则整页溢出出滚动条。
    <SidebarProvider className="h-full min-h-0 overflow-hidden">
      {/* Sidebar 容器官方是 fixed inset-y-0 h-svh（相对视口）；有自绘 TitleBar 时
          必须收为"header 以下"：top-8（TitleBar 高）+ 高度减 32px，否则侧栏盖过 header 且底部溢出 */}
      <ChatSidebar className="top-8 h-[calc(100vh-2rem)]" />
      <SidebarInset className="h-full min-h-0 overflow-hidden">
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
