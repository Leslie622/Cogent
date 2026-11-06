/**
 * UI 全局状态（zustand）。
 * 只放跨页面共享的视图状态；单组件内部的临时状态用 useState，不放这里。
 */
import { create } from 'zustand'
import type { SettingsSectionId } from '@/features/settings/sections'

export type View = 'chat' | 'settings'

interface UiState {
  /** 顶层视图：聊天页 / 设置页（页面量少，不引 router） */
  view: View
  /** 聊天页右栏（文档预览）展开状态 */
  docPanelOpen: boolean
  /** 设置页当前分区（提升到全局：模型下拉的"去设置"需要跨页定位到 models 分区） */
  settingsSection: SettingsSectionId
  setView: (view: View) => void
  setDocPanelOpen: (open: boolean) => void
  setSettingsSection: (section: SettingsSectionId) => void
}

export const useUiStore = create<UiState>((set) => ({
  view: 'chat',
  docPanelOpen: false,
  settingsSection: 'general',
  setView: (view) => set({ view }),
  setDocPanelOpen: (docPanelOpen) => set({ docPanelOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection })
}))
