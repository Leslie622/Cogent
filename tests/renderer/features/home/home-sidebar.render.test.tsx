/** 新聊天入口按主体视图去重，避免残留活动会话和在途创建撑大列表。 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { useHomeStore } from '@/stores/home'
import { useProjectStore } from '@/stores/project'
import { HomeSidebar } from '@/features/home/HomeSidebar'

vi.mock('@/features/home/ProjectDialog', () => ({ ProjectDialog: () => null }))

const initialChat = useChatStore.getState()
const initialHome = useHomeStore.getState()
const initialProject = useProjectStore.getState()
const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const oldSession = { id: 'old', title: '已有聊天', createdAt: 1, updatedAt: 1 }

beforeEach(() => {
  useChatStore.setState(initialChat, true)
  useHomeStore.setState(initialHome, true)
  useProjectStore.setState(initialProject, true)
  engineRequest.mockReset().mockImplementation((method) => {
    if (method === 'project.list') return Promise.resolve([])
    if (method === 'session.create') {
      return Promise.resolve({ id: 'created', title: '新会话', createdAt: 2, updatedAt: 2 })
    }
    throw new Error(`未预期的方法：${method}`)
  })
  window.cogent = { engineRequest } as unknown as typeof window.cogent
})

describe('侧栏新聊天入口', () => {
  it.each([false, true])('主体已是新聊天，残留旧会话=%s：重复点击不创建列表项', async (hasOld) => {
    useChatStore.setState({
      activeSessionId: hasOld ? oldSession.id : null,
      sessions: hasOld ? [oldSession] : []
    })
    render(<HomeSidebar />)
    fireEvent.click(screen.getByRole('button', { name: '新聊天' }))
    fireEvent.click(screen.getByRole('button', { name: '新聊天' }))
    await waitFor(() => expect(useProjectStore.getState().loaded).toBe(true))
    expect(engineRequest.mock.calls.map(([method]) => method)).toEqual(['project.list'])
    expect(useChatStore.getState().sessions).toEqual(hasOld ? [oldSession] : [])
    expect(useHomeStore.getState().session.kind).toBe('new')
  })

  it('从已有聊天进入新聊天，创建尚未返回时连点也只创建一次', async () => {
    useChatStore.setState({ activeSessionId: oldSession.id, sessions: [oldSession] })
    useHomeStore.getState().openChat(oldSession.id)
    render(<HomeSidebar />)
    const button = screen.getByRole('button', { name: '新聊天' })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(useChatStore.getState().sessions).toHaveLength(2))
    expect(engineRequest.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
    expect(useHomeStore.getState().session.kind).toBe('new')
  })

  it('打开的会话本身还是空白新会话时继续复用', async () => {
    const empty = { ...oldSession, title: '新会话' }
    useChatStore.setState({
      activeSessionId: empty.id,
      sessions: [empty],
      bySession: { [empty.id]: emptyBucket() }
    })
    useHomeStore.getState().openChat(empty.id)
    render(<HomeSidebar />)
    fireEvent.click(screen.getByRole('button', { name: '新聊天' }))
    await waitFor(() => expect(useProjectStore.getState().loaded).toBe(true))
    expect(engineRequest.mock.calls.map(([method]) => method)).toEqual(['project.list'])
    expect(useChatStore.getState().sessions).toEqual([empty])
    expect(useHomeStore.getState().session.kind).toBe('new')
  })
})
