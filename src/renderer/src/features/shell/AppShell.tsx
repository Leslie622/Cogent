/**
 * 应用骨架（UI 件 1 改版，只搭块不填内容）。区域代号（AGENTS.md「区域代号」，
 * 描述/注释/命名统一用它）：
 *
 *   shell ─┬─ header            头部：40px 拖拽区，chrome 底色
 *          └─ body              主体
 *             ├─ app-sidebar    应用侧边栏：固定 50px 图标栏，与 header 融合
 *             └─ content        内容区白卡（左上圆角 --shell-radius + border-l
 *                ├─ content-sidebar  240–360px 可拖可折叠（折成 0），微灰底。
 *                │                 普通 flex 像素宽块（不进 RRP，方案同 Themd）：
 *                │                 窗口缩放零 JS 参与，宽 + 折叠态 localStorage
 *                │                 记忆（use-content-sidebar-split）
 *                └─ content-main     纯白主体（flex-1 吃掉窗口缩放的全部增量）
 *
 * chrome 底色（bg-sidebar）铺最外层 —— header 与 app-sidebar 同色融合成 L 形；
 * content 白卡浮在 chrome 上（border-l 贴弧自描边 + 紧投影）。
 * content 内部的分栏分两类引擎（2026-11-12 定，详见 docs/UI布局.md）：本层的
 * content-sidebar 是像素语义，普通 flex + 自绘拖拽条（SidebarResizeHandle）+
 * 像素记忆；content-main 内部的分屏（HomeMain 主要区|标签页区）是真百分比
 * 语义，仍走 react-resizable-panels v4 + GlowResizeHandle。
 * header 内容（件 2，AppHeader）：折叠开关/菜单/窗口控制 —— 折叠开关直接用
 * hook 的 toggle（宽度记忆不动，展开回原宽）。
 * app-sidebar 内容（件 3，AppSidebar）是路由钮：切 AppView，content 两个面板
 * 的占位随路由换 —— 真实内容属各视图后续件。
 */
import { AppHeader } from '@/features/shell/AppHeader'
import { AppSidebar } from '@/features/shell/AppSidebar'
import { HomeSidebar } from '@/features/home/HomeSidebar'
import { HomeMain } from '@/features/home/HomeMain'
import { SettingsSidebar } from '@/features/settings/SettingsSidebar'
import { SettingsMain } from '@/features/settings/SettingsMain'
import { SidebarResizeHandle } from '@/components/SidebarResizeHandle'
import {
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useContentSidebarSplit,
} from '@/hooks/use-content-sidebar-split'
import { useUiStore, VIEW_LABELS } from '@/stores/ui'

export function AppShell() {
  // content-sidebar 分栏：像素宽状态机 + localStorage 记忆，机制全在 hook；
  // 此处只接线（拖拽直写/提交、折叠开关）
  const sidebar = useContentSidebarSplit()
  const view = useUiStore((s) => s.view)

  return (
    <div className="chrome-surface flex h-dvh flex-col text-sidebar-foreground">
      <AppHeader sidebarCollapsed={sidebar.collapsed} onToggleSidebar={sidebar.toggle} />
      <div className="flex min-h-0 flex-1">
        {/* 应用侧栏：上/下两组路由钮（chrome 底色与 header 融合） */}
        <AppSidebar />
        {/* 内容区卡：左描边天然贴弧线走（"线跟着圆角走"），投影收窄压实不泛。
            overflow-hidden：内层灰底子面板是方角，不裁会戳进左上弧线区 */}
        <main className="min-w-0 flex-1 overflow-hidden rounded-tl-(--shell-radius) border-l border-border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.07)]">
          {/* 拖拽杀过渡（同 components/ui/resizable.tsx 手法）：把手
              data-separator=active 期间裁剪窗的 width 过渡失效 —— 拖拽逐帧直写，
              200ms 缓动会把跟手拖成延迟 */}
          <div className="flex h-full [&:has([data-separator=active])>[data-sidebar-clip]]:transition-none">
            {/* 裁剪窗：宽度承载折叠/展开过渡（200ms ease-out，RRP 时代同参数）；
                折叠时内容层保宽被裁（滑出/滑入），不逐帧换行 */}
            <div
              ref={sidebar.clipRef}
              data-sidebar-clip
              className="h-full w-0 shrink-0 overflow-hidden bg-content-sidebar transition-[width] duration-200 ease-out"
              style={{ width: sidebar.collapsed ? 0 : sidebar.widthPx }}
            >
              {/* 内容层：固定像素宽（min-w-60 = 下限 240px 兜底）。content-sidebar
                  内容随 AppView 换：首页（件 4）与设置（件 6）已落地，其余视图
                  侧栏属后续件 */}
              <div ref={sidebar.contentRef} className="h-full min-w-60" style={{ width: sidebar.widthPx }}>
                {view === 'home' ? (
                  <HomeSidebar />
                ) : view === 'settings' ? (
                  <SettingsSidebar />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {VIEW_LABELS[view]}
                  </div>
                )}
              </div>
            </div>
            {/* 自绘拖拽条：样式/光带/状态机与 GlowResizeHandle 同构；拖过下限
                折叠成 0、再向外拖恢复、键盘 ±16、双击回默认 */}
            <SidebarResizeHandle
              min={SIDEBAR_WIDTH_MIN}
              max={SIDEBAR_WIDTH_MAX}
              readWidth={sidebar.readWidth}
              writeWidth={sidebar.writeWidth}
              onCommit={sidebar.commit}
              onReset={sidebar.reset}
            />
            {/* content-main：flex-1 吃剩余宽度，窗口缩放增量全在这。
                内容随 AppView 换：首页（HomeMain，件 5 —— 内部再分
                [主要区 | 标签页区]）与设置（SettingsMain，件 6）已落地 */}
            <div className="min-w-0 flex-1">
              {view === 'home' ? (
                <HomeMain />
              ) : view === 'settings' ? (
                <SettingsMain />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {VIEW_LABELS[view]}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
