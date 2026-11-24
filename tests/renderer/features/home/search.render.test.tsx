/** 真实 Command 查询交互与导航所有权；可控 Promise 验证旧响应不能覆盖新查询。 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionSearch } from '@/features/home/search/SessionSearch'
import { useSearchStore } from '@/stores/search'
import { emptyBucket, useChatStore } from '@/stores/chat'
import { useHomeStore } from '@/stores/home'
import { useProjectStore } from '@/stores/project'
import { renderedSearchRanges } from '@/features/home/search/SearchNavigator'
import type { SearchPage, SearchResult } from '@shared/session-search'

const bridge = window.cogent
const initialChat = useChatStore.getState(), initialHome = useHomeStore.getState(), initialProjects = useProjectStore.getState()
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
const result = (id: string): SearchResult => ({ session: { id, title: `标题${id}`, createdAt: 1, updatedAt: 2 }, titleRanges: [], hits: [], moreHits: false })
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  useSearchStore.setState({ open: false, navigation: null, target: null, serial: 0, busy: false, error: null })
  useChatStore.setState({ sessions: [], activeSessionId: null, bySession: {} })
  useProjectStore.setState({ projects: [{ id: 'project', name: 'Cogent', cwds: ['/test'], createdAt: 1 }] })
})
afterEach(() => { useSearchStore.getState().clear(); useSearchStore.setState({ open: false }); useChatStore.setState(initialChat); useHomeStore.setState(initialHome); useProjectStore.setState(initialProjects); window.cogent = bridge; vi.unstubAllGlobals() })

it('聊天分区每会话只一项、摘要内嵌，查询中显示 spinner，旧响应和 IME 不误选', async () => {
  const pending = new Map<string, ReturnType<typeof deferred<SearchPage>>>()
  window.cogent = { ...bridge, engineRequest: vi.fn((_method: string, params: { query: string }) => {
    const task = deferred<SearchPage>(); pending.set(params.query, task); return task.promise
  }) } as typeof bridge
  render(<SessionSearch />)
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  const input = await screen.findByRole('combobox', { name: '搜索聊天' })
  await waitFor(() => expect(pending.has('')).toBe(true))
  expect(window.cogent.engineRequest).toHaveBeenCalledWith('session.search', { query: '' })
  expect(screen.queryByRole('combobox', { name: '搜索项目' })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByText('选择')).toBeVisible()
  expect(screen.getByText('打开')).toBeVisible()
  expect(screen.getByText('Esc')).toBeVisible()
  expect(screen.getByText('关闭')).toBeVisible()
  await act(async () => { pending.get('')!.resolve({ items: [result('recent'), { ...result('project'), session: { ...result('project').session, projectId: 'project' } }], issues: [] }); await Promise.resolve() })
  const recentRows = screen.getAllByRole('option')
  expect(recentRows[0]).toHaveTextContent(/^标题recent$/)
  expect(recentRows[1]).toHaveTextContent(/^标题projectCogent$/)
  expect(screen.queryByText('标题与聊天正文')).toBeNull()
  expect(screen.queryByText('未归类', { exact: true })).toBeNull()
  fireEvent.change(input, { target: { value: '旧' } })
  await waitFor(() => expect(pending.has('旧')).toBe(true))
  fireEvent.change(input, { target: { value: '新' } })
  await waitFor(() => expect(pending.has('新')).toBe(true))
  expect(screen.getByRole('status', { name: '正在搜索' })).toBeVisible()
  await act(async () => { pending.get('新')!.resolve({ items: [{ ...result('new'), moreHits: true, hits: [
    { key: 'first', role: 'assistant', snippet: '第一处命中摘要', ranges: [], anchor: { sourceId: 'first', offset: 0 } },
    { key: 'second', role: 'user', snippet: '另一处命中摘要', ranges: [], anchor: { sourceId: 'second', offset: 0 } }
  ] }], issues: [] }); await Promise.resolve() })
  expect(await screen.findByText('标题new')).toBeVisible()
  expect(screen.getByRole('group', { name: '聊天' })).toBeVisible()
  const rows = screen.getAllByRole('option')
  expect(rows).toHaveLength(1)
  expect(within(rows[0]).getByText('第一处命中摘要')).toBeVisible()
  expect(screen.queryByText('助手', { exact: true })).toBeNull()
  expect(screen.queryByText('用户', { exact: true })).toBeNull()
  expect(screen.queryByRole('status', { name: '正在搜索' })).toBeNull()
  await act(async () => { pending.get('旧')!.resolve({ items: [result('old')], issues: [] }); await Promise.resolve() })
  expect(screen.queryByText('标题old')).toBeNull()
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(useSearchStore.getState().open).toBe(true)
  fireEvent.compositionEnd(input)
})

it('已有缓存的搜索导航不用历史 ID，用户切会话后不接受迟到定位', async () => {
  const page = deferred<SearchPage>()
  window.cogent = { ...bridge, engineRequest: vi.fn(() => page.promise) } as typeof bridge
  useChatStore.setState({ activeSessionId: 'a', bySession: { a: emptyBucket(), b: emptyBucket() } })
  const selecting = useSearchStore.getState().select(result('a'), '你好')
  await act(async () => { await Promise.resolve() })
  useChatStore.setState({ activeSessionId: 'b' }); useHomeStore.getState().openChat('b')
  page.resolve({ items: [{ ...result('a'), hits: [{ key: 'live', role: 'assistant', snippet: '你好', ranges: [{ start: 0, end: 2 }], anchor: { sourceId: 'entry', offset: 0 } }] }], issues: [] })
  await selecting
  expect(useChatStore.getState().activeSessionId).toBe('b')
  expect(useSearchStore.getState().target).toBeNull()
})

it('跨语法节点与代码节点建立范围，不插入节点或破坏选区', () => {
  const root = document.createElement('div')
  root.innerHTML = '<div data-slot="markdown-root">你<strong>好</strong><pre><code>hello</code></pre><button>你好</button></div>'
  document.body.append(root)
  const before = root.innerHTML
  const ranges = renderedSearchRanges(root, '你好')
  expect(ranges.map((range) => range.toString())).toEqual(['你好'])
  expect(renderedSearchRanges(root, 'HELLO')[0].toString()).toBe('hello')
  expect(root.innerHTML).toBe(before)
  root.remove()
})

it('搜索选择过程中删除会话，迟到历史不重建消息桶', async () => {
  const history = deferred<{ messages: never[] }>()
  window.cogent = { ...bridge, engineRequest: vi.fn((method: string) => method === 'session.messages' ? history.promise : Promise.resolve({ deleted: true })) } as typeof bridge
  const selecting = useChatStore.getState().selectSession('deleted')
  await useChatStore.getState().deleteSession('deleted')
  history.resolve({ messages: [] })
  await selecting
  expect(useChatStore.getState().bySession.deleted).toBeUndefined()
})
