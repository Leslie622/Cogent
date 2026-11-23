/**
 * useErrorToast 测试 —— 钉错误 toast 的触发契约（对话区错误条退役，
 * toast 是 lastError 唯一呈现；呈现配方由 components/ui/sonner 的
 * showErrorToast 承担，此处 mock 掉只测触发逻辑）：
 * - 失败发生（null→文案）弹一次；
 * - 错误清除 / 同值不弹；同会话错误更新弹新文案；
 * - 切换到带历史错误的会话不弹（只在失败发生那一刻弹）；新会话再失败正常弹。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showErrorToast } from '@/components/ui/sonner'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { useErrorToast } from '@/hooks/use-error-toast'
import { useHomeStore } from '@/stores/home'

vi.mock('@/components/ui/sonner', () => ({ showErrorToast: vi.fn() }))

const showToast = vi.mocked(showErrorToast)
const SID = 's1'
const OTHER = 's2'
const initialChat = { ...useChatStore.getState() }
const initialHome = useHomeStore.getState()

/** 只写一个会话桶的 lastError，其余保持 */
function setLastError(sid: string, lastError: string | null): void {
  useChatStore.setState((state) => ({
    bySession: { ...state.bySession, [sid]: { ...emptyBucket(), runtime: { ...emptyBucket().runtime, lastError } } }
  }))
}

describe('useErrorToast', () => {
  beforeEach(() => {
    showToast.mockClear()
    useChatStore.setState(initialChat, true)
    useHomeStore.setState(initialHome, true)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('失败发生（null→文案）弹一次，错误详情传给呈现端', () => {
    useChatStore.setState({ activeSessionId: SID })
    setLastError(SID, null)
    renderHook(() => useErrorToast())
    act(() => { setLastError(SID, '连接失败') })
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('连接失败')
  })

  it('错误清除与同值不弹；同会话错误更新弹新文案', () => {
    useChatStore.setState({ activeSessionId: SID })
    setLastError(SID, null)
    renderHook(() => useErrorToast())
    act(() => { setLastError(SID, 'a') })
    act(() => { setLastError(SID, 'a') })
    act(() => { setLastError(SID, null) })
    expect(showToast).toHaveBeenCalledTimes(1)
    act(() => { setLastError(SID, 'b') })
    expect(showToast).toHaveBeenCalledTimes(2)
    expect(showToast).toHaveBeenLastCalledWith('b')
  })

  it('切换到带历史错误的会话不弹；新会话上再次失败正常弹', () => {
    useChatStore.setState({ activeSessionId: SID })
    setLastError(SID, null)
    setLastError(OTHER, '历史失败')
    renderHook(() => useErrorToast())
    act(() => { useChatStore.setState({ activeSessionId: OTHER }) })
    expect(showToast).not.toHaveBeenCalled()
    act(() => { setLastError(OTHER, '新失败') })
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it('首次提交创建会话失败时弹出错误，无需已有会话桶，仍保留新聊天', async () => {
    const view = { kind: 'new', draftId: 'pending-draft', projectId: 'project' } as const
    useHomeStore.setState({ session: view })
    const request = vi.fn().mockRejectedValue(new Error('摘要无法写入'))
    vi.stubGlobal('cogent', { engineRequest: request })
    renderHook(() => useErrorToast())

    await act(async () => { await expect(useChatStore.getState().submit('尚未发送的正文')).rejects.toThrow('摘要无法写入') })
    expect(showToast).toHaveBeenCalledExactlyOnceWith('摘要无法写入')
    expect(request).toHaveBeenCalledExactlyOnceWith('session.create', expect.objectContaining({ projectId: 'project' }))
    expect(useHomeStore.getState().session).toBe(view)
    expect(useChatStore.getState().sessions).toEqual([])
  })
})
