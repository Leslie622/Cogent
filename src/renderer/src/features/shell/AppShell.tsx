/**
 * 应用骨架（UI 件 1 改版，只搭块不填内容）。区域代号（AGENTS.md「区域代号」，
 * 描述/注释/命名统一用它）：
 *
 *   shell ─┬─ header            头部：40px 拖拽区，chrome 底色
 *          └─ body              主体
 *             ├─ app-sidebar    应用侧边栏：固定 50px 图标栏，与 header 融合
 *             └─ content        内容区白卡（左上圆角 --shell-radius + border-l
 *                ├─ content-sidebar  240–360px 可拖可折叠（折成 0），微灰底
 *                └─ content-main     纯白主体
 *
 * chrome 底色（bg-sidebar）铺最外层 —— header 与 app-sidebar 同色融合成 L 形；
 * content 白卡浮在 chrome 上（border-l 贴弧自描边 + 紧投影）。可拖分栏只在
 * content 内部（react-resizable-panels v4）：content-sidebar 拖过下限即折叠成
 * 0（折叠后把手贴卡片左缘，即展开抓取点）；分屏线用 shadcn 默认形态（1px 线 +
 * withHandle 把手）+ 拖拽光带（GlowResizeHandle）——分栏顶端不挨圆角弧线，
 * 光带无需旧布局的顶部蒙版。
 * header 内容（件 2，AppHeader）：折叠开关/菜单/窗口控制；折叠状态在此处从面板
 * onResize 同步（拖拽折叠与点钮折叠同源），经 props 下去。
 * app-sidebar 内容（件 3，AppSidebar）是路由钮：切 AppView，content 两个面板
 * 的占位随路由换 —— 真实内容属各视图后续件。
 */
import { useState } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { GlowResizeHandle } from '@/components/GlowResizeHandle'
import { AppHeader } from '@/features/shell/AppHeader'
import { AppSidebar } from '@/features/shell/AppSidebar'
import { useUiStore, VIEW_LABELS } from '@/stores/ui'

export function AppShell() {
  const sidebarPanel = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const view = useUiStore((s) => s.view)

  // 折叠开关：命令走面板 imperative API；状态走 onResize —— 拖拽折叠/点钮折叠
  // 都会触发 onResize，图标不会跟面板实际状态脱节
  const toggleSidebar = () => {
    const panel = sidebarPanel.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }

  return (
    <div className="flex h-dvh flex-col bg-sidebar text-sidebar-foreground">
      <AppHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      <div className="flex min-h-0 flex-1">
        {/* 应用侧栏：上/下两组路由钮（chrome 底色与 header 融合） */}
        <AppSidebar />
        {/* 内容区卡：左描边天然贴弧线走（"线跟着圆角走"），投影收窄压实不泛。
            overflow-hidden：内层灰底子面板是方角，不裁会戳进左上弧线区 */}
        <main className="min-w-0 flex-1 overflow-hidden rounded-tl-(--shell-radius) border-l border-border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.07)]">
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            {/* 内容侧栏：240–360px 夹死，拖过下限折叠成 0、再向外拖恢复；
                微灰底与纯白主体分界。v4 Panel 两层，className 落内层内容节点。
                panelRef/onResize 供 header 折叠开关（见上 toggleSidebar） */}
            <ResizablePanel
              panelRef={sidebarPanel}
              onResize={(size) => setSidebarCollapsed(size.inPixels === 0)}
              collapsible
              collapsedSize={0}
              minSize="240px"
              maxSize="360px"
              defaultSize="300px"
              className="bg-muted/50"
            >
              {/* content-sidebar 内容空位：随 AppView 换，各视图侧栏属后续件 */}
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground/70">
                {VIEW_LABELS[view]}
              </div>
            </ResizablePanel>
            {/* shadcn 默认形态：1px 线 + 中点把手；拖拽光带见 GlowResizeHandle */}
            <GlowResizeHandle withHandle />
            <ResizablePanel>
              {/* content-main 内容空位：随 AppView 换，各视图主体属后续件 */}
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {VIEW_LABELS[view]}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </main>
      </div>
    </div>
  )
}

