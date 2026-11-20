/**
 * 设置页通用件（件 7 定风格，所有设置分区共用）：
 *   SettingsPage  —— 详情页骨架（限宽单列 + 大标题 + 描述/工具行，zcode 对齐）
 *   SettingsHeader —— 页头块（标题/描述/工具行），页头边距是模板量，全分区一致
 *   SettingsGroup —— 组标题 + 圆角描边卡片（行间 divide-y 细分隔线）
 *   SettingsRow  —— 左标题+描述、右控件的横行（desc 可带内联链接）
 * 控件本体（Switch / 下拉 / 按钮）由各分区自行组合，通用件不锁死 ——
 * 后续分区（外观/浏览器/技能…）照此拼装即可保持同一风格，不各自手写页头
 * （2026-11-15 用户指令：详情页布局模块化；模型设置是唯一例外——master-detail
 * 自撑布局，仅主体卡全宽特殊，页头同样走 SettingsHeader）。
 */
import type { ReactNode } from 'react'

/**
 * 设置详情页骨架：所有分区共用（不各自拼头部）。单列限宽容器 + 大标题
 * （居左主标题阶）+ 可选描述行（正文阶，2026-11-20 用户指令从小字阶上调）+
 * 可选工具行（计数/动作钮，zcode MCP 页同位）。zcode 各设置页同款骨架：
 * 标题必在、描述按需、内容 = 若干 SettingsGroup 卡片垂直排。
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
    <div className="@container/settings mx-auto w-full max-w-3xl px-10 py-8">
      <SettingsHeader title={title} desc={desc} toolbar={toolbar} />
      {children}
    </div>
  )
}

/** 页头块（标题/描述/工具行）单独成件：页头列位与上、左右边距是全分区
    统一的模板量 —— 模型设置不走 SettingsPage 容器（master-detail 自撑），
    但页头必须复用本件，切页时标题不跳位 */
export function SettingsHeader({
  title,
  desc,
  toolbar
}: {
  title: string
  desc?: ReactNode
  toolbar?: ReactNode
}) {
  return (
    <>
      <h2 className="text-2xl font-semibold">{title}</h2>
      {desc !== undefined && (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{desc}</p>
      )}
      {toolbar !== undefined && <div className="mt-6 flex items-center gap-2">{toolbar}</div>}
    </>
  )
}

/** 设置分组：标题（可省 —— 列表卡直接顶格）+ 可选标题行右侧动作区（zcode
    「已安装 N … [刷新][新建]」同位）+ 卡片容器；divide-y 出行间 1px 线（首行无线）。
    mt-8 同时承担"页头 → 第一个内容"与组间距 —— 两处统一 32px，各分区的
    状态卡（加载/空/无匹配）也按此间距对齐，不再各自手写 */
export function SettingsGroup({
  label,
  actions,
  children
}: {
  label?: string
  /** 标题行右侧动作（整组级按钮，如刷新/新建） */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-8">
      {(label !== undefined || actions !== undefined) && (
        <div className="flex items-center justify-between">
          {label !== undefined && <h3 className="text-base font-semibold">{label}</h3>}
          {actions !== undefined && <div className="flex items-center gap-1">{actions}</div>}
        </div>
      )}
      {/* 圆角 lg 档（2026-11-20 用户定调）：与原生 Input/Button 同阶，不再用 xl 大容器档。
          overflow-hidden：全宽行（存储页明细触发器等）hover 铺底时按卡圆角裁齐，
          否则直角底色顶出圆角；焦点轮廓是内贴实线不受裁剪，浮层走 portal 不在裁剪面 */}
      <div className="mt-3 flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
        {children}
      </div>
    </section>
  )
}

/** 设置行：左 = 正文阶标题（可带内联徽标 → ReactNode）+ 小字阶描述（灰，
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
    <div className="flex flex-col items-stretch gap-3 px-5 py-4 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-center @min-[36rem]/settings:gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {desc && (
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{desc}</div>
        )}
      </div>
      <div className="min-w-0 max-w-full shrink-0">{children}</div>
    </div>
  )
}
