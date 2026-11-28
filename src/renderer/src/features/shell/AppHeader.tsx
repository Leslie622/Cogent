/**
 * header 区（区域代号见 AGENTS.md「区域代号」）：frameless 窗口拖拽区，单行 48px、三个区块。
 * 各区块的宽度与下方各列的边缘严格对齐（globals.css「应用头部的三个区块」），不靠 JS 镜像宽度：
 * 开合与拖拽经 shell-panes.ts 把分栏宽内联写给区块与列身（左块、右块写 width；中块的让位公式带
 * max()，读它自己持有的变量），同一条过渡、同帧起止。左块与右块是分栏宽的消费端（data-shell-pane）。
 * 左块：图标栏 50px + 会话侧栏宽。折叠开关位置不变；文件、编辑、视图、
 *     帮助四个文字菜单（shadcn ghost）在会话侧栏那一段，随侧栏宽度被裁。左块窄到放不下两枚文字菜单
 *     时（容器查询，看块的实际宽度）整段换成应用菜单钮，收起后停在「折叠钮 + 应用菜单钮」的宽度
 *     —— 随侧栏开合而不是窗口断点（760px 断点下侧栏本就自动收起）。
 * 中块：对话头（ChatHeader，原在 HomeChat 顶部）；工作区占满时 inert、被右块挤到 0 宽。
 * 右块：工作区宽（含左边线 1px）。内层裁剪窗由 WorkspaceSurface 把标签头
 *     portal 进来，开合与下方工作区面板同步；收起动画期间 inert。
 * 两道分界线（左块尾、右块首）同一样式：块缘 16px 短竖线、前景色 7%（HEADER_DIVIDER，
 *     2026-11-29 用户要求统一 —— 右块原是通高的 border 线）。
 * 窗口控制三钮（IPC 直达 main；maximize 两态系列图标 Square↔Copy，状态经 window:state-changed
 *     推送；关闭 hover 保留 Windows 红色惯例）绝对定位钉在行右端，不随任何区块开合移动；
 *     槽位 = 右内距 8 + 三钮 3×28 + 间距 2×6，中块与右块内层各按公式让位（见 CSS）。
 * hover 底色压成外壳柔光：chrome 面上的按钮，ghost 默认的 bg-accent(0.97) 与 chrome 底(0.968)
 * 几乎同色，hover 会看不见。可交互的控件都标 no-drag（chrome.ts）；左端 pl-2 与右端 pr-2
 * 对称：折叠钮距左缘 = 关闭钮距右缘。
 * 图标：Tabler（尺寸：折叠开关 19px 与侧栏同基准，窗口控制 —/× 16px、方框 14px）。
 */
import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import {
  IconCopy,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMinus,
  IconMenu2,
  IconSquare,
  IconX,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useHoverSlide } from '@/hooks/use-hover-slide'
import { ChatHeader } from '@/features/home/ChatHeader'
import { EMPTY_WORKSPACE, useWorkspaceStore } from '@/stores/workspace'
import type { AppView } from '@/stores/ui'
import { CHROME_HOVER, NO_DRAG } from './chrome'
import { SIDEBAR_PANE, WORKSPACE_PANE, useShellPane } from './shell-panes'

/** 菜单名：点击行为空位（后续件接菜单），先只出形 */
const MENUS = ['文件', '编辑', '视图', '帮助'] as const

/** 头部两道分界线共用的外观：贴块缘、垂直居中的 16px 短竖线，前景色 7%（与下方会话侧栏
 *    分屏线同色）。左块尾贴右缘、右块首贴左缘，各靠 data-shell-pane 的宽度对齐下方列的边缘；
 *    两处共用这一串类名，样式不会再各改各的 */
const HEADER_DIVIDER = 'pointer-events-none absolute top-1/2 h-4 w-px -translate-y-1/2 bg-foreground/[0.07]'

export function AppHeader({
  view,
  sidebarCollapsed,
  sidebarToggleDisabled = false,
  onToggleSidebar,
  tabsHeaderRef,
}: {
  view: AppView
  sidebarCollapsed: boolean
  sidebarToggleDisabled?: boolean
  onToggleSidebar: () => void
  /** 标签页区块的内层裁剪窗：WorkspaceSurface 把标签头 portal 进来 */
  tabsHeaderRef: RefObject<HTMLDivElement | null>
}) {
  const [maximized, setMaximized] = useState(false)
  // 左块是会话侧栏的消费端，中块与右块是工作区的消费端：挂载后照当前宽度补写
  useShellPane(SIDEBAR_PANE)
  useShellPane(WORKSPACE_PANE)
  /* 两组按钮各自加悬停滑动（2026-11-28 试装）：左组 = 折叠钮 + 四个文字菜单（侧栏收起时是
     折叠钮 + 应用菜单钮），右组 = 窗口控制三钮。只加滑动不改高亮 —— 关闭钮的红色 hover 由胶囊原样读出 */
  const leftSlide = useHoverSlide()
  const rightSlide = useHoverSlide()
  const scope = useWorkspaceStore(s => s.scopes[s.activeScopeId] ?? EMPTY_WORKSPACE)
  const autoCollapsed = useWorkspaceStore(s => s.autoCollapsed)
  // 工作区呈开态：与 WorkspaceSurface 的 isOpen 同一判式。右块的 inert 与对话头的让位都看它
  const workspaceOpen = view === 'home' && !scope.collapsed && !autoCollapsed
  const workspaceExpanded = workspaceOpen && scope.expanded

  // 最大化状态由 main 推送（maximize/unmaximize 都会触发）
  useEffect(() => window.cogent.onWindowState(setMaximized), [])

  /* 内容整体降一档灰（用户定的规则：头部图标/文字不用主字体色，与 rail
     未激活图标同档；hover 经 CHROME_HOVER 加深作反馈，关闭钮红底白字不变） */
  return (
    <header
      className="app-header relative flex h-12 shrink-0 items-stretch text-muted-foreground"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      {/* 左块：图标栏 + 会话侧栏。宽度 = 分栏宽 + 52（图标栏、内容卡左边框、把手各计在内，
          见 data-shell-pane-offset），折叠时停在下限，折叠开关留在原位 */}
      <div data-shell-pane={SIDEBAR_PANE} data-shell-pane-offset={52} className="app-header-sidebar shell-pane-sidebar relative flex h-full shrink-0 items-stretch">
        <div ref={leftSlide.containerRef} className={cn(leftSlide.containerClassName, 'flex h-full min-w-0 items-center')}>
          {leftSlide.pill}
          <div className="flex h-full w-(--shell-rail-w) shrink-0 items-center pl-2" style={NO_DRAG}>
            <Hint tip={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                className={CHROME_HOVER}
                data-hover-slide
                aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
                onClick={onToggleSidebar}
                disabled={sidebarToggleDisabled}
              >
                {sidebarCollapsed ? (
                  <IconLayoutSidebarLeftExpand className="size-[19px]" />
                ) : (
                  <IconLayoutSidebarLeftCollapse className="size-[19px]" />
                )}
              </Button>
            </Hint>
          </div>
          {/* 会话侧栏那一段：文字菜单随块宽被裁。块窄到放不下两枚时由容器查询整段换成下面的菜单钮
              （globals.css .app-header-sidebar）—— 看的是块的实际宽度：拖拽把侧栏拖过折叠阈值时宽度
              当帧落 0、松手才提交状态，开合过渡还有中间帧，按状态切换会露出一个只剩「文件」的菜单 */}
          <nav className="app-header-menus flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden" style={NO_DRAG}>
            {MENUS.map((label) => (
              <Button
                key={label}
                variant="ghost"
                size="header"
                className={CHROME_HOVER}
                data-hover-slide
              >
                {label}
              </Button>
            ))}
          </nav>
          {/* 菜单入口：与文字菜单互斥（容器查询切换），显示时接在折叠钮后面 */}
          <div className="app-header-menu-button flex h-full items-center pl-2" style={NO_DRAG}>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="应用菜单" className={CHROME_HOVER} data-hover-slide />}>
                <IconMenu2 />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-auto min-w-40" align="start">
                {MENUS.map((label) => <DropdownMenuItem key={label}>{label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {/* 与下方会话侧栏分屏线同位的短竖线：块窄时随文字菜单一起隐藏 */}
        <span aria-hidden="true" className={cn('app-header-divider right-0', HEADER_DIVIDER)} />
      </div>

      {/* 中块：对话头。工作区占满时整块 inert 并被右块挤到 0 宽。非首页右块不占位而工作区宽
          不归零，让位改回整段槽位（中块此时没有内容，只是不留被三钮压住的边） */}
      <div
        data-shell-pane={WORKSPACE_PANE}
        data-shell-pane-prop="--shell-workspace-w"
        className="app-header-main shell-pane-var flex h-full min-w-0 flex-1 items-center overflow-hidden"
        style={view === 'home' ? undefined : { paddingRight: 'var(--window-controls-slot)' }}
        inert={workspaceExpanded}
        aria-hidden={workspaceExpanded}
      >
        {view === 'home' && <ChatHeader />}
      </div>

      {/* 右块：工作区宽，左缘分界线与下方工作区左边线同一几何、外观与左块尾那条同一样式；
          宽度收到 0 时线被块自己的 overflow-hidden 裁掉。
          非首页路由离流不占位（工作区此时整体隐藏，宽度不变，回来不重播过渡）。
          内层裁剪窗的宽度与内容由 WorkspaceSurface 写入。裁剪窗靠右钉住：开合动画中右端
          （含窗口三钮的让位）始终在位，内容从左侧露出，不会有一帧滑到三钮底下 */}
      <div
        data-app-header-tabs
        data-shell-pane={WORKSPACE_PANE}
        aria-hidden={!workspaceOpen}
        inert={!workspaceOpen}
        className={cn('app-header-tabs shell-pane-width flex h-full min-w-0 shrink justify-end overflow-hidden', view !== 'home' && 'app-header-tabs-idle')}
      >
        <span aria-hidden="true" className={cn('left-0', HEADER_DIVIDER)} />
        <div ref={tabsHeaderRef} data-shell-pane={WORKSPACE_PANE} data-shell-pane-offset={-1} data-shell-pane-preserve className="app-header-tabs-clip h-full shrink-0" />
      </div>

      {/* 窗口控制三钮：绝对定位钉在行右端。gap-1.5（2026-11-16 用户定调两轮拉开：0.5→1→1.5）+ Hint */}
      <div className="absolute inset-y-0 right-0 z-10 flex items-center pr-2" style={NO_DRAG}>
        <div ref={rightSlide.containerRef} className={cn(rightSlide.containerClassName, 'flex items-center gap-1.5')}>
          {rightSlide.pill}
          <Hint tip="最小化" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              className={CHROME_HOVER}
              data-hover-slide
              aria-label="最小化"
              onClick={() => void window.cogent.minimizeWindow()}
            >
              <IconMinus />
            </Button>
          </Hint>
          <Hint tip={maximized ? '还原' : '最大化'} side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              className={CHROME_HOVER}
              data-hover-slide
              aria-label={maximized ? '还原' : '最大化'}
              onClick={() => void window.cogent.toggleMaximizeWindow()}
            >
              {/* 最大化显示"两层方块"（还原语义），普通显示单方块 —— 与折叠开关同规则 */}
              {maximized ? <IconCopy className="size-[14px]" /> : <IconSquare className="size-[14px]" />}
            </Button>
          </Hint>
          <Hint tip="关闭" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              className="hover:bg-destructive hover:text-white"
              data-hover-slide
              aria-label="关闭"
              onClick={() => void window.cogent.closeWindow()}
            >
              <IconX />
            </Button>
          </Hint>
        </div>
      </div>
    </header>
  )
}
