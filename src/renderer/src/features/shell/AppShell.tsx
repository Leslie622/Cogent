/** 应用外壳：header/app-sidebar与可折叠content-sidebar。
 * content-main由WorkspaceFrame常驻承载工作区，路由内容作为其普通子区域。
 * 左侧像素分栏使用useContentSidebarSplit；右侧工作区按像素留位/手动占满，
 * 切路由或宽窄布局均保留同一网页内容父节点。详见docs/UI布局.md。
 */
import { lazy, Suspense } from 'react'
import { SessionSearch } from '@/features/home/search/SessionSearch'
import { AppHeader } from '@/features/shell/AppHeader'
import { AppSidebar } from '@/features/shell/AppSidebar'
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
  // content-sidebar 分栏：像素宽状态机 + localStorage 记忆，机制全在 hook；
  // 此处只接线（拖拽直写/提交、折叠开关）
  const sidebar = useContentSidebarSplit()
  const view = useUiStore((s) => s.view)
  const sidebarAutoCollapsed = useWindowMediaQuery('(max-width: 760px)')
  // 自动约束只叠加在呈现层，不能回写用户的手动开合与宽度记忆。
  const sidebarCollapsed = sidebarAutoCollapsed || sidebar.collapsed

  return (
    <div className="chrome-surface flex h-dvh flex-col text-sidebar-foreground">
      <SessionSearch />
      <AppHeader sidebarCollapsed={sidebarCollapsed} sidebarToggleDisabled={sidebarAutoCollapsed} onToggleSidebar={sidebar.toggle} />
      <div className="flex min-h-0 flex-1">
        {/* 应用侧栏：上/下两组路由钮（chrome 底色与 header 融合） */}
        <AppSidebar />
        {/* 内容侧栏以轻雾面叠在同一张外壳渐变上，区分面层且保留自然散色。
            顶边与左描边沿圆角给玻璃高光边；overflow-hidden 保留内容区整体的圆角裁剪。 */}
        <main className="min-w-0 flex-1 overflow-hidden rounded-tl-(--shell-radius) border-t border-l border-(--shell-main-border) shadow-(--shell-main-shadow)">
          {/* 拖拽杀过渡（同 components/ui/resizable.tsx 手法）：把手
              data-separator=active 期间裁剪窗的 width 过渡失效 —— 拖拽逐帧直写，
              200ms 缓动会把跟手拖成延迟 */}
          <div className="flex h-full [&:has([data-separator=active])>[data-sidebar-clip]]:transition-none">
            {/* 裁剪窗：宽度承载折叠/展开过渡；折叠时内容层保宽被裁（滑出/滑入），不逐帧换行。
                contain 限制裁剪重绘范围，减轻 Windows Acrylic + CPU 栅格化下的掉帧。 */}
            <div
              ref={sidebar.clipRef}
              data-sidebar-clip
              inert={sidebarCollapsed}
              className="h-full w-0 shrink-0 overflow-hidden bg-(--content-sidebar-overlay) transition-[width] duration-150 ease-out will-change-[width] [contain:layout_paint] motion-reduce:transition-none"
              style={{ width: sidebarCollapsed ? 0 : sidebar.widthPx }}
            >
              {/* 内容层：固定像素宽（min-w-60 = 下限 240px 兜底）。content-sidebar
                  内容随 AppView 换：首页（件 4）与设置（件 6）已落地，其余视图
                  侧栏属后续件 */}
              {/* 固定尺寸内容常驻合成层，裁剪窗只改变可见范围，保持静止图标像素稳定。 */}
              <div ref={sidebar.contentRef} className="h-full min-w-60 transform-gpu" style={{ width: sidebar.widthPx }}>
                {view === 'home' ? (
                  <HomeSidebar />
                ) : view === 'settings' ? (
                  <Suspense fallback={null}>
                    <SettingsSidebar />
                  </Suspense>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {VIEW_LABELS[view]}
                  </div>
                )}
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
            {/* content-main：flex-1 吃剩余宽度，窗口缩放增量全在这。
                内容随 AppView 换：首页（HomeMain，件 5 —— 内部再分
                [主要区 | 标签页区]）与设置（SettingsMain，件 6）已落地 */}
            <div data-content-main className="min-w-0 flex-1 bg-(--app-canvas) [contain:layout_style]">
              <WorkspaceFrame visible={view === 'home'} autoCollapsed={sidebarAutoCollapsed}>
              {view === 'home' ? (
                <HomeMain />
              ) : view === 'settings' ? (
                <Suspense fallback={null}>
                  <SettingsMain sidebarCollapsed={sidebarCollapsed} />
                </Suspense>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {VIEW_LABELS[view]}
                </div>
              )}
              </WorkspaceFrame>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
