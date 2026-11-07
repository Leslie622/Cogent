/**
 * UI 全局状态（zustand）。
 * 只放跨区域共享的视图状态；单组件内部临时状态用 useState，不放这里。
 */
import { create } from 'zustand'

/**
 * 应用视图路由：app-sidebar 按钮切换，content（content-sidebar + content-main
 * 整体）随之换内容。页面量少，不引 router —— 一个字段就是一条路由。
 */
export type AppView = 'home' | 'tasks' | 'plugins' | 'settings'

/** 视图显示名（app-sidebar 路由钮与 content 占位共用） */
export const VIEW_LABELS: Record<AppView, string> = {
  home: '首页',
  tasks: '定时任务',
  plugins: '插件',
  settings: '设置',
}

interface UiState {
  view: AppView
  setView: (view: AppView) => void
}

export const useUiStore = create<UiState>((set) => ({
  view: 'home',
  setView: (view) => set({ view }),
}))
