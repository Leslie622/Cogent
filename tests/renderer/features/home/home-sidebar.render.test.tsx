/** 侧栏导航：新聊天去重、会话热区、独立动作、归档撤销与项目移除确认。 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { useHomeStore } from '@/stores/home'
import { useProjectStore } from '@/stores/project'
import { HomeSidebar } from '@/features/home/HomeSidebar'
import { EMPTY_DRAFT, useAttachmentStore } from '@/stores/attachments'

vi.mock('@/features/home/ProjectDialog', () => ({ ProjectDialog: () => null }))

// 类型化 mock（hoisted：vi.mock 工厂提升到 import 前，普通 const 引用不到）
const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<(message: string, options?: unknown) => string | number>()
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))

const initialChat = useChatStore.getState()
const initialHome = useHomeStore.getState()
const initialProject = useProjectStore.getState()
const engineRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const oldSession = { id: 'old', title: '已有聊天', createdAt: 1, updatedAt: 1 }

beforeEach(() => {
  useChatStore.setState(initialChat, true)
  useHomeStore.setState(initialHome, true)
  useProjectStore.setState(initialProject, true)
  toastSuccess.mockClear()
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

  it('从已有聊天进入新聊天，连点也不创建空会话', async () => {
    useChatStore.setState({ activeSessionId: oldSession.id, sessions: [oldSession] })
    useHomeStore.getState().openChat(oldSession.id)
    render(<HomeSidebar />)
    const button = screen.getByRole('button', { name: '新聊天' })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(useProjectStore.getState().loaded).toBe(true))
    expect(useChatStore.getState().sessions).toEqual([oldSession])
    expect(useChatStore.getState().activeSessionId).toBeNull()
    expect(engineRequest.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(0)
    expect(useHomeStore.getState().session.kind).toBe('new')
  })

  it('新聊天写正文和附文件后，A→新聊天往返仍取同一草稿', async () => {
    const view = useHomeStore.getState().session
    expect(view.kind).toBe('new')
    if (view.kind !== 'new') throw new Error('测试前置错误')
    const draftId = `new-${view.draftId}`
    const items = [{ key: 'file', name: '未发附件.txt', size: 12, status: 'importing' as const }]
    useAttachmentStore.setState({ drafts: { [draftId]: { ...EMPTY_DRAFT, loaded: true, text: '未发正文', items } } })
    useChatStore.setState({ activeSessionId: oldSession.id, sessions: [oldSession], bySession: { [oldSession.id]: emptyBucket() } })
    useHomeStore.getState().openChat(oldSession.id)
    render(<HomeSidebar />)
    fireEvent.click(screen.getByRole('button', { name: '新聊天' }))
    expect(useHomeStore.getState().session).toEqual(view)
    fireEvent.click(screen.getByRole('button', { name: '已有聊天' }))
    fireEvent.click(screen.getByRole('button', { name: '新聊天' }))
    expect(useHomeStore.getState().session).toEqual(view)
    expect(useAttachmentStore.getState().drafts[draftId]).toMatchObject({ text: '未发正文', items })
    expect(useChatStore.getState().sessions).toEqual([oldSession])
    await waitFor(() => expect(useProjectStore.getState().loaded).toBe(true))
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

describe('会话行点击区域', () => {
  it.each(['最近', '置顶', '项目', '等待确认'])('%s会话的空白和缩进属于主按钮热区', async (kind) => {
    const chat = {
      ...oldSession,
      ...(kind === '置顶' && { pinnedAt: 1 }),
      ...(kind === '项目' && { projectId: 'project' })
    }
    const bucket = emptyBucket()
    if (kind === '等待确认') {
      bucket.pendingApprovals = [{ requestId: 'approval', toolName: 'write', toolKind: 'write', summary: '写文件' }]
    }
    useChatStore.setState({ sessions: [chat], bySession: { [chat.id]: bucket } })
    if (kind === '项目') {
      engineRequest.mockResolvedValue([{ id: 'project', name: '项目一', cwds: ['C:/project'], createdAt: 1, updatedAt: 1 }])
    }
    render(<HomeSidebar />)
    const button = await screen.findByRole('button', { name: /已有聊天/ })
    // jsdom 不做坐标命中；钉住热区布局契约，避免行高或缩进再次留在按钮之外。
    expect(button).toHaveClass('h-full', 'flex-1', kind === '项目' ? 'pl-8' : 'pl-2')
    expect(button.parentElement).not.toHaveClass('pl-2', 'pl-8', 'pr-2')
    fireEvent.click(kind === '等待确认' ? screen.getByText('等待确认') : button)
    expect(useChatStore.getState().activeSessionId).toBe(chat.id)
    expect(useHomeStore.getState().session).toEqual({ kind: 'chat', chatId: chat.id })
    await waitFor(() => expect(useProjectStore.getState().loaded).toBe(true))
  })

  it.each(['置顶聊天', '归档聊天'])('%s只执行自身操作，不选中会话', async (name) => {
    const setPinned = vi.fn().mockResolvedValue(undefined)
    const archive = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({ sessions: [oldSession], setPinned, archive })
    render(<HomeSidebar />)
    fireEvent.click(screen.getByRole('button', { name }))
    expect(name === '置顶聊天' ? setPinned : archive).toHaveBeenCalledExactlyOnceWith(oldSession.id, true)
    expect(useChatStore.getState().activeSessionId).toBeNull()
    expect(useHomeStore.getState().session.kind).toBe('new')
    await waitFor(() => expect(useProjectStore.getState().loaded).toBe(true))
  })

  it('归档成功弹带撤销的 toast；撤销走恢复，非活动会话不带视图还原', async () => {
    const archive = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({ sessions: [oldSession], archive, selectSession })
    render(<HomeSidebar />)
    fireEvent.click(screen.getByRole('button', { name: '归档聊天' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    const [message, options] = toastSuccess.mock.calls[0]
    expect(message).toBe('已归档')
    const opts = options as { description?: string; action: { label: string; onClick: () => void } }
    expect(opts.description).toBe('已有聊天')
    expect(opts.action.label).toBe('撤销')
    opts.action.onClick()
    await waitFor(() => expect(archive).toHaveBeenCalledTimes(2))
    expect(archive).toHaveBeenLastCalledWith(oldSession.id, false)
    // 归档的不是活动会话（activeSessionId 为 null）：撤销不替用户开会话
    expect(selectSession).not.toHaveBeenCalled()
  })
})

describe('聊天右键重命名', () => {
  it.each(['最近', '置顶', '项目'])('%s会话右键打开预填弹窗，保存后更新名称且不切换会话', async (kind) => {
    const user = userEvent.setup()
    const chat = { ...oldSession, ...(kind === '置顶' && { pinnedAt: 1 }), ...(kind === '项目' && { projectId: 'project' }) }
    useChatStore.setState({ sessions: [chat] })
    engineRequest.mockImplementation((method, params) => {
      if (method === 'project.list') return Promise.resolve(kind === '项目' ? [{ id: 'project', name: '项目一', cwds: ['C:/project'], createdAt: 1 }] : [])
      if (method === 'session.rename') return Promise.resolve({ summary: { ...chat, title: (params as { title: string }).title, titleManual: true } })
      throw new Error(`未预期的方法：${method}`)
    })
    render(<HomeSidebar />)
    fireEvent.contextMenu(await screen.findByRole('button', { name: '已有聊天' }))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const input = await screen.findByRole('textbox', { name: '聊天名称' })
    expect(input).toHaveValue(oldSession.title)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '  自定义标题  ' } })
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(engineRequest).toHaveBeenCalledWith('session.rename', { sessionId: oldSession.id, title: '自定义标题' })
    expect(screen.getByRole('button', { name: '自定义标题' })).toBeInTheDocument()
    expect(useChatStore.getState().activeSessionId).toBeNull()
  })
})

describe('项目移除确认', () => {
  const project = { id: 'project', name: '项目一', cwds: ['C:/project'], createdAt: 1 }

  it.each([
    ['普通', '更多'], ['普通', '右键'], ['置顶', '更多'], ['置顶', '右键'],
  ])('%s项目从%s入口先确认，取消不请求、不通知', async (kind, entry) => {
    const user = userEvent.setup()
    const target = { ...project, ...(kind === '置顶' && { pinnedAt: 1 }) }
    engineRequest.mockResolvedValue([target])
    render(<HomeSidebar />)
    const row = await screen.findByRole('button', { name: project.name })
    if (entry === '右键') fireEvent.contextMenu(row)
    else await user.click(within(row.parentElement!).getByRole('button', { name: '更多' }))
    await user.click(await screen.findByRole('menuitem', { name: '移除项目' }))
    const dialog = await screen.findByRole('alertdialog', { name: '移除项目？' })
    expect(dialog).toHaveTextContent('项目「项目一」')
    expect(dialog).toHaveTextContent('项目中的聊天和本地文件会保留')
    expect(engineRequest).not.toHaveBeenCalledWith('project.delete', expect.anything())
    expect(toastSuccess).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(engineRequest).not.toHaveBeenCalledWith('project.delete', expect.anything())
    expect(useProjectStore.getState().projects).toEqual([target])
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('确认后等待请求完成才通知，在途不能重复提交或关闭，成功保留聊天', async () => {
    const user = userEvent.setup()
    let resolveDelete!: () => void
    const pending = new Promise<void>((resolve) => { resolveDelete = resolve })
    engineRequest.mockImplementation((method) => {
      if (method === 'project.list') return Promise.resolve([project])
      if (method === 'project.delete') return pending
      throw new Error(`未预期的方法：${method}`)
    })
    const chat = { ...oldSession, projectId: project.id }
    useChatStore.setState({ sessions: [chat] })
    render(<HomeSidebar />)
    fireEvent.contextMenu(await screen.findByRole('button', { name: project.name }))
    await user.click(await screen.findByRole('menuitem', { name: '移除项目' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: '移除项目' }))
    const confirm = within(dialog).getByRole('button', { name: '移除中…' })
    expect(confirm).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
    await user.click(confirm)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(engineRequest.mock.calls.filter(([method]) => method === 'project.delete')).toEqual([
      ['project.delete', { projectId: project.id }],
    ])
    expect(useProjectStore.getState().projects).toEqual([project])
    expect(toastSuccess).not.toHaveBeenCalled()
    await act(async () => { resolveDelete(); await pending })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: project.name })).not.toBeInTheDocument()
    expect(useProjectStore.getState().projects).toEqual([])
    expect(useChatStore.getState().sessions).toEqual([chat])
    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('项目已移除')
  })

  it('移除失败保留项目和弹窗、显示错误，重试成功才通知', async () => {
    const user = userEvent.setup()
    const remove = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("Error invoking remote method 'engine:request': Error: 磁盘写入失败"))
      .mockResolvedValueOnce(undefined)
    engineRequest.mockImplementation((method) => {
      if (method === 'project.list') return Promise.resolve([project])
      if (method === 'project.delete') return remove()
      throw new Error(`未预期的方法：${method}`)
    })
    render(<HomeSidebar />)
    fireEvent.contextMenu(await screen.findByRole('button', { name: project.name }))
    await user.click(await screen.findByRole('menuitem', { name: '移除项目' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: '移除项目' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^磁盘写入失败$/)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(useProjectStore.getState().projects).toEqual([project])
    expect(toastSuccess).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '移除项目' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(remove).toHaveBeenCalledTimes(2)
    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('项目已移除')
  })
})
