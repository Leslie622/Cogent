/**
 * 首页会话视图态（zustand，跨区域共享）：HomeSidebar（发起入口）与 HomeChat
 * （呈现）之间的轻量选择 —— chat = 打开已有会话（出对话流，不显示项目
 * 会话信息区）；new = 新聊天进行中（信息区显示"选择项目"或回显发起项目）。
 * 这里只是视图态，不持有引擎会话：真会话的创建/选中/消息都在 chat store，
 * 发起入口（HomeSidebar.startNew）两件事一起做。只管视图的原因：消息流与
 * 提交永远走 chat store 的 activeSessionId，视图态若不配真会话就会串话。
 * （2026-11-09：演示数据域已退役，chatId 即引擎会话 id。）
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
  // 默认 = 无演示会话（data.ts 已退役）：真会话由 chat store load() 选中后接管，
  // 首屏瞬间（load 未落定）短暂显示 kind:'new' 空态可接受
  session: { kind: 'new' },
  openChat: (chatId) => set({ session: { kind: 'chat', chatId } }),
  startNewChat: (projectId) => set({ session: { kind: 'new', projectId } }),
}))
