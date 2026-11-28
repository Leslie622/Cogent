/**
 * content-sidebar 的设置页内容：标题 + 搜索框 + 返回搜索结果 + 两分组分区列表
 * （基础设置 / Agent 能力）。搜索非空时按匹配结果过滤设置页并隐藏空分组；
 * 点击左侧页入口保留搜索词浏览完整设置页顶部。
 */
import { SETTINGS_GROUPS } from './data'
import { cn } from 'cn'
import { useSettingsStore } from '@/stores/settings'
import { useHoverSlide } from '@/hooks/use-hover-slide'
import { BackToSearchResultsButton, SettingsSearchBox } from './search/SettingsSearchBox'
import { useSettingsSearch } from './search/use-settings-search'

export function SettingsSidebar() {
  const section = useSettingsStore((s) => s.section)
  const viewMode = useSettingsStore((s) => s.viewMode)
  const setSection = useSettingsStore((s) => s.setSection)
  const browseSectionFromSearch = useSettingsStore((s) => s.browseSectionFromSearch)
  const { hasQuery, matchedSectionIds } = useSettingsSearch()
  const slide = useHoverSlide()

  const visibleGroups = hasQuery
    ? SETTINGS_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => matchedSectionIds.has(item.id)),
      })).filter((group) => group.items.length > 0)
    : SETTINGS_GROUPS

  return (
    <div className="flex h-full flex-col">
      {/* 头部：路由标题（与 HomeSidebar 同款 16px 粗体） */}
      <div className="flex h-12 shrink-0 items-center pl-4">
        <span className="text-base font-semibold">设置</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <SettingsSearchBox />

        {hasQuery && viewMode === 'detail' && (
          <BackToSearchResultsButton className="mt-2 w-full" />
        )}

        <div ref={slide.containerRef} className={slide.containerClassName}>
          {slide.pill}
          {hasQuery && visibleGroups.length === 0 ? (
            <div className="mt-4 px-2 py-6 text-center text-xs text-muted-foreground">
              没有匹配的设置页
            </div>
          ) : (
            visibleGroups.map((group) => (
              <section key={group.label} className="mt-4 flex flex-col gap-0.5">
                {/* 分组标题：灰字，非按钮（与 HomeSidebar 分区标题同档） */}
                <div className="flex h-7 items-center px-2 text-sm text-muted-foreground">
                  {group.label}
                </div>
                {group.items.map(({ id, label, icon: Icon }) => {
                  const active = viewMode === 'detail' && section === id
                  return (
                    <button
                      key={id}
                      type="button"
                      data-hover-slide
                      data-active={active || undefined}
                      onClick={() => (hasQuery ? browseSectionFromSearch(id) : setSection(id))}
                      aria-current={active ? 'true' : undefined}
                      className="sidebar-row group relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-foreground"
                    >
                      <Icon
                        className={cn(
                          'sidebar-row-icon size-4 shrink-0 text-muted-foreground',
                          active && 'text-foreground'
                        )}
                      />
                      <span className="truncate">{label}</span>
                    </button>
                  )
                })}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
