import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceLauncher } from '@/features/workspace/WorkspaceLauncher'
import { useWorkspaceStore } from '@/stores/workspace'


beforeEach(() => {
  useWorkspaceStore.getState().reset()
  useWorkspaceStore.getState().setScope('s')
  useWorkspaceStore.getState().newTab()
})
afterEach(() => useWorkspaceStore.getState().reset())

describe('新标签页入口', () => {
  it('只列出已接入能力，文件打开沿用新标签替换语义', () => {
    render(<WorkspaceLauncher />)
    expect(screen.getByRole('heading', { name: '新标签页' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '打开文件导航' }))
    const scope = useWorkspaceStore.getState().scopes.s
    expect(scope.tabs).toHaveLength(1)
    expect(scope.tabs[0].kind).toBe('files')
    expect(scope.activeId).toBe(scope.tabs[0].id)
  })

  it('浏览器入口打开普通网页，不展示临时浏览和关闭历史', () => {
    const workspace = useWorkspaceStore.getState()
    const recent = workspace.openBrowser('https://closed.test')
    workspace.remove(recent)
    workspace.newTab()
    render(<WorkspaceLauncher />)
    expect(screen.queryByText('最近关闭')).toBeNull()
    expect(screen.queryByRole('button', { name: '新建临时浏览标签页' })).toBeNull()
    expect(screen.queryByText('https://closed.test')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开内置浏览器' }))
    const [normal] = useWorkspaceStore.getState().scopes.s.tabs
    expect(normal).toMatchObject({ kind: 'browser', url: '' })
    expect(normal).not.toHaveProperty('privateGroupId')
    expect(useWorkspaceStore.getState().recent).toHaveLength(1)
  })
})
