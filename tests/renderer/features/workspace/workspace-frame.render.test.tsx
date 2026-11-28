/** 自动约束与手动意图分开；几何临时隐藏不能卸载内容或写坏会话布局。
 *  工作区宽度由 Frame 按状态内联写给各消费端（shell-panes.ts）：面板与头部区块写 width，对话留位
 *  写 padding-right（首页并排时 = 面板宽，占满或非首页为 0）。 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { useState, type ReactNode, type RefObject } from 'react'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { WorkspaceFrame } from '@/features/workspace/WorkspaceFrame'
import { useHomeStore } from '@/stores/home'
import { useWorkspaceStore } from '@/stores/workspace'

const surfaceRender = vi.hoisted(() => vi.fn<(width: RefObject<number>) => void>())
vi.mock('@/features/workspace/WorkspaceSurface', async () => {
  const { memo } = await import('react')
  const { useShellPane } = await import('@/features/shell/shell-panes')
  return { WorkspaceSurface: memo(({ contentWidth }: { contentWidth: RefObject<number> }) => {
    useShellPane('workspace')
    surfaceRender(contentWidth)
    return <aside data-testid="surface" data-shell-pane="workspace" />
  }) }
})
let tabsHeader: RefObject<HTMLDivElement | null>
function Subject({ visible, autoCollapsed, children }: { visible: boolean; autoCollapsed?: boolean; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  return <main ref={setHost}><WorkspaceFrame visible={visible} autoCollapsed={autoCollapsed} tabsHeader={tabsHeader} workspaceHost={host}>{children}</WorkspaceFrame></main>
}
// 对话留位：首页并排时的右内距即面板宽
const shellWidth = () => document.querySelector<HTMLElement>('[data-workspace-chat]')!.style.paddingRight
const contentWidth = () => surfaceRender.mock.lastCall![0].current
let clientWidth: MockInstance<() => number>
let observers: ResizeObserverCallback[]
beforeEach(() => {
  surfaceRender.mockClear()
  tabsHeader = { current: null }
  observers = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback) }
    observe() {} disconnect() {}
  })
  clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  useHomeStore.setState({ session: { kind: 'new', draftId: 'frame' } })
  useWorkspaceStore.getState().reset()
  useWorkspaceStore.getState().setScope('draft:frame')
  useWorkspaceStore.getState().newTab()
})
afterEach(() => { cleanup(); useWorkspaceStore.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('收起期间内容区变宽不逐帧进状态，打开时按现量宽度', async () => {
  act(() => { useWorkspaceStore.getState().setLayout({ collapsed: true }) })
  render(<Subject visible autoCollapsed={false}>{<textarea aria-label="对话" />}</Subject>)
  // 面板懒加载，等它挂上
  await screen.findByTestId('surface')
  const renders = surfaceRender.mock.calls.length
  expect(shellWidth()).toBe('0px')
  // 会话侧栏开合：内容区每帧变宽，观察器逐帧触发
  clientWidth.mockReturnValue(300)
  act(() => { for (const callback of observers) callback([], {} as ResizeObserver) })
  expect(contentWidth()).toBe(300)
  expect(surfaceRender).toHaveBeenCalledTimes(renders)
  expect(shellWidth()).toBe('0px')
  act(() => { useWorkspaceStore.getState().toggle() })
  expect(contentWidth()).toBe(300)
  // 300 − 160（对话留位）= 140，窄于偏好宽：用的是现量值而不是收起前的旧值
  expect(shellWidth()).toBe('140px')
})

it('打开期间尺寸变化只同步布局；占满跟随容器时不反复播放开合过渡或渲染内容', async () => {
  render(<Subject visible><textarea aria-label="对话" /></Subject>)
  const surface = await screen.findByTestId('surface')
  const renders = surfaceRender.mock.calls.length
  for (const px of [1010, 1060, 1100]) {
    clientWidth.mockReturnValue(px)
    act(() => { for (const callback of observers) callback([], {} as ResizeObserver) })
  }
  expect(contentWidth()).toBe(1100)
  expect(surfaceRender).toHaveBeenCalledTimes(renders)
  expect(surface.style.width).toBe('350px')
  act(() => { useWorkspaceStore.getState().setLayout({ expanded: true }) })
  expect(surface.style.width).toBe('1100px')
  expect(surface).not.toHaveAttribute('data-shell-pane-resizing')
  clientWidth.mockReturnValue(1150)
  act(() => { for (const callback of observers) callback([], {} as ResizeObserver) })
  await act(async () => { await new Promise(requestAnimationFrame) })
  expect(surface.style.width).toBe('1150px')
  expect(surface).toHaveAttribute('data-shell-pane-resizing')
  expect(shellWidth()).toBe('0px')
  expect(surfaceRender).toHaveBeenCalledTimes(renders)
})

it('侧栏断点同步临时收起，放宽恢复；窄窗仍可显式打开', () => {
  const content = <textarea aria-label="保留的对话输入" defaultValue="草稿" />
  const view = render(<Subject visible autoCollapsed={false}>{content}</Subject>)
  const input = screen.getByRole('textbox', { name: '保留的对话输入' })
  const manual = useWorkspaceStore.getState().scopes['draft:frame']
  expect(shellWidth()).toBe('350px')
  expect(input.parentElement).toHaveStyle({ paddingRight: '350px' })
  view.rerender(<Subject visible autoCollapsed>{content}</Subject>)
  expect(useWorkspaceStore.getState().autoCollapsed).toBe(true)
  expect(useWorkspaceStore.getState().scopes['draft:frame']).toBe(manual)
  expect(shellWidth()).toBe('0px')
  act(() => { useWorkspaceStore.getState().toggle() })
  expect(useWorkspaceStore.getState().autoCollapsed).toBe(false)
  expect(shellWidth()).toBe('350px')
  expect(screen.getByRole('textbox', { name: '保留的对话输入' })).toBe(input)
  view.rerender(<Subject visible autoCollapsed={false}>{content}</Subject>)
  expect(useWorkspaceStore.getState().scopes['draft:frame'].collapsed).toBe(false)
  act(() => { useWorkspaceStore.getState().setLayout({ collapsed: true }) })
  view.rerender(<Subject visible autoCollapsed>{content}</Subject>)
  view.rerender(<Subject visible autoCollapsed={false}>{content}</Subject>)
  expect(useWorkspaceStore.getState().scopes['draft:frame'].collapsed).toBe(true)
  expect(shellWidth()).toBe('0px')
})
