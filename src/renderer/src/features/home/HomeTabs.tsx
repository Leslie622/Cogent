/**
 * 标签页区（UI 件 5 只搭壳，区域代号见 AGENTS.md）：参考稿是浏览器式工作区 ——
 * 顶部"新标签页"行 + 快捷工具四项（变更/终端/侧边聊天/文件，带快捷键提示）+
 * 中央空态。全部静态占位：工具点击、标签页管理、地址栏、底部导航属后续件，
 * 引擎也没有对应域。行 hover 用全局黑 5% 软叠配方。
 */
import type { ComponentType } from 'react'
import {
  IconFileDiff,
  IconFiles,
  IconMessageCircle2,
  IconPlus,
  IconTerminal2,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'

/** 快捷工具项：图标 + 名称 + 快捷键（参考稿原样，动作空位） */
const TOOLS: ReadonlyArray<{
  label: string
  kbd: string
  icon: ComponentType<{ className?: string }>
}> = [
  { label: '变更', kbd: 'Ctrl+Shift+G', icon: IconFileDiff },
  { label: '终端', kbd: 'Ctrl+`', icon: IconTerminal2 },
  { label: '侧边聊天', kbd: 'Ctrl+Alt+S', icon: IconMessageCircle2 },
  { label: '文件', kbd: 'Ctrl+P', icon: IconFiles },
]

const ROW_HOVER = 'hover:bg-accent-foreground/5'

export function HomeTabs() {
  return (
    <aside className="flex h-full min-w-0 flex-col">
      {/* 顶部行：当前标签 + 新建；标签管理属后续件 */}
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2.5">
        <span className="min-w-0 truncate text-sm font-medium">新标签页</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:bg-accent-foreground/5 hover:text-foreground"
          aria-label="新建标签页"
        >
          <IconPlus className="size-4" />
        </Button>
      </div>

      {/* 快捷工具：与 content-sidebar 行同款 hover；快捷键灰字右对齐 */}
      <nav className="flex flex-col gap-0.5 px-2">
        {TOOLS.map(({ label, kbd, icon: Icon }) => (
          <button
            key={label}
            type="button"
            className={cn(
              'flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-foreground',
              ROW_HOVER,
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 text-left">{label}</span>
            <span className="text-[11px] text-muted-foreground">{kbd}</span>
          </button>
        ))}
      </nav>

      {/* 中央空态：地址栏/页面内容属后续件 */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        标签页空位 —— 工具与页面内容属后续件
      </div>
    </aside>
  )
}
