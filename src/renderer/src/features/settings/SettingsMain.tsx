/**
 * content-main 的设置页主体：按 settings store 的选中分区挂内容 ——
 * 常规已落地（GeneralSection，件 7 定风格：组卡片 + 行 + 开关/下拉/按钮），
 * 其余分区出占位标题（内容逐件实现）。
 */
import { GeneralSection } from './GeneralSection'
import { findSettingsItem } from './data'
import { useSettingsStore } from '@/stores/settings'

export function SettingsMain() {
  const section = useSettingsStore((s) => s.section)
  const item = findSettingsItem(section)

  return (
    <div className="h-full overflow-y-auto">
      {section === 'general' ? (
        <GeneralSection />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {item ? `${item.label} —— 分区内容属后续件` : null}
        </div>
      )}
    </div>
  )
}
