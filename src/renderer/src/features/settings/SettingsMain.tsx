/**
 * content-main 的设置页主体：按 settings store 的选中分区与视图模式挂内容。
 * 已访问过的分区通过 React <Activity> 保留实例，切换设置页或往返搜索结果时
 * 不再卸载重挂载，避免异步控件与带过渡的控件重复播动画或丢失局部状态。
 * 滚动策略由 navToken + navReason 精确驱动：
 *   - section / search-results / search-browse：绘制前统一回顶
 *   - locate：由目标设置行挂载后消费滚动与聚焦，不在此处回顶覆盖
 *   - clear-in-detail：保留当前位置不额外跳动
 * 侧栏折叠（sidebarCollapsed）时在主内容顶部提供同源搜索框与返回入口。
 */
import { Activity, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { GeneralSection } from './GeneralSection'
import { AppearanceSection } from './AppearanceSection'
import { NotificationsSection } from './NotificationsSection'
import { ModelsSection } from './ModelsSection'
import { ArchivedChatsSection } from './ArchivedChatsSection'
import { StorageSection } from './StorageSection'
import { McpSection } from './McpSection'
import { SkillSection } from './SkillSection'
import { findSettingsItem } from './data'
import { useSettingsStore, type SettingsSectionId } from '@/stores/settings'
import { BackToSearchResultsButton, SettingsSearchBox } from './search/SettingsSearchBox'
import { SettingsSearchResults } from './search/SettingsSearchResults'

/** 分区 → 内容组件注册表：新分区落地时在此挂入口（占位分区不登记） */
const SECTIONS: Partial<Record<SettingsSectionId, ComponentType>> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  models: ModelsSection,
  'archived-chats': ArchivedChatsSection,
  storage: StorageSection,
  connections: McpSection,
  skills: SkillSection,
}

export function SettingsMain({ sidebarCollapsed = false }: { sidebarCollapsed?: boolean }) {
  const section = useSettingsStore((s) => s.section)
  const query = useSettingsStore((s) => s.query)
  const viewMode = useSettingsStore((s) => s.viewMode)
  const navToken = useSettingsStore((s) => s.navToken)
  const navReason = useSettingsStore((s) => s.navReason)
  const item = findSettingsItem(section)
  const scrollRef = useRef<HTMLDivElement>(null)
  const hasQuery = query.trim() !== ''
  const showResults = hasQuery && viewMode === 'results'

  const [visited, setVisited] = useState<SettingsSectionId[]>(() => [section])
  if (!visited.includes(section)) {
    setVisited((prev) => [...prev, section])
  }

  const activeHasSection = SECTIONS[section] !== undefined

  useLayoutEffect(() => {
    if (
      scrollRef.current !== null &&
      (navReason === 'section' || navReason === 'search-results' || navReason === 'search-browse')
    ) {
      scrollRef.current.scrollTop = 0
    }
  }, [navToken, navReason])

  return (
    <div ref={scrollRef} className="scrollbar-gutter-stable h-full overflow-y-auto">
      {sidebarCollapsed && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-10 pt-6">
          <SettingsSearchBox className="min-w-44 flex-1" />
          {hasQuery && viewMode === 'detail' && <BackToSearchResultsButton />}
        </div>
      )}
      {showResults ? (
        <SettingsSearchResults />
      ) : !activeHasSection ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {item ? `${item.label} —— 分区内容属后续件` : null}
        </div>
      ) : null}
      {visited.map((id) => {
        const Section = SECTIONS[id]
        if (!Section) return null
        return (
          <Activity key={id} mode={!showResults && section === id ? 'visible' : 'hidden'}>
            <Section />
          </Activity>
        )
      })}
    </div>
  )
}
