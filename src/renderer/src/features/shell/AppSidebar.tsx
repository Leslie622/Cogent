/**
 * app-sidebar 区（区域代号见 AGENTS.md「区域代号」）：上/下两组路由钮，点击切
 * AppView，content（content-sidebar + content-main 整体）随之换内容 —— 路由语义。
 * 上区：首页/定时任务/插件；active = 圆角块底 + Tabler 实心变体（Filled 后缀；
 * 选图标时须成对存在——smart-home 无 Filled 已被否）。下区：设置钮，点击出
 * shadcn DropdownMenu（向右弹出），菜单项「设置」也走路由，「关于」行为空位；
 * 处在设置视图时设置钮同样亮 active（齿轮实心）。
 */
import type { ComponentType } from 'react'
import {
  IconClock,
  IconClockFilled,
  IconHome,
  IconHomeFilled,
  IconInfoCircle,
  IconPuzzle,
  IconPuzzleFilled,
  IconSettings,
  IconSettingsFilled,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUiStore, type AppView } from '@/stores/ui'

/** 上区路由项：图标成对（描边 = 普通态，实心 = active 态） */
const ITEMS: ReadonlyArray<{
  view: AppView
  label: string
  icon: ComponentType<{ className?: string }>
  iconActive: ComponentType<{ className?: string }>
}> = [
  { view: 'home', label: '首页', icon: IconHome, iconActive: IconHomeFilled },
  { view: 'tasks', label: '定时任务', icon: IconClock, iconActive: IconClockFilled },
  { view: 'plugins', label: '插件', icon: IconPuzzle, iconActive: IconPuzzleFilled },
]

/** 图标钮样式：hover 半透明块底（通透，不压成死色），active 实心块 + 实心图标 */
const railButton = (active: boolean) =>
  cn(
    'rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
    active && 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent'
  )

export function AppSidebar() {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)

  return (
    <aside className="flex w-[50px] shrink-0 flex-col items-center pt-2 pb-3">
      <nav className="flex flex-col items-center gap-1.5">
        {ITEMS.map(({ view: itemView, label, icon: Icon, iconActive: IconFilled }) => {
          const active = view === itemView
          return (
            <Button
              key={itemView}
              variant="ghost"
              size="icon"
              className={railButton(active)}
              title={label}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              onClick={() => setView(itemView)}
            >
              {active ? <IconFilled className="size-[19px]" /> : <Icon className="size-[19px]" />}
            </Button>
          )
        })}
      </nav>

      <div className="mt-auto">
        <DropdownMenu>
          {/* base-ui 触发器无 asChild，用 render 挂到我们的 Button 上 */}
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className={railButton(view === 'settings')}
                title="设置"
                aria-label="设置"
              />
            }
          >
            {view === 'settings' ? (
              <IconSettingsFilled className="size-[19px]" />
            ) : (
              <IconSettings className="size-[19px]" />
            )}
          </DropdownMenuTrigger>
          {/* 50px 窄栏贴左缘，菜单向右弹出、底端对齐；菜单项带左侧图标 */}
          <DropdownMenuContent side="right" align="end" sideOffset={4}>
            <DropdownMenuItem onClick={() => setView('settings')}>
              <IconSettings className="size-[17px]" />
              设置
            </DropdownMenuItem>
            <DropdownMenuItem>
              <IconInfoCircle className="size-[17px]" />
              关于
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
}
