/**
 * 输入区上方的命令 / 技能候选浮层（毛玻璃材质 + 分组排布 + 键盘导航）。
 * `/` 显示「命令」与「技能」两组；`$`/`￥` 专显「技能」。
 */
import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon } from 'lucide-react'
import { IconDatabase, IconInfoCircle, IconPlug, IconTerminal2, IconWand } from '@tabler/icons-react'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import type { ComposerSuggestionItem, TriggerKind } from './types'

interface CommandSuggestionPanelProps {
  triggerKind: TriggerKind
  items: readonly ComposerSuggestionItem[]
  selectedIndex: number
  selectionSource?: 'keyboard' | 'pointer'
  loading?: boolean
  error?: string
  onSelectIndex: (index: number) => void
  onPick: (item: ComposerSuggestionItem) => void
}

export function CommandSuggestionPanel({
  triggerKind,
  items,
  selectedIndex,
  selectionSource = 'keyboard',
  loading = false,
  error,
  onSelectIndex,
  onPick
}: CommandSuggestionPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  const groups: Array<{ key: ComposerSuggestionItem['group']; label: string; entries: Array<{ item: ComposerSuggestionItem; index: number }> }> = [
    { key: 'command', label: '命令', entries: [] }, { key: 'skill', label: '技能', entries: [] },
    { key: 'mcp-prompt', label: 'MCP 提示词', entries: [] }, { key: 'mcp-resource', label: 'MCP 资源', entries: [] }
  ]
  items.forEach((item, index) => {
    groups.find(group => group.key === item.group)!.entries.push({ item, index })
  })
  const visibleGroups = groups.filter(group => group.entries.length > 0)

  const showGroupHeaders = triggerKind !== '$' && items.length > 0

  useEffect(() => {
    // 鼠标悬停切换高亮不触发自动滚动，避免光标移到边缘行时列表突然跳动
    if (selectionSource !== 'keyboard') return
    const container = scrollRef.current
    const active = activeRef.current
    if (container === null || active === null) return

    // 有吸顶分组标题时为顶部预留标题高度，避免上移选中项被标题遮挡
    const topPadding = showGroupHeaders ? 34 : 6
    const bottomPadding = 6
    const containerRect = container.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    const topDelta = activeRect.top - containerRect.top - topPadding
    const bottomDelta = activeRect.bottom - containerRect.bottom + bottomPadding
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const behavior: ScrollBehavior = reducedMotion ? 'auto' : 'smooth'

    if (topDelta < 0) {
      container.scrollTo({ top: Math.max(0, container.scrollTop + topDelta), behavior })
    } else if (bottomDelta > 0) {
      container.scrollTo({ top: container.scrollTop + bottomDelta, behavior })
    }
  }, [selectedIndex, selectionSource, items.length, showGroupHeaders])

  const renderGroupHeader = (label: string, withBorder: boolean): ReactNode => (
    <div
      data-composer-group-header={label}
      className={cn(
        // 吸顶头必须是列表流容器的直接子节点：sticky 只在 containing block 内生效，
        // 若包在各分组容器里，上一组滚到底时头部提前脱钉、下一组头部未到顶，中间出现无吸顶空窗；
        // 平铺后后一组头部滑入时直接盖住前一组脱钉前的头部，交接连续。
        'sticky top-0 z-10 -mx-1.5 bg-popover/95 px-4 py-1.5 text-xs font-medium text-muted-foreground/90 backdrop-blur-md select-none dark:bg-popover/90',
        withBorder && 'border-t border-border/40'
      )}
    >
      {label}
    </div>
  )

  const renderRows = (entries: Array<{ item: ComposerSuggestionItem; index: number }>, tailGap = false): ReactNode => (
    <div className={cn('flex flex-col gap-0.5', tailGap && 'pb-1')}>
      {entries.map(({ item, index }) => renderRow(item, index))}
    </div>
  )

  const footerText = triggerKind === '$' ? '输入内容以搜索技能' : triggerKind === '@' ? '输入内容以搜索 MCP 资源' : '输入内容以搜索命令、技能或 MCP 提示词'

  const renderRow = (item: ComposerSuggestionItem, index: number) => {
    const active = index === selectedIndex
    const isSkill = item.group === 'skill'
    return (
      <button
        key={item.id}
        ref={active ? activeRef : undefined}
        type="button"
        role="option"
        aria-selected={active}
        data-suggestion-item={item.id}
        onMouseEnter={() => onSelectIndex(index)}
        onMouseDown={(event) => {
          // 阻止点击浮层抢走编辑器焦点，确保原子节点插在当前选区
          event.preventDefault()
          onPick(item)
        }}
        className={cn(
          'group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-100',
          active
            ? 'bg-foreground/[0.075] text-foreground dark:bg-white/[0.10]'
            : 'text-foreground/90 hover:bg-foreground/[0.045] dark:hover:bg-white/[0.06]'
        )}
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-lg border transition-colors',
            isSkill
              ? 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:border-violet-400/25 dark:bg-violet-400/15 dark:text-violet-300'
              : 'border-border/60 bg-background/60 text-foreground/80 dark:border-white/10 dark:bg-white/[0.06]'
          )}
        >
          {item.group === 'mcp-resource' ? <IconDatabase className="size-3.5" /> : item.group === 'mcp-prompt' ? <IconPlug className="size-3.5" /> : isSkill ? <IconWand className="size-3.5" /> : <IconTerminal2 className="size-3.5" />}
        </span>

        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 truncate text-sm font-medium tracking-[-0.01em]',
              !isSkill && 'font-mono'
            )}
          >
            {item.label}
          </span>
          {item.argumentHint !== undefined && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground/75">
              {item.argumentHint}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {item.description}
          </span>
        </div>

        {item.badge !== undefined && (
          // 徽标统一淡玻璃配方（2026-11-27 用户定调：内边距放宽、字不加粗）。
          // 「单独发送」是行为提示（整条发送、不内插正文），保留低饱和琥珀
          // 与纯信息性标签区分；其余走中性 —— 文字色纪律：透明度只许用在背景。
          <span
            className={cn(
              'shrink-0 rounded-md px-2.5 py-1 text-xs leading-none font-normal',
              item.badge === '单独发送'
                ? 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300'
                : 'bg-foreground/[0.055] text-muted-foreground dark:bg-white/[0.08]'
            )}
          >
            {item.badge}
          </span>
        )}
      </button>
    )
  }

  return (
    <div
      role="listbox"
      aria-label={triggerKind === '$' ? '技能候选列表' : triggerKind === '@' ? 'MCP 资源候选列表' : '命令、技能与 MCP 提示词候选列表'}
      data-composer-suggestion-panel
      className={cn(
        'absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-2xl',
        'border border-border/65 bg-popover/75 backdrop-blur-xl backdrop-saturate-150',
        'ring-1 ring-inset ring-white/30 dark:border-white/12 dark:bg-popover/70 dark:ring-white/10',
        'shadow-[0_14px_40px_-10px_rgba(0,0,0,0.16)] dark:shadow-[0_18px_48px_-10px_rgba(0,0,0,0.55)]',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-150'
      )}
    >
      <div ref={scrollRef} className="max-h-72 overflow-y-auto scroll-smooth px-1.5 pb-1.5">
        {items.length === 0 ? (
          <div className="px-3 py-5 text-center text-xs text-muted-foreground">
            {error ?? (loading
              ? '正在加载候选…'
              : triggerKind === '$'
                ? '没有匹配的已启用技能'
                : triggerKind === '@' ? '没有匹配的 MCP 资源' : '没有匹配的命令、技能或 MCP 提示词')}
          </div>
        ) : (
          <div className={cn('flex flex-col', !showGroupHeaders && 'pt-1.5')}>
            {visibleGroups.map((group, index) => (
              <Fragment key={group.key}>
                {showGroupHeaders && renderGroupHeader(group.label, index > 0)}
                {renderRows(group.entries, index < visibleGroups.length - 1)}
              </Fragment>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/45 bg-background/35 px-3 py-2 text-xs text-muted-foreground select-none dark:border-white/10 dark:bg-black/15">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <IconInfoCircle className="size-3.5 shrink-0 opacity-75" />
          <span className="truncate">{footerText}</span>
        </span>
        <div className="hidden shrink-0 items-center gap-3.5 sm:flex">
          <span className="inline-flex items-center gap-1.5">
            <KbdGroup>
              <Kbd aria-label="上移"><ArrowUpIcon /></Kbd>
              <Kbd aria-label="下移"><ArrowDownIcon /></Kbd>
            </KbdGroup>
            <span>选择</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd aria-label="回车"><CornerDownLeftIcon /></Kbd>
            <span>确认</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            <span>关闭</span>
          </span>
        </div>
      </div>
    </div>
  )
}
