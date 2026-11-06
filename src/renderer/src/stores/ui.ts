/**
 * UI 全局状态（zustand）。
 * 只放跨页面共享的视图状态；单组件内部的临时状态用 useState，不放这里。
 */
import { create } from 'zustand'

export type View = 'chat' | 'settings'

interface UiState {
  /** 顶层视图：聊天页 / 设置页（页面量少，不引 router） */
  view: View
  /** 聊天页右栏（文档预览）展开状态 */
  docPanelOpen: boolean
  setView: (view: View) => void
  setDocPanelOpen: (open: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  view: 'chat',
  docPanelOpen: false,
  setView: (view) => set({ view }),
  setDocPanelOpen: (docPanelOpen) => set({ docPanelOpen })
}))
