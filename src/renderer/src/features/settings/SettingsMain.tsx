/**
 * content-main 的设置页主体：按 settings store 的选中分区挂内容 ——
 * 常规已落地（GeneralSection，件 7 定风格：组卡片 + 行 + 开关/下拉/按钮），
 * 其余分区出占位标题（内容逐件实现）。
 * 滚动容器两条防抖规则（切分区时内容会重挂、高度先塌后弹）：
 *   scrollbar-gutter-stable —— 滚动条空间常驻（HomeSidebar 同款），居中列
 *     不随滚动条出现/消失左右横跳；切分区显式回顶 —— 一次干净跳转代替
 *     浏览器对"内容突然变矮"的钳位乱跳。
 */
import { useLayoutEffect, useRef, type ComponentType } from 'react'
import { GeneralSection } from './GeneralSection'
import { AppearanceSection } from './AppearanceSection'
import { NotificationsSection } from './NotificationsSection'
import { ModelsSection } from './ModelsSection'
import { ArchivedChatsSection } from './ArchivedChatsSection'
import { McpSection } from './McpSection'
import { SkillSection } from './SkillSection'
import { findSettingsItem } from './data'
import { useSettingsStore, type SettingsSectionId } from '@/stores/settings'

/** 分区 → 内容组件注册表：新分区落地时在此挂入口（占位分区不登记） */
const SECTIONS: Partial<Record<SettingsSectionId, ComponentType>> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  models: ModelsSection,
  'archived-chats': ArchivedChatsSection,
  connections: McpSection,
  skills: SkillSection,
}

export function SettingsMain() {
  const section = useSettingsStore((s) => s.section)
  const Section = SECTIONS[section]
  const item = findSettingsItem(section)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 回顶放 useLayoutEffect（绘制前归零，旧滚动位置不闪帧）；ref 类型含 null，
  // 挂载后必非空，这里只做类型收窄
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
  }, [section])

  return (
    <div ref={scrollRef} className="scrollbar-gutter-stable h-full overflow-y-auto">
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
