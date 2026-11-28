/** 应用头部 / 应用侧栏的悬停滑动装配：每组一个胶囊在首子位、容器 relative isolate、行带
 *  data-hover-slide，原有 hover 类不动（关掉胶囊即原样）。 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppHeader } from '@/features/shell/AppHeader'
import { AppSidebar } from '@/features/shell/AppSidebar'
import { useAppearanceStore } from '@/stores/appearance'

beforeEach(() => {
  window.cogent = {
    onWindowState: () => () => {},
    minimizeWindow: vi.fn(),
    toggleMaximizeWindow: vi.fn(),
    closeWindow: vi.fn(),
  } as unknown as typeof window.cogent
})

describe('悬停滑动装配（应用侧栏 / 应用头部）', () => {
  it('AppSidebar：三个路由钮一组；设置钮是独钮不参与；原有 hover 类未动', () => {
    const { container } = render(<AppSidebar />)
    const pills = container.querySelectorAll('.hover-slide-pill')
    expect(pills).toHaveLength(1)
    const group = pills[0].parentElement
    expect(group).toHaveClass('relative', 'isolate')
    expect(group?.firstElementChild).toBe(pills[0])
    expect(group?.querySelectorAll('[data-hover-slide]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-hover-slide]')).toHaveLength(3)
    const tasks = screen.getByRole('button', { name: '定时任务' })
    expect(tasks).toHaveAttribute('data-hover-slide')
    expect(tasks).toHaveClass('hover:bg-(--chrome-hover)')
    expect(screen.getByRole('button', { name: '首页' })).toHaveClass('hover:bg-(--chrome-active)')
  })

  it('AppHeader：左组（折叠钮 + 四个文字菜单 + 窄屏应用菜单钮）与右组（窗口控制三钮）各一组', () => {
    const { container } = render(<AppHeader sidebarCollapsed={false} onToggleSidebar={() => {}} />)
    const groups = [...container.querySelectorAll('.hover-slide-pill')].map((pill) => pill.parentElement)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveClass('relative', 'isolate')
    expect(groups[0]?.querySelectorAll('[data-hover-slide]')).toHaveLength(6)
    expect(groups[1]?.querySelectorAll('[data-hover-slide]')).toHaveLength(3)
    // 关闭钮保留自己的红色 hover 类，胶囊只负责读出并滑动
    const close = screen.getByRole('button', { name: '关闭' })
    expect(close).toHaveAttribute('data-hover-slide')
    expect(close).toHaveClass('hover:bg-destructive', 'hover:text-white')
    expect(screen.getByRole('button', { name: '应用菜单' })).toHaveAttribute('data-hover-slide')
  })

  it('外观「开启滑动动画」关闭：头部两组与侧栏都不渲染胶囊', () => {
    useAppearanceStore.setState({ hoverSlide: false })
    const { container } = render(
      <>
        <AppSidebar />
        <AppHeader sidebarCollapsed={false} onToggleSidebar={() => {}} />
      </>,
    )
    expect(container.querySelectorAll('.hover-slide-pill')).toHaveLength(0)
    useAppearanceStore.setState({ hoverSlide: true })
  })
})
