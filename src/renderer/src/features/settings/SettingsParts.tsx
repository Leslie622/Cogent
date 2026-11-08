/**
 * 设置页通用件（件 7 定风格，所有设置分区共用）：
 *   SettingsGroup —— 组标题 + 圆角描边卡片（行间 divide-y 细分隔线）
 *   SettingsRow  —— 左标题+描述、右控件的横行（desc 可带内联链接）
 * 控件本体（Switch / 下拉 / 按钮）由各分区自行组合，通用件不锁死 ——
 * 后续分区（外观/存储/模型…）照此拼装即可保持同一风格。
 */
import type { ReactNode } from 'react'

/** 设置分组：标题 + 卡片容器；divide-y 出行间 1px 线（首行无线） */
export function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-7">
      <h3 className="text-[15px] font-semibold">{label}</h3>
      <div className="mt-3 flex flex-col divide-y divide-border rounded-xl border border-border">
        {children}
      </div>
    </section>
  )
}

/** 设置行：左 = 标题（14px medium）+ 描述（13px 灰，可换行带链接），右 = 控件 */
export function SettingsRow({
  title,
  desc,
  children,
}: {
  title: string
  desc?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-6 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {desc && (
          <div className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{desc}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
