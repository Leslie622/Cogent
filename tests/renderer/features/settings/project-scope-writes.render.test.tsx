/** 项目设置的回包、编辑正文与写入错误沿原作用域归属。 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { showErrorToast } from '@/components/ui/sonner'
import { McpSection } from '@/features/settings/McpSection'
import { SkillSection } from '@/features/settings/SkillSection'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import type { McpServerSummary, SkillSummary } from '@/env.d'

vi.mock('@/components/ui/sonner', () => ({ showErrorToast: vi.fn() }))

const a = 'C:/workspace-a'
const b = 'C:/workspace-b'
const initialChat = useChatStore.getState()
const initialProject = useProjectStore.getState()

beforeEach(() => {
  vi.mocked(showErrorToast).mockClear()
  useProjectStore.setState({ projects: [
    { id: 'a', name: '甲项目', cwds: [a], createdAt: 1 },
    { id: 'b', name: '乙项目', cwds: [b], createdAt: 2 }
  ] })
  useChatStore.setState({ activeSessionId: 'session-a', sessions: [
    { id: 'session-a', title: '甲', projectId: 'a', createdAt: 1, updatedAt: 1 },
    { id: 'session-b', title: '乙', projectId: 'b', createdAt: 2, updatedAt: 2 }
  ] })
})

afterEach(() => {
  cleanup()
  useChatStore.setState(initialChat, true)
  useProjectStore.setState(initialProject, true)
  vi.unstubAllGlobals()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function switchTo(project: 'a' | 'b') {
  act(() => useChatStore.setState({ activeSessionId: `session-${project}` }))
}

function mcpList(name: string) {
  const server: McpServerSummary = { name, detail: 'node', type: 'stdio', enabled: true, exposure: 'direct', def: { name, type: 'stdio', command: 'node' } }
  return { servers: [server], errors: [] }
}

function skillList(name: string) {
  const skill: SkillSummary = { name, scope: 'project', description: name, path: `C:/${name}/SKILL.md`, baseDir: `C:/${name}`, enabled: true, userDisabled: false, manualOnly: false }
  return { skills: [skill], errors: [] }
}

it('MCP 旧项目列表不能覆盖新项目，切换时未完成的写入失败归原项目', async () => {
  const oldList = deferred<ReturnType<typeof mcpList>>()
  const write = deferred<never>()
  let firstA = true
  const request = vi.fn((method: string, params: { cwd: string }) => {
    if (method === 'mcp.override') return write.promise
    if (method !== 'mcp.list') throw new Error(`未预期请求：${method}`)
    if (params.cwd === a && firstA) { firstA = false; return oldList.promise }
    return Promise.resolve(mcpList(params.cwd === b ? 'beta-server' : 'alpha-server'))
  })
  vi.stubGlobal('cogent', { engineRequest: request, onEngineEvent: vi.fn(() => () => {}) })
  render(<McpSection />)
  expect(request).toHaveBeenCalledWith('mcp.list', { cwd: a, projectId: 'a' })
  switchTo('b')
  await screen.findByRole('switch', { name: 'beta-server 启用' })
  await act(async () => { oldList.resolve(mcpList('old-server')); await oldList.promise })
  expect(screen.queryByRole('switch', { name: 'old-server 启用' })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('switch', { name: 'beta-server 启用' }))
  expect(request).toHaveBeenCalledWith('mcp.override', { cwd: b, name: 'beta-server', enabled: false })
  switchTo('a')
  await screen.findByRole('switch', { name: 'alpha-server 启用' })
  act(() => write.reject(new Error('覆盖写入失败')))
  await waitFor(() => expect(showErrorToast).toHaveBeenCalledExactlyOnceWith('乙项目的 MCP 设置：覆盖写入失败'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('技能迟到正文不能打开新项目弹窗，当前保存失败保留正文并写到原根', async () => {
  const oldBody = deferred<{ body: string; description: string }>()
  const write = deferred<never>()
  let retries = 0
  const request = vi.fn((method: string, params: { cwd: string }) => {
    if (method === 'skills.list') return Promise.resolve(skillList(params.cwd === b ? 'beta-skill' : 'alpha-skill'))
    if (method === 'skills.read') return params.cwd === a ? oldBody.promise : Promise.resolve({ body: '乙项目正文', description: '乙项目说明' })
    if (method === 'skills.save') return retries++ === 0 ? Promise.reject(new Error('正文写入失败')) : write.promise
    throw new Error(`未预期请求：${method}`)
  })
  vi.stubGlobal('cogent', { engineRequest: request })
  render(<SkillSection />)
  fireEvent.click(await screen.findByRole('button', { name: '编辑 alpha-skill' }))
  switchTo('b')
  fireEvent.click(await screen.findByRole('button', { name: '编辑 beta-skill' }))
  const dialog = await screen.findByRole('dialog', { name: '编辑技能' })
  await act(async () => { oldBody.resolve({ body: '已离开甲项目', description: '甲项目说明' }); await oldBody.promise })
  expect(within(dialog).getByDisplayValue('乙项目正文')).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  expect(await within(dialog).findByText('正文写入失败')).toBeVisible()
  expect(within(dialog).getByDisplayValue('乙项目正文')).toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('skills.save', { cwd: b, scope: 'project', name: 'beta-skill', body: '乙项目正文', description: '乙项目说明' })

  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
  switchTo('a')
  await screen.findByRole('button', { name: '编辑 alpha-skill' })
  act(() => write.reject(new Error('迟到的写入失败')))
  await waitFor(() => expect(showErrorToast).toHaveBeenCalledExactlyOnceWith('乙项目的技能设置：迟到的写入失败'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
