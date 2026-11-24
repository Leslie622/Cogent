/**
 * header 区（区域代号见 AGENTS.md「区域代号」）：frameless 窗口拖拽区，三组内容 ——
 * 左：content-sidebar 折叠开关，系列图标两态：展开时 Collapse（点击收起）、折叠时
 *     Expand（点击展开）；状态由 AppShell 从面板 onResize 同步，拖拽折叠、点钮
 *     折叠都会翻转图标；
 * 左二：文件、编辑、视图、帮助四个文字菜单（shadcn ghost）；
 * 右：窗口控制三钮（IPC 直达 main；maximize 两态系列图标 Square↔Copy，状态经
 *     window:state-changed 推送；关闭 hover 保留 Windows 红色惯例）。
 * hover 底色压成 sidebar-accent：chrome 面上的按钮，ghost 默认的 bg-accent(0.97)
 * 与 chrome 底(0.968)几乎同色，hover 会看不见；按钮都包在 no-drag 容器里。
 * 左端 pl-2 与右端 pr-2 对称：折叠钮距左缘 = 关闭钮距右缘。
 * 图标：Tabler（尺寸：折叠开关 19px 与侧栏同基准，窗口控制 —/× 16px、方框 14px）。
 */
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import {
  IconCopy,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMinus,
  IconMenu2,
  IconSquare,
  IconX,
} from '@tabler/icons-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties
/** 玻璃外壳面上的 ghost hover 覆盖：用半透明柔白光替代黑灰叠层，在彩色磨砂底上更通透。 */
const CHROME_HOVER = 'hover:bg-(--chrome-hover) hover:text-foreground'

/** 菜单名：点击行为空位（后续件接菜单），先只出形 */
const MENUS = ['文件', '编辑', '视图', '帮助'] as const

export function AppHeader({
  sidebarCollapsed,
  sidebarToggleDisabled = false,
  onToggleSidebar,
}: {
  sidebarCollapsed: boolean
  sidebarToggleDisabled?: boolean
  onToggleSidebar: () => void
}) {
  const [maximized, setMaximized] = useState(false)

  // 最大化状态由 main 推送（maximize/unmaximize 都会触发）
  useEffect(() => window.cogent.onWindowState(setMaximized), [])

  return (
    /* 内容整体降一档灰（用户定的规则：头部图标/文字不用主字体色，与 rail
       未激活图标同档；hover 经 CHROME_HOVER 加深作反馈，关闭钮红底白字不变） */
    <header
      className="app-header flex h-10 shrink-0 items-center pr-2 text-muted-foreground"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      <div className="flex items-center gap-2 pl-2" style={NO_DRAG}>
        <Hint tip={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            className={CHROME_HOVER}
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
        <nav className="app-header-wide flex items-center gap-1">
          {MENUS.map((label) => (
            <Button
              key={label}
              variant="ghost"
              size="header"
              className={CHROME_HOVER}
            >
              {label}
            </Button>
          ))}
        </nav>
        <div className="app-header-compact">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="应用菜单" className={CHROME_HOVER} />}>
              <IconMenu2 />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-auto min-w-40" align="start">
              {MENUS.map((label) => <DropdownMenuItem key={label}>{label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 窗口控制三钮：gap-1.5（2026-11-16 用户定调两轮拉开：0.5→1→1.5）+ Hint */}
      <div className="ml-auto flex items-center gap-1.5" style={NO_DRAG}>
        <Hint tip="最小化" side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            className={CHROME_HOVER}
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
            aria-label="关闭"
            onClick={() => void window.cogent.closeWindow()}
          >
            <IconX />
          </Button>
        </Hint>
      </div>
    </header>
  )
}
