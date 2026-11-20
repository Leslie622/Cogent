/**
 * 设置页选中分区（zustand，跨区域共享）：content-sidebar 列表选中 ↔
 * content-main 分区呈现。分区注册表（图标/分组）在 features/settings/data.ts
 * —— store 只持 id，不反向依赖 features。分组结构参考 zcode 设置栏
 * （2026-11-15 用户指令：基础设置 / Agent 能力两组）。
 */
import { create } from 'zustand'

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'models'
  | 'browser'
  | 'computer-control'
  | 'shortcuts'
  | 'archived-chats'
  | 'storage'
  | 'plugins'
  | 'connections'
  | 'skills'
  | 'commands'
  | 'hooks'

interface SettingsState {
  section: SettingsSectionId
  setSection: (id: SettingsSectionId) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  section: 'general',
  setSection: (section) => set({ section }),
}))
