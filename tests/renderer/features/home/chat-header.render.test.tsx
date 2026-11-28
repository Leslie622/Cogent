/** 对话头的面包屑与标题图标：项目会话显示「项目名 / 会话标题」；无项目会话标题前有会话图标；草稿态不显图标。 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ChatHeader } from '@/features/home/ChatHeader'
import { EMPTY_MESSAGES, emptyBucket, useChatStore } from '@/stores/chat'
import { useHomeStore } from '@/stores/home'
import { useProjectStore } from '@/stores/project'

beforeEach(() => {
  window.cogent = { onEngineEvent: () => () => {}, onBrowserEvent: () => () => {} } as unknown as typeof window.cogent
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Cogent', cwds: ['C:/cogent'], createdAt: 1 }] })
})
afterEach(() => { cleanup(); useProjectStore.setState({ projects: [] }) })

function showChat(id: string, title: string, projectId?: string) {
  useHomeStore.setState({ session: { kind: 'chat', chatId: id } })
  useChatStore.setState({
    activeSessionId: id,
    sessions: [{ id, title, ...(projectId === undefined ? {} : { projectId }), createdAt: 1, updatedAt: 1 }],
    bySession: { [id]: { ...emptyBucket(), messages: EMPTY_MESSAGES } },
  })
}

it('项目会话：面包屑是「项目名 / 会话标题」，当前页是标题', () => {
  showChat('s1', '问候交流', 'p1')
  render(<ChatHeader />)
  const breadcrumb = screen.getByRole('navigation', { name: '会话位置' })
  const project = within(breadcrumb).getByText('Cogent')
  const title = within(breadcrumb).getByText('问候交流')
  // 分隔符对无障碍隐藏，列表里只剩两段：项目名在前，标题在后
  expect(project.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(project).not.toHaveAttribute('aria-current')
  expect(title).toHaveAttribute('aria-current', 'page')
  expect(within(breadcrumb).getAllByRole('listitem')).toHaveLength(2)
  // 项目图标钮在面包屑之外、排在它前面
  expect(screen.getByRole('button', { name: '项目：Cogent' }).compareDocumentPosition(breadcrumb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('无项目的会话：标题前有会话图标，不出面包屑', () => {
  showChat('s2', '自由聊天')
  render(<ChatHeader />)
  expect(screen.queryByRole('navigation', { name: '会话位置' })).toBeNull()
  const title = screen.getByText('自由聊天')
  expect(title).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /项目：/ })).toBeNull()
  // 会话图标钮在标题之前（与项目态的文件夹图标同形同位，跨分支切换标题不横跳）
  const icon = screen.getByRole('button', { name: '会话：自由聊天' })
  expect(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('新聊天草稿态：标题落占位文案，不显会话图标', () => {
  useHomeStore.setState({ session: { kind: 'new' } })
  useChatStore.setState({ activeSessionId: null, sessions: [], bySession: {} })
  render(<ChatHeader />)
  expect(screen.getByText('新聊天')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /会话：/ })).toBeNull()
})
