/**
 * 设置页通用件（件 7 定风格，所有设置分区共用）：
 *   SettingsPage         —— 详情页骨架（限宽单列 + 大标题 + 描述/工具行）
 *   SettingsHeader       —— 页头块（标题/描述/工具行），全分区一致
 *   SettingsGroup        —— 组标题 + 圆角描边卡片（行间 divide-y 细分隔线）
 *   SettingsRow          —— 左标题+描述、右控件的横行（可选 searchId 接入搜索定位）
 *   SettingsLocateTarget —— 供非标准行（如主题色、存储统计块）共用的定位与高亮容器
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from 'cn'
import { useSettingsStore } from '@/stores/settings'
import type { SettingItemId } from './search/catalog'

const HIGHLIGHT_DURATION_MS = 2600

export function useSettingsLocate(searchId?: SettingItemId) {
  const ref = useRef<HTMLDivElement>(null)
  const locateRequest = useSettingsStore((s) => s.locateRequest)
  const consumeLocate = useSettingsStore((s) => s.consumeLocate)
  const clearLocate = useSettingsStore((s) => s.clearLocate)

  const isTarget = searchId !== undefined && locateRequest?.itemId === searchId
  const token = isTarget ? locateRequest.token : null
  const consumed = isTarget ? locateRequest.consumed : false

  useEffect(() => {
    if (!isTarget || token === null || consumed) return
    const el = ref.current
    if (el === null) return

    el.scrollIntoView({ block: 'center' })
    el.focus({ preventScroll: true })
    consumeLocate(token)
  }, [isTarget, token, consumed, consumeLocate])

  // 定位后保持清晰提示数秒再自动淡出，避免长期停留在当前页时残留底色
  useEffect(() => {
    if (!isTarget || token === null) return
    const timer = window.setTimeout(() => {
      clearLocate(token)
    }, HIGHLIGHT_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [isTarget, token, clearLocate])

  return { ref, highlighted: isTarget }
}

export function SettingsLocateTarget({
  searchId,
  className,
  children,
}: {
  searchId: SettingItemId
  className?: string
  children: ReactNode
}) {
  const { ref, highlighted } = useSettingsLocate(searchId)
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-search-id={searchId}
      data-search-highlighted={highlighted ? 'true' : undefined}
      className={cn(
        'outline-none transition-colors duration-500',
        highlighted && 'bg-chrome-accent/[0.08] dark:bg-chrome-accent/[0.14]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * 设置详情页骨架：所有分区共用（不各自拼头部）。单列限宽容器 + 大标题
 * + 可选描述行 + 可选工具行。
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

/** 页头块（标题/描述/工具行）单独成件 */
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

/** 设置分组：标题 + 可选标题行右侧动作区 + 卡片容器 */
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
      <div className="mt-3 flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
        {children}
      </div>
    </section>
  )
}

/** 设置行：左 = 正文阶标题 + 小字阶描述，右 = 控件；可选 searchId 接入定位与高亮 */
export function SettingsRow({
  searchId,
  title,
  desc,
  children,
}: {
  searchId?: SettingItemId
  title: ReactNode
  desc?: ReactNode
  children: ReactNode
}) {
  const { ref, highlighted } = useSettingsLocate(searchId)
  return (
    <div
      ref={ref}
      tabIndex={searchId !== undefined ? -1 : undefined}
      data-search-id={searchId}
      data-search-highlighted={highlighted ? 'true' : undefined}
      className={cn(
        'flex flex-col items-stretch gap-3 px-5 py-4 outline-none transition-colors duration-500 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-center @min-[36rem]/settings:gap-6',
        highlighted && 'bg-chrome-accent/[0.08] dark:bg-chrome-accent/[0.14]',
      )}
    >
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
