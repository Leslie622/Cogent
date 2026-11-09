/**
 * content-main 的设置页主体：按 settings store 的选中分区挂内容 ——
 * 常规已落地（GeneralSection，件 7 定风格：组卡片 + 行 + 开关/下拉/按钮），
 * 其余分区出占位标题（内容逐件实现）。
 */
import type { ComponentType } from 'react'
import { GeneralSection } from './GeneralSection'
import { ModelsSection } from './ModelsSection'
import { ArchivedChatsSection } from './ArchivedChatsSection'
import { findSettingsItem } from './data'
import { useSettingsStore, type SettingsSectionId } from '@/stores/settings'

/** 分区 → 内容组件注册表：新分区落地时在此挂入口（占位分区不登记） */
const SECTIONS: Partial<Record<SettingsSectionId, ComponentType>> = {
  general: GeneralSection,
  models: ModelsSection,
  'archived-chats': ArchivedChatsSection,
}

export function SettingsMain() {
  const section = useSettingsStore((s) => s.section)
  const Section = SECTIONS[section]
  const item = findSettingsItem(section)

  return (
    <div className="h-full overflow-y-auto">
      {Section ? (
        <Section />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {item ? `${item.label} —— 分区内容属后续件` : null}
        </div>
      )}
    </div>
  )
}
