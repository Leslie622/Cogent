/**
 * 设置分区注册表（静态）：分组列表供 SettingsSidebar 渲染，id→条目查找供
 * SettingsMain 出占位标题。分区内容组件属后续件，到件时在此登记入口。
 */
import type { ComponentType } from 'react'
import {
  IconApps,
  IconArrowsSplit2,
  IconAt,
  IconBrowser,
  IconCommand,
  IconDatabase,
  IconDownload,
  IconGitBranch,
  IconMicrophone,
  IconMoodSmile,
  IconPalette,
  IconPointer,
  IconSettings,
  IconShield,
  IconSun,
  IconTerminal2,
  IconWebhook,
  IconWorld,
  IconArchive,
} from '@tabler/icons-react'
import type { SettingsSectionId } from '@/stores/settings'

export type SettingsItem = {
  id: SettingsSectionId
  label: string
  icon: ComponentType<{ className?: string }>
}
export type SettingsGroup = { label: string; items: SettingsItem[] }

/** 顺序/命名照参考稿（ChatGPT 设置栏）：个人 / 集成 / 编码 三组 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: '个人',
    items: [
      { id: 'general', label: '常规', icon: IconSettings },
      { id: 'import', label: '导入', icon: IconDownload },
      { id: 'appearance', label: '外观', icon: IconSun },
      { id: 'archived-chats', label: '已归档的聊天', icon: IconArchive },
      { id: 'voice', label: '语音', icon: IconMicrophone },
      { id: 'storage', label: '存储', icon: IconDatabase },
      { id: 'config', label: '配置', icon: IconShield },
      { id: 'personalization', label: '个性化', icon: IconPalette },
      { id: 'companion', label: '迷你界面和智能伙伴', icon: IconMoodSmile },
      { id: 'shortcuts', label: '键盘快捷键', icon: IconCommand },
    ],
  },
  {
    label: '集成',
    items: [
      { id: 'plugins', label: '插件', icon: IconAt },
      { id: 'computer-control', label: '电脑操控', icon: IconPointer },
      { id: 'app-snapshots', label: '应用快照', icon: IconApps },
      { id: 'browser', label: '浏览器', icon: IconBrowser },
    ],
  },
  {
    label: '编码',
    items: [
      { id: 'hooks', label: '钩子', icon: IconWebhook },
      { id: 'connections', label: '连接', icon: IconWorld },
      { id: 'git', label: 'Git', icon: IconGitBranch },
      { id: 'environment', label: '环境', icon: IconTerminal2 },
      { id: 'worktrees', label: 'Worktrees', icon: IconArrowsSplit2 },
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
