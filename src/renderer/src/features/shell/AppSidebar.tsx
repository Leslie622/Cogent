/**
 * app-sidebar 区（区域代号见 AGENTS.md「区域代号」）：上/下两组路由钮，点击切
 * AppView，content（content-sidebar + content-main 整体）随之换内容 —— 路由语义。
 * 上区：首页/定时任务/插件；active = 圆角块底 + Tabler 实心变体（Filled 后缀；
 * 选图标时须成对存在——smart-home 无 Filled 已被否）。下区：设置钮，点击出
 * shadcn DropdownMenu（向右弹出），「设置」走路由，「运行时控制台」与「内嵌页面」
 * 打开各自独立窗口，「关于」行为空位；
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
  IconTerminal2,
  IconWorld,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUiStore, type AppView } from '@/stores/ui'
import { useHoverSlide } from '@/hooks/use-hover-slide'

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

/** 图标钮样式：玻璃面使用半透明柔光胶囊（--chrome-hover / --chrome-active + 顶部微高光），
    在彩色渐变底上保持通透不发灰；active 仍配实心图标。
    未激活图标用实色 muted-foreground —— 透明度文字/图标会被 Chromium 降级
    光栅化而发虚（字体清晰度问题的同源规则，见 HomeSidebar 注释） */
const railButton = (active: boolean) =>
  cn(
    'rounded-lg text-muted-foreground hover:bg-(--chrome-hover) hover:text-foreground',
    active && 'bg-(--chrome-active) text-foreground shadow-(--chrome-active-shadow) hover:bg-(--chrome-active)'
  )

export function AppSidebar() {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  /* 上区路由钮之间加悬停滑动（2026-11-28 试装）：只加滑动不改高亮 —— 胶囊颜色读各钮自己的
     hover 底色，active 钮读到的是 --chrome-active。下方设置钮是独钮，无行可滑，不装 */
  const slide = useHoverSlide()

  return (
    <aside className="flex w-(--shell-rail-w) shrink-0 flex-col items-center pt-2 pb-3">
      <nav ref={slide.containerRef} className={cn(slide.containerClassName, 'flex flex-col items-center gap-1.5')}>
        {slide.pill}
        {ITEMS.map(({ view: itemView, label, icon: Icon, iconActive: IconFilled }) => {
          const active = view === itemView
          return (
            <Hint key={itemView} tip={label} side="right">
              <Button
                variant="ghost"
                size="icon-lg"
                className={railButton(active)}
                data-hover-slide
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                onClick={() => setView(itemView)}
              >
                {active ? <IconFilled className="size-5" /> : <Icon className="size-5" />}
              </Button>
            </Hint>
          )
        })}
      </nav>

      <div className="mt-auto">
        <DropdownMenu>
          {/* base-ui 触发器无 asChild，用 render 挂到我们的 Button 上 */}
          {/* Hint 包在 DropdownMenuTrigger **外层**（同 ProjectPicker 教训：塞进
              render 里 children 被吞）；base-ui 嵌套触发器（tooltip → menu）
              官方支持，hover 出气泡、点击出菜单 */}
          <Hint tip="设置" side="right">
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className={railButton(view === 'settings')}
                  aria-label="设置"
                />
              }
            >
              {view === 'settings' ? (
                <IconSettingsFilled className="size-5" />
              ) : (
                <IconSettings className="size-5" />
              )}
            </DropdownMenuTrigger>
          </Hint>
          {/* 50px 窄栏贴左缘，菜单向右弹出、底端对齐；菜单项带左侧图标。
              size=lg：与模型菜单同放大档（2026-11-16 定调，菜单统一大气形态）；
              w-auto 覆写原语 w-(--anchor-width)（锚点是图标钮，不覆写则菜单
              钉在 min-w-32 地板压窄） */}
          <DropdownMenuContent side="right" align="end" sideOffset={4} size="lg" className="w-auto min-w-36">
            <DropdownMenuItem onClick={() => setView('settings')}>
              <IconSettings className="size-[17px]" />
              设置
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void window.cogent.openConsole()}>
              <IconTerminal2 className="size-[17px]" />
              运行时控制台
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void window.cogent.openEmbedded()}>
              <IconWorld className="size-[17px]" />
              内嵌页面
            </DropdownMenuItem>
            <DropdownMenuSeparator />
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
