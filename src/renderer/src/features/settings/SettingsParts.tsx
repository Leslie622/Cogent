/**
 * 设置页通用件（件 7 定风格，所有设置分区共用）：
 *   SettingsPage  —— 详情页骨架（限宽单列 + 大标题 + 描述/工具行，zcode 对齐）
 *   SettingsGroup —— 组标题 + 圆角描边卡片（行间 divide-y 细分隔线）
 *   SettingsRow  —— 左标题+描述、右控件的横行（desc 可带内联链接）
 * 控件本体（Switch / 下拉 / 按钮）由各分区自行组合，通用件不锁死 ——
 * 后续分区（外观/浏览器/技能…）照此拼装即可保持同一风格，不各自手写页头
 * （2026-11-15 用户指令：详情页布局模块化；模型设置是唯一例外——master-detail
 * 自撑布局，内容特殊）。
 */
import type { ReactNode } from 'react'

/**
 * 设置详情页骨架：所有分区共用（不各自拼头部）。单列限宽容器 + 大标题
 * （居左 24px 粗体）+ 可选描述行（灰 13px）+ 可选工具行（计数/动作钮，
 * zcode MCP 页同位）。zcode 各设置页同款骨架：标题必在、描述按需、
 * 内容 = 若干 SettingsGroup 卡片垂直排。
 */
export function SettingsPage({
  title,
  desc,
  toolbar,
  children
}: {
  title: string
  desc?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-10 py-8">
      <h2 className="text-2xl font-semibold">{title}</h2>
      {desc !== undefined && (
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{desc}</p>
      )}
      {toolbar !== undefined && <div className="mt-6 flex items-center gap-2">{toolbar}</div>}
      {children}
    </div>
  )
}

/** 设置分组：标题（可省 —— 列表卡直接顶格）+ 卡片容器；divide-y 出行间 1px 线（首行无线） */
export function SettingsGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-7">
      {label !== undefined && <h3 className="text-[15px] font-semibold">{label}</h3>}
      <div className="mt-3 flex flex-col divide-y divide-border rounded-xl border border-border">
        {children}
      </div>
    </section>
  )
}

/** 设置行：左 = 标题（14px medium，可带内联徽标 → ReactNode）+ 描述（13px 灰，
    可换行带链接），右 = 控件 */
export function SettingsRow({
  title,
  desc,
  children,
}: {
  title: ReactNode
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
