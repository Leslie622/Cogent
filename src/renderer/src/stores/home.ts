/**
 * 首页会话态（zustand，跨区域共享）：HomeSidebar（发起入口）与 HomeChat
 * （呈现）之间的会话选择 —— chat = 打开已有会话（出对话流，不显示项目
 * 会话信息区）；new = 新聊天（对话流为空，信息区显示"选择项目"或回显
 * 发起项目）。真实会话域（引擎会话 CRUD）接入后由 chat store 吸收替换。
 */
import { create } from 'zustand'

export type HomeSession =
  | { kind: 'chat'; chatId: string }
  | { kind: 'new'; projectId?: string }

interface HomeState {
  session: HomeSession
  /** 打开已有会话（侧栏聊天行点击） */
  openChat: (chatId: string) => void
  /** 发起新聊天：projectId 缺省 = 未选项目（信息区出"选择项目"） */
  startNewChat: (projectId?: string) => void
}

export const useHomeStore = create<HomeState>((set) => ({
  // 默认落在演示会话（与样例数据同一条，首屏即对话流）
  session: { kind: 'chat', chatId: 'c-conventions' },
  openChat: (chatId) => set({ session: { kind: 'chat', chatId } }),
  startNewChat: (projectId) => set({ session: { kind: 'new', projectId } }),
}))
