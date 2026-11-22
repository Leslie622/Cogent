/** 自动约束与手动意图分开；几何临时隐藏不能卸载内容或写坏会话布局。 */
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceFrame } from '@/features/workspace/WorkspaceFrame'
import { useHomeStore } from '@/stores/home'
import { useWorkspaceStore } from '@/stores/workspace'

vi.mock('@/features/workspace/WorkspaceSurface', () => ({ WorkspaceSurface: () => null }))
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  useHomeStore.setState({ session: { kind: 'new', draftId: 'frame' } })
  useWorkspaceStore.getState().reset()
  useWorkspaceStore.getState().setScope('draft:frame')
  useWorkspaceStore.getState().newTab()
})
afterEach(() => { useWorkspaceStore.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('侧栏断点同步临时收起，放宽恢复；窄窗仍可显式打开', () => {
  const content = <textarea aria-label="保留的对话输入" defaultValue="草稿" />
  const view = render(<WorkspaceFrame visible autoCollapsed={false}>{content}</WorkspaceFrame>)
  const input = screen.getByRole('textbox', { name: '保留的对话输入' })
  const manual = useWorkspaceStore.getState().scopes['draft:frame']
  expect(input.parentElement).toHaveStyle({ paddingRight: '480px' })
  view.rerender(<WorkspaceFrame visible autoCollapsed>{content}</WorkspaceFrame>)
  expect(useWorkspaceStore.getState().autoCollapsed).toBe(true)
  expect(useWorkspaceStore.getState().scopes['draft:frame']).toBe(manual)
  expect(input.parentElement).toHaveStyle({ paddingRight: '0px' })
  act(() => { useWorkspaceStore.getState().toggle() })
  expect(useWorkspaceStore.getState().autoCollapsed).toBe(false)
  expect(input.parentElement).toHaveStyle({ paddingRight: '480px' })
  expect(screen.getByRole('textbox', { name: '保留的对话输入' })).toBe(input)
  view.rerender(<WorkspaceFrame visible autoCollapsed={false}>{content}</WorkspaceFrame>)
  expect(useWorkspaceStore.getState().scopes['draft:frame'].collapsed).toBe(false)
  act(() => { useWorkspaceStore.getState().setLayout({ collapsed: true }) })
  view.rerender(<WorkspaceFrame visible autoCollapsed>{content}</WorkspaceFrame>)
  view.rerender(<WorkspaceFrame visible autoCollapsed={false}>{content}</WorkspaceFrame>)
  expect(useWorkspaceStore.getState().scopes['draft:frame'].collapsed).toBe(true)
  expect(input.parentElement).toHaveStyle({ paddingRight: '0px' })
})
