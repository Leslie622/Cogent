/** 设置搜索组件交互、定位滚动、高亮自动淡出与异步挂载测试。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsMain } from '@/features/settings/SettingsMain'
import { SettingsSidebar } from '@/features/settings/SettingsSidebar'
import { useChatStore } from '@/stores/chat'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'

const bridge = window.cogent

function resetSettingsStore() {
  useSettingsStore.setState({
    section: 'general',
    query: '',
    viewMode: 'detail',
    locateRequest: null,
    navToken: 0,
    navReason: 'init',
  })
}

beforeEach(() => {
  resetSettingsStore()
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  }
  window.cogent = {
    ...bridge,
    platform: 'win32',
    backdropSupported: false,
    engineRequest: vi.fn().mockResolvedValue({ enabled: true, servers: [], errors: [] }),
    getSystemNotifyStatus: vi.fn().mockResolvedValue({ enabled: true }),
    getStorageUsage: vi.fn().mockResolvedValue({ root: 'C:\\Users\\test\\.cogent', totalBytes: 0, entries: [] }),
  } as typeof window.cogent
})

afterEach(() => {
  window.cogent = bridge
  cleanup()
  resetSettingsStore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('输入关键词过滤左侧分组，点左侧页从顶部浏览，点结果「打开」定位并高亮行后自动淡出', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const scrollIntoViewMock = vi.fn()
  HTMLElement.prototype.scrollIntoView = scrollIntoViewMock

  render(
    <div>
      <SettingsSidebar />
      <SettingsMain />
    </div>,
  )

  const searchInput = screen.getByRole('textbox', { name: '搜索设置' })
  await user.type(searchInput, '字体风格')

  // 左侧只保留命中的「外观」及所属「基础设置」分组，隐藏「Agent 能力」
  expect(screen.getByText('基础设置')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '外观' })).toBeInTheDocument()
  expect(screen.queryByText('Agent 能力')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '常规' })).not.toBeInTheDocument()

  // 右侧展示搜索结果及别名匹配说明
  expect(screen.getByRole('heading', { name: '搜索结果' })).toBeInTheDocument()
  expect(screen.getByText(/匹配关键词/)).toBeInTheDocument()

  // 点击左侧「外观」：保留搜索词，进入完整外观页并出现返回入口
  await user.click(screen.getByRole('button', { name: '外观' }))
  expect(screen.getByRole('heading', { name: '外观' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '返回搜索结果' })).toBeInTheDocument()
  expect(searchInput).toHaveValue('字体风格')
  expect(scrollIntoViewMock).not.toHaveBeenCalled()

  // 返回搜索结果，再点「打开 内容字体」
  await user.click(screen.getByRole('button', { name: '返回搜索结果' }))
  await user.click(screen.getByRole('button', { name: '打开 内容字体' }))

  const targetRow = document.querySelector('[data-search-id="appearance.content-font"]') as HTMLElement
  expect(targetRow).not.toBeNull()
  expect(targetRow).toHaveAttribute('data-search-highlighted', 'true')
  expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'center' })
  expect(document.activeElement).toBe(targetRow)

  // 高亮在定时器到期后自动淡出，且过程中未触发任何配置写入
  act(() => {
    vi.advanceTimersByTime(2700)
  })
  expect(targetRow).not.toHaveAttribute('data-search-highlighted')
  expect(window.cogent.engineRequest).not.toHaveBeenCalledWith('session.titleSettings.set', expect.anything())
})

it('侧栏折叠时在主内容顶部提供同源搜索框与返回入口，IME 组词期间 Escape 不清词', async () => {
  const user = userEvent.setup()
  render(<SettingsMain sidebarCollapsed />)

  const input = screen.getByRole('textbox', { name: '搜索设置' })
  await user.type(input, '快捷键')

  expect(screen.getByRole('heading', { name: '搜索结果' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '打开 键盘快捷键' })).toBeInTheDocument()

  // 组词期间按 Escape 不清空
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(input).toHaveValue('快捷键')

  // 结束组词后按 Escape 清空
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(input).toHaveValue('')
})

it('MCP 从项目上下文打开用户级配置行时自动切到本机·用户并等待异步加载后定位', async () => {
  const user = userEvent.setup()
  const scrollIntoViewMock = vi.fn()
  HTMLElement.prototype.scrollIntoView = scrollIntoViewMock

  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'Demo', cwds: ['C:\\repo'] }],
  } as never)
  useChatStore.setState({
    activeSessionId: 's1',
    sessions: [{ id: 's1', projectId: 'p1' }],
  } as never)

  let resolveList!: (val: { servers: unknown[]; errors: string[] }) => void
  const listPromise = new Promise<{ servers: unknown[]; errors: string[] }>((resolve) => {
    resolveList = resolve
  })

  window.cogent = {
    ...window.cogent,
    engineRequest: vi.fn((method: string) => {
      if (method === 'mcp.list') return listPromise
      if (method === 'attachments.media') return Promise.resolve({})
      return Promise.resolve({})
    }),
  } as typeof window.cogent

  render(<SettingsMain sidebarCollapsed />)

  await user.type(screen.getByRole('textbox', { name: '搜索设置' }), '图片分析')
  await user.click(screen.getByRole('button', { name: '打开 图片分析' }))

  // 列表尚未返回前，定位尚未被消费
  expect(useSettingsStore.getState().locateRequest?.consumed).toBe(false)

  act(() => {
    resolveList({ servers: [], errors: [] })
  })

  await waitFor(() => {
    const row = document.querySelector('[data-search-id="connections.media-image"]')
    expect(row).not.toBeNull()
    expect(row).toHaveAttribute('data-search-highlighted', 'true')
  })
  expect(useSettingsStore.getState().locateRequest?.consumed).toBe(true)
})

it('切走并切回已访问设置页时保留分区实例，Slider 与异步 Switch 首帧不播过渡动画', () => {
  render(<SettingsMain />)

  // 首帧「自动生成会话名称」开关在异步就绪前禁用过渡
  const autoTitleSwitch = screen.getByRole('switch', { name: '自动生成会话名称' })
  expect(autoTitleSwitch.className).toContain('transition-none')

  // 切到外观页后切回常规页，常规页 DOM 节点保持同一实例（未被卸载重挂载）
  act(() => {
    useSettingsStore.getState().setSection('appearance')
  })
  expect(screen.getByRole('heading', { name: '外观' })).toBeInTheDocument()

  act(() => {
    useSettingsStore.getState().setSection('general')
  })
  expect(screen.getByRole('switch', { name: '自动生成会话名称' })).toBe(autoTitleSwitch)
})
