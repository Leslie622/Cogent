/**
 * 首页会话视图态（zustand，跨区域共享）：HomeSidebar（发起入口）与 HomeChat
 * （呈现）之间的轻量选择 —— chat = 打开已有会话（出对话流，不显示项目
 * 会话信息区）；new = 新聊天进行中（信息区显示"选择项目"或回显发起项目）。
 * 这里只是视图态，不持有引擎会话：真会话的创建/选中/消息都在 chat store，
 * 未发送的新聊天只有一份草稿，切回入口复用身份；首条提交才物化引擎会话。
 * chatId 即引擎会话 id。
 */
import { create } from 'zustand'
import type { PermissionMode } from '@/env.d'

function newDraftId(): string {
  const id = crypto.randomUUID()
  localStorage.setItem('cogent.new-draft', id)
  return id
}

/** 旧版本可能把已绑定聊天的身份留在新聊天入口；保留原聊天草稿，只轮换入口身份。 */
export function restoreNewDraftId(): string {
  const id = localStorage.getItem('cogent.new-draft')
  if (id === null) return newDraftId()
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key !== null && key.startsWith('cogent.chat-draft.') && localStorage.getItem(key) === `new-${id}`) return newDraftId()
  }
  return id
}

export type HomeSession =
  | { kind: 'chat'; chatId: string }
  | {
      kind: 'new'
      draftId?: string
      projectId?: string
      /**
       * 权限模式暂存位（新聊天视图态的一部分；审批交互升级第 3 步由
       * fullAccess 布尔三档化）：新会话还没 sessionId，权限菜单的选择暂存在
       * 此，submit 物化时随 session.create 落定（chat store createSession 读取）。
       * undefined = 未显式选择 → 物化时用设置页「默认权限」（engine store）。
       * 刻意不进 settings 持久化 —— 跨会话记住「上次开了全放行」会让用户忘了
       * 关，显式缺省回 ask 才是安全缺省
       */
      permissionMode?: PermissionMode
      /**
       * 计划开关暂存位（正交开关 v3）：与权限暂存同链同语义 —— 物化时随
       * session.create 落 planEnabled；undefined = 未开
       */
      planEnabled?: boolean
    }

interface HomeState {
  session: HomeSession
  newDraft: Extract<HomeSession, { kind: 'new' }>
  /** 打开已有会话（侧栏聊天行点击） */
  openChat: (chatId: string) => void
  /** 发起新聊天：projectId 缺省 = 未选项目（信息区出"选择项目"） */
  startNewChat: (projectId?: string) => void
  updateNewChat: (patch: Partial<Pick<Extract<HomeSession, { kind: 'new' }>, 'projectId' | 'permissionMode' | 'planEnabled'>>) => void
  finishNewChat: (draftId: string, chatId: string) => void
}

const initialDraft: Extract<HomeSession, { kind: 'new' }> = { kind: 'new', draftId: restoreNewDraftId() }
export const useHomeStore = create<HomeState>((set) => ({
  // 默认 = 无会话选中：真会话由 chat store load() 选中后接管，
  // 首屏瞬间（load 未落定）短暂显示 kind:'new' 空态可接受
  session: initialDraft,
  newDraft: initialDraft,
  openChat: (chatId) => set((state) => ({ session: { kind: 'chat', chatId }, newDraft: state.session.kind === 'new' ? state.session : state.newDraft })),
  startNewChat: (projectId) => set((state) => {
    const draft = state.session.kind === 'new' ? state.session : state.newDraft
    const next = projectId === undefined ? draft : { ...draft, projectId }
    return { session: next, newDraft: next }
  }),
  updateNewChat: (patch) => set((state) => {
    const draft = { ...(state.session.kind === 'new' ? state.session : state.newDraft), ...patch }
    return { newDraft: draft, ...(state.session.kind === 'new' && { session: draft }) }
  }),
  finishNewChat: (draftId, chatId) => set((state) => {
    const visible = state.session.kind === 'new' && (state.session.draftId ?? 'default') === draftId
    if (!visible && state.newDraft.draftId !== draftId) return state
    return { newDraft: { kind: 'new', draftId: newDraftId() }, ...(visible && { session: { kind: 'chat', chatId } as HomeSession }) }
  }),
}))
