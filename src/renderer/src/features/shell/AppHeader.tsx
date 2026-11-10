/**
 * header 区（区域代号见 AGENTS.md「区域代号」）：frameless 窗口拖拽区，三组内容 ——
 * 左：content-sidebar 折叠开关，系列图标两态：展开时 Collapse（点击收起）、折叠时
 *     Expand（点击展开）；状态由 AppShell 从面板 onResize 同步，拖拽折叠、点钮
 *     折叠都会翻转图标；
 * 左二：四个菜单文字按钮（shadcn ghost，hover 出底色；点击行为属后续菜单件）；
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
  IconSquare,
  IconTerminal2,
  IconX,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties
/** chrome 面上的 ghost hover 覆盖（见文件头注释）：黑低透明度软叠（同 ChatGPT
    配方），比白/灰块底通透、不压薄荷色相；深度按用户意见压到 5% */
const CHROME_HOVER = 'hover:bg-foreground/5 hover:text-foreground'

/** 菜单名：点击行为空位（后续件接菜单），先只出形 */
const MENUS = ['文件', '编辑', '视图', '帮助'] as const

export function AppHeader({
  sidebarCollapsed,
  onToggleSidebar,
}: {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}) {
  const [maximized, setMaximized] = useState(false)

  // 最大化状态由 main 推送（maximize/unmaximize 都会触发）
  useEffect(() => window.cogent.onWindowState(setMaximized), [])

  return (
    /* 内容整体降一档灰（用户定的规则：头部图标/文字不用主字体色，与 rail
       未激活图标同档；hover 经 CHROME_HOVER 加深作反馈，关闭钮红底白字不变） */
    <header
      className="flex h-10 shrink-0 items-center pr-2 text-muted-foreground"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      <div className="flex items-center gap-2 pl-2" style={NO_DRAG}>
        <Button
          variant="ghost"
          size="icon-sm"
          className={CHROME_HOVER}
          aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          onClick={onToggleSidebar}
        >
          {sidebarCollapsed ? (
            <IconLayoutSidebarLeftExpand className="size-[19px]" />
          ) : (
            <IconLayoutSidebarLeftCollapse className="size-[19px]" />
          )}
        </Button>
        <nav className="flex items-center gap-1">
          {MENUS.map((label) => (
            <Button
              key={label}
              variant="ghost"
              size="sm"
              className={cn(CHROME_HOVER, 'h-7 px-2')}
            >
              {label}
            </Button>
          ))}
        </nav>
        {/* 运行时控制台（帮助右侧，用户定入口）：开独立 DevTools 窗口，
            单例 —— 已开则聚焦 */}
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(CHROME_HOVER, 'ml-1')}
          aria-label="打开运行时控制台"
          title="运行时控制台"
          onClick={() => void window.cogent.openConsole()}
        >
          <IconTerminal2 className="size-[18px]" />
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-0.5" style={NO_DRAG}>
        <Button
          variant="ghost"
          size="icon-sm"
          className={CHROME_HOVER}
          aria-label="最小化"
          onClick={() => void window.cogent.minimizeWindow()}
        >
          <IconMinus />
        </Button>
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:bg-destructive hover:text-white"
          aria-label="关闭"
          onClick={() => void window.cogent.closeWindow()}
        >
          <IconX />
        </Button>
      </div>
    </header>
  )
}
