/**
 * 首页样例数据域（UI 件 4/5 期间的静态样例）：项目/会话结构 + 派生（置顶
 * 聚合、会话查找）。HomeSidebar（导航列表）与 HomeChat（头部标题/项目归属）
 * 共用，避免两处各抄一份数据；引擎有项目/会话持久化后由引擎 store 替换。
 */

/** 聊天条目（置顶/项目子项/最近项共用一款行）；pinned 只驱动进置顶分区 */
export type ChatSummary = { id: string; title: string; pinned?: boolean }
export type ProjectSummary = { id: string; name: string; chats: ChatSummary[] }

export const PROJECTS: readonly ProjectSummary[] = [
  {
    id: 'p-cogent',
    name: 'Cogent',
    chats: [
      { id: 'c-conventions', title: '整理 Cogent 项目约定', pinned: true },
      { id: 'c-shell', title: 'UI 重写：骨架与路由' },
    ],
  },
  {
    id: 'p-lab',
    name: '实验场',
    chats: [{ id: 'c-provider', title: '自定义 provider 接入' }],
  },
]

export const RECENT: readonly ChatSummary[] = [
  { id: 'c-smoke', title: '引擎冒烟脚本跑通记录' },
  { id: 'c-glow', title: '分屏线光效失效排查' },
]

/** 置顶分区内容 = 全部会话里带 pinned 的（项目子项 + 最近项聚到这里） */
export const PINNED: readonly ChatSummary[] = [
  ...PROJECTS.flatMap((p) => p.chats),
  ...RECENT,
].filter((chat) => chat.pinned)

/** 会话查找：返回会话及其所属项目（最近项无项目归属） */
export const findChat = (
  chatId: string,
): { chat: ChatSummary; project?: ProjectSummary } | null => {
  for (const project of PROJECTS) {
    const chat = project.chats.find((c) => c.id === chatId)
    if (chat) return { chat, project }
  }
  const recent = RECENT.find((c) => c.id === chatId)
  return recent ? { chat: recent } : null
}
