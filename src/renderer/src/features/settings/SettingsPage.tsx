/**
 * 设置页：两栏 —— 左导航 + 右内容区（独立占满窗口，不带聊天页侧栏）。
 * 参考图2：左侧「返回工作区」+ 分组导航，右侧滚动内容。
 */
import { useState } from 'react'
import { SettingsNav } from './SettingsNav'
import { settingsSections, type SettingsSectionId } from './sections'

export function SettingsPage() {
  const [active, setActive] = useState<SettingsSectionId>('general')
  const SectionBody = settingsSections[active]

  return (
    <div className="flex h-full">
      <SettingsNav active={active} onSelect={setActive} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-8">{SectionBody}</div>
      </main>
    </div>
  )
}
