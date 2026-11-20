/**
 * 设置分区注册表（静态）：分组列表供 SettingsSidebar 渲染，id→条目查找供
 * SettingsMain 出占位标题。分组与条目参考 zcode 设置栏（2026-11-15 用户
 * 指令）：基础设置（应用面）/ Agent 能力（扩展面）两组；已实现的分区挂
 * 内容组件（SettingsMain 注册表），其余占位（技能/命令对应阶段 4 后续座）。
 */
import type { ComponentType } from 'react'
import {
  IconArchive,
  IconBell,
  IconBrowser,
  IconCommand,
  IconPointer,
  IconPlug,
  IconPuzzle,
  IconRobot,
  IconSettings,
  IconSun,
  IconTerminal2,
  IconWand,
  IconWebhook,
} from '@tabler/icons-react'
import type { SettingsSectionId } from '@/stores/settings'

export type SettingsItem = {
  id: SettingsSectionId
  label: string
  icon: ComponentType<{ className?: string }>
}
export type SettingsGroup = { label: string; items: SettingsItem[] }

/** 两分组（zcode 形态）：基础设置 / Agent 能力 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: '基础设置',
    items: [
      { id: 'general', label: '常规', icon: IconSettings },
      { id: 'appearance', label: '外观', icon: IconSun },
      { id: 'notifications', label: '通知', icon: IconBell },
      { id: 'models', label: '模型设置', icon: IconRobot },
      { id: 'archived-chats', label: '归档', icon: IconArchive },
      { id: 'browser', label: '浏览器', icon: IconBrowser },
      { id: 'computer-control', label: '电脑操控', icon: IconPointer },
      { id: 'shortcuts', label: '键盘快捷键', icon: IconCommand },
    ],
  },
  {
    label: 'Agent 能力',
    items: [
      { id: 'plugins', label: '插件', icon: IconPuzzle },
      { id: 'connections', label: 'MCP 服务器', icon: IconPlug },
      { id: 'skills', label: '技能', icon: IconWand },
      { id: 'commands', label: '命令', icon: IconTerminal2 },
      { id: 'hooks', label: '钩子', icon: IconWebhook },
    ],
  },
]

/** id → 条目（SettingsMain 占位标题用） */
export const findSettingsItem = (
  id: SettingsSectionId,
): SettingsItem | null => {
  for (const group of SETTINGS_GROUPS) {
    const item = group.items.find((i) => i.id === id)
    if (item) return item
  }
  return null
}
