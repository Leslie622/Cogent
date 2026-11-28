/** 应用外壳：header/app-sidebar与可折叠content-sidebar。
 * WorkspaceFrame拥有工作区寿命与对话留位，面板portal到静止主卡，避开侧栏动画的绘制原点变化。
 * 左侧像素分栏使用useContentSidebarSplit；右侧工作区按像素留位/手动占满，
 * 切路由或宽窄布局均保留同一网页内容父节点。详见docs/UI布局.md。
 * 分栏宽度经 shell-panes.ts 内联写给各消费端（会话侧栏在这里随开合状态写，工作区由 WorkspaceFrame
 * 写）：裁剪窗、面板、对话留位与应用头部的区块各写自己的 width / padding，同一条过渡、同帧起止，
 * 因此对齐不靠 JS 逐帧镜像宽度。
 */
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SessionSearch } from '@/features/home/search/SessionSearch'
import { AppHeader } from '@/features/shell/AppHeader'
import { AppSidebar } from '@/features/shell/AppSidebar'
import { SIDEBAR_PANE, writeShellPane } from '@/features/shell/shell-panes'
import { HomeSidebar } from '@/features/home/HomeSidebar'
import { HomeMain } from '@/features/home/HomeMain'
import { SidebarResizeHandle } from '@/components/SidebarResizeHandle'

const SettingsSidebar = lazy(() =>
  import('@/features/settings/SettingsSidebar').then((m) => ({ default: m.SettingsSidebar }))
)
const SettingsMain = lazy(() =>
  import('@/features/settings/SettingsMain').then((m) => ({ default: m.SettingsMain }))
)
import {
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useContentSidebarSplit,
} from '@/hooks/use-content-sidebar-split'
import { useUiStore, VIEW_LABELS } from '@/stores/ui'
import { useWindowMediaQuery } from '@/hooks/use-window-media-query'
import { WorkspaceFrame } from '@/features/workspace/WorkspaceFrame'

export function AppShell() {
  // 应用头部标签页区块的裁剪窗（工作区 portal 标签头的落点）
  const tabsHeader = useRef<HTMLDivElement>(null)
  // 面板常驻在位置不随侧栏开合变化的主卡上；回调 ref 就绪后才挂载，查看器只拥有一个父树。
  const [workspaceHost, setWorkspaceHost] = useState<HTMLElement | null>(null)
  // content-sidebar 分栏：像素宽状态机 + localStorage 记忆，机制全在 hook；
  // 此处只接线（拖拽直写/提交、折叠开关）
  const sidebar = useContentSidebarSplit()
  const view = useUiStore((s) => s.view)
  const sidebarAutoCollapsed = useWindowMediaQuery('(max-width: 760px)')
  // 自动约束只叠加在呈现层，不能回写用户的手动开合与宽度记忆。
  const sidebarCollapsed = sidebarAutoCollapsed || sidebar.collapsed
  // 开合（含断点自动收起）：状态提交后把宽度写给裁剪窗与应用头部左块，提交当帧两者起同一条过渡
  useLayoutEffect(() => { writeShellPane(SIDEBAR_PANE, sidebarCollapsed ? 0 : sidebar.widthPx) }, [sidebarCollapsed, sidebar.widthPx])
  // 侧栏内容与路由内容只随路由（设置页另加折叠态）变：外壳因侧栏开合、宽度记忆重渲染时，这两棵
  // 树拿到的是同一条元素引用，React 直接跳过，不再从外壳这一侧把整棵对话树协调一遍。
  const sidebarContent = useMemo(() => view === 'home' ? (
    <HomeSidebar />
  ) : view === 'settings' ? (
    <Suspense fallback={null}>
      <SettingsSidebar />
    </Suspense>
  ) : (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      {VIEW_LABELS[view]}
    </div>
  ), [view])
  const settingsSidebarCollapsed = view === 'settings' && sidebarCollapsed
  const route = useMemo(() => view === 'home' ? (
    <HomeMain />
  ) : view === 'settings' ? (
    <Suspense fallback={null}>
      <SettingsMain sidebarCollapsed={settingsSidebarCollapsed} />
    </Suspense>
  ) : (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {VIEW_LABELS[view]}
    </div>
  ), [view, settingsSidebarCollapsed])

  return (
    <div className="shell-panes chrome-surface flex h-dvh flex-col text-sidebar-foreground">
      <SessionSearch />
      <AppHeader view={view} sidebarCollapsed={sidebarCollapsed} sidebarToggleDisabled={sidebarAutoCollapsed} onToggleSidebar={sidebar.toggle} tabsHeaderRef={tabsHeader} />
      <div className="flex min-h-0 flex-1">
        {/* 应用侧栏：上/下两组路由钮（chrome 底色与 header 融合） */}
        <AppSidebar />
        {/* 内容侧栏以轻雾面叠在同一张外壳渐变上，区分面层且保留自然散色。
            顶边与左描边沿圆角给玻璃高光边；overflow-hidden 保留内容区整体的圆角裁剪。 */}
        <main ref={setWorkspaceHost} data-workspace-host className="relative min-w-0 flex-1 overflow-hidden rounded-tl-(--shell-radius) border-t border-l border-(--shell-main-border) shadow-(--shell-main-shadow)">
          <div className="flex h-full">
            {/* 裁剪窗：宽度承载折叠/展开过渡（内联写入，150ms；拖拽期间由根节点关闭，逐帧直写才跟手）。
                折叠时内容层保宽被裁（滑出/滑入），不逐帧换行；contain 限制裁剪重绘范围，
                减轻 Windows Acrylic + CPU 栅格化下的掉帧。 */}
            <div
              ref={sidebar.clipRef}
              data-sidebar-clip
              data-shell-pane={SIDEBAR_PANE}
              inert={sidebarCollapsed}
              className="shell-pane-sidebar h-full shrink-0 overflow-hidden bg-(--content-sidebar-overlay) [contain:layout_paint]"
            >
              {/* 内容层：固定像素宽（min-w-60 = 下限 240px 兜底）。content-sidebar
                  内容随 AppView 换：首页（件 4）与设置（件 6）已落地，其余视图
                  侧栏属后续件 */}
              {/* 固定尺寸内容常驻合成层，裁剪窗只改变可见范围，保持静止图标像素稳定。 */}
              <div ref={sidebar.contentRef} className="h-full min-w-60 transform-gpu" style={{ width: sidebar.widthPx }}>
                {sidebarContent}
              </div>
            </div>
            {/* 自绘拖拽条：折叠态收至 w-0 透明隐藏视觉线，避免紧贴 <main> 圆角左缘形成双线缝隙，
                仍保留 after 隐形命中区供拖出/双击恢复。 */}
            {!sidebarAutoCollapsed && <SidebarResizeHandle
              className={sidebarCollapsed ? 'w-0 bg-transparent' : 'bg-foreground/[0.07]'}
              withHandle={view !== 'home' && !sidebarCollapsed}
              min={SIDEBAR_WIDTH_MIN}
              max={SIDEBAR_WIDTH_MAX}
              readWidth={sidebar.readWidth}
              writeWidth={sidebar.writeWidth}
              onCommit={sidebar.commit}
              onReset={sidebar.reset}
            />}
            {/* content-main：flex-1 吃剩余宽度；Frame量这块可用尺寸，路由内容留在这里，
                工作区面板则始终挂在静止main上，侧栏开合不搬动查看器父树。 */}
            <div data-content-main className="min-w-0 flex-1 bg-(--app-canvas) [contain:layout_style]">
              <WorkspaceFrame visible={view === 'home'} autoCollapsed={sidebarAutoCollapsed} tabsHeader={tabsHeader} workspaceHost={workspaceHost}>
                {route}
              </WorkspaceFrame>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
