/** 未发送的新聊天身份跨导航保留，受理后才让位给下一份空草稿。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { restoreNewDraftId, useHomeStore } from '@/stores/home'
const initial = useHomeStore.getState()
beforeEach(() => { useHomeStore.setState(initial, true) })
describe('单份新聊天草稿', () => {
  it('恢复入口不复用旧版已绑定聊天的身份，也不删除该聊天草稿', () => {
    localStorage.setItem('cogent.new-draft', 'old-bound')
    localStorage.setItem('cogent.chat-draft.a', 'new-old-bound')
    localStorage.setItem('cogent.attachment-draft.new-old-bound', '原聊天草稿')
    expect(restoreNewDraftId()).not.toBe('old-bound')
    expect(localStorage.getItem('cogent.chat-draft.a')).toBe('new-old-bound')
    expect(localStorage.getItem('cogent.attachment-draft.new-old-bound')).toBe('原聊天草稿')
    localStorage.setItem('cogent.new-draft', 'pending')
    expect(restoreNewDraftId()).toBe('pending')
  })
  it('项目、权限、计划选择与 draftId 在已有聊天往返后都保留', () => {
    const home = useHomeStore.getState()
    home.updateNewChat({ projectId: 'p', permissionMode: 'autonomous', planEnabled: true })
    const draft = useHomeStore.getState().session
    home.openChat('a'); home.startNewChat(); home.startNewChat()
    expect(useHomeStore.getState().session).toEqual(draft)
    home.updateNewChat({ projectId: undefined })
    expect(useHomeStore.getState().session).toMatchObject({ draftId: initial.newDraft.draftId, permissionMode: 'autonomous', planEnabled: true })
  })
  it('后台受理会轮换新草稿身份，但不抢当前聊天；返回新聊天时为空的新身份', () => {
    const id = initial.newDraft.draftId!
    useHomeStore.getState().openChat('a')
    useHomeStore.getState().finishNewChat(id, 'accepted')
    expect(useHomeStore.getState().session).toEqual({ kind: 'chat', chatId: 'a' })
    useHomeStore.getState().startNewChat()
    expect(useHomeStore.getState().session).not.toHaveProperty('draftId', id)
    expect(localStorage.getItem('cogent.new-draft')).toBe(useHomeStore.getState().newDraft.draftId)
  })
})
