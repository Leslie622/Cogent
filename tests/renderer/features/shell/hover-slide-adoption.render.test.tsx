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

  it('AppHeader：左组（折叠钮 + 四个文字菜单 + 应用菜单钮）与右组（窗口控制三钮）各一组', () => {
    const tabsHeader = { current: null }
    const { container, unmount } = render(<AppHeader view="home" sidebarCollapsed={false} onToggleSidebar={() => {}} tabsHeaderRef={tabsHeader} />)
    const groups = [...container.querySelectorAll('.hover-slide-pill')].map((pill) => pill.parentElement)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveClass('relative', 'isolate')
    // 文字菜单与应用菜单钮常驻同一组，显示哪一半由容器查询按左块的实际宽度决定（jsdom 不求值）：
    // 折叠钮 + 4 + 1，右组 3；隐藏的那一半是 display:none，行宽为 0 时胶囊层视为不可见
    expect(groups[0]?.querySelectorAll('[data-hover-slide]')).toHaveLength(6)
    expect(groups[0]?.querySelectorAll('.app-header-menus [data-hover-slide]')).toHaveLength(4)
    expect(groups[0]?.querySelectorAll('.app-header-menu-button [data-hover-slide]')).toHaveLength(1)
    expect(groups[1]?.querySelectorAll('[data-hover-slide]')).toHaveLength(3)
    // 关闭钮保留自己的红色 hover 类，胶囊只负责读出并滑动
    const close = screen.getByRole('button', { name: '关闭' })
    expect(close).toHaveAttribute('data-hover-slide')
    expect(close).toHaveClass('hover:bg-destructive', 'hover:text-white')
    for (const name of ['应用菜单', '文件', '编辑', '视图', '帮助']) expect(screen.getByRole('button', { name })).toHaveAttribute('data-hover-slide')
    unmount()

    const collapsed = render(<AppHeader view="home" sidebarCollapsed onToggleSidebar={() => {}} tabsHeaderRef={tabsHeader} />)
    expect(collapsed.container.querySelectorAll('.hover-slide-pill')).toHaveLength(2)
    // 折叠状态只换折叠开关的语义；两半的结构不变 —— 拖拽拖过折叠阈值时状态还没提交，显示得跟宽度走
    expect(collapsed.container.querySelectorAll('[data-hover-slide]')).toHaveLength(9)
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toHaveAttribute('data-hover-slide')
    expect(collapsed.container.querySelectorAll('.app-header-menus [data-hover-slide]')).toHaveLength(4)
    expect(collapsed.container.querySelectorAll('.app-header-menu-button [data-hover-slide]')).toHaveLength(1)
  })

  it('外观「开启滑动动画」关闭：头部两组与侧栏都不渲染胶囊', () => {
    useAppearanceStore.setState({ hoverSlide: false })
    const { container } = render(
      <>
        <AppSidebar />
        <AppHeader view="home" sidebarCollapsed={false} onToggleSidebar={() => {}} tabsHeaderRef={{ current: null }} />
      </>,
    )
    expect(container.querySelectorAll('.hover-slide-pill')).toHaveLength(0)
    useAppearanceStore.setState({ hoverSlide: true })
  })
})
