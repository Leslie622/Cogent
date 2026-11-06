/**
 * 设置卡片行（自研，shadcn 无等价组件）：左标题+描述、右控件的行布局，
 * 配合 ui/card 做分区容器（图2 的行样式抽象）。
 */
import type { ReactNode } from 'react'

interface SettingRowProps {
  title: string
  desc?: string
  children: ReactNode
}

export function SettingRow({ title, desc, children }: SettingRowProps) {
  return (
    <div className="flex items-center gap-6 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {desc && <p className="mt-1 text-xs text-muted-foreground">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
