/**
 * 设置页选中分区（zustand，跨区域共享）：content-sidebar 列表选中 ↔
 * content-main 分区呈现。分区注册表（图标/分组）在 features/settings/data.ts
 * —— store 只持 id，不反向依赖 features。
 */
import { create } from 'zustand'

export type SettingsSectionId =
  | 'general'
  | 'models'
  | 'import'
  | 'appearance'
  | 'archived-chats'
  | 'voice'
  | 'storage'
  | 'config'
  | 'personalization'
  | 'companion'
  | 'shortcuts'
  | 'plugins'
  | 'computer-control'
  | 'app-snapshots'
  | 'browser'
  | 'hooks'
  | 'connections'
  | 'git'
  | 'environment'
  | 'worktrees'

interface SettingsState {
  section: SettingsSectionId
  setSection: (id: SettingsSectionId) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  section: 'general',
  setSection: (section) => set({ section }),
}))
