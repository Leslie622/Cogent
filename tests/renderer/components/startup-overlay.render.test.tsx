/** 启动遮罩的最短时长、完整加载交接、失败出口与 StrictMode 生命周期。 */
import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '@/App'

const { engineLoad, chatLoad, bindEvents, unbindEvents, engineState } = vi.hoisted(() => ({
  engineLoad: vi.fn<() => Promise<void>>(),
  chatLoad: vi.fn<() => Promise<void>>(),
  bindEvents: vi.fn(),
  unbindEvents: vi.fn(),
  engineState: { engineError: null as string | null }
}))

vi.mock('@/stores/engine', () => ({
  useEngineStore: Object.assign(
    (select: (state: typeof engineState) => unknown) => select(engineState),
    { getState: () => ({ load: engineLoad }) }
  )
}))
vi.mock('@/stores/chat', () => ({
  bindEngineEvents: bindEvents,
  useChatStore: Object.assign(
    (select: (state: { loadError: null }) => unknown) => select({ loadError: null }),
    { getState: () => ({ load: chatLoad }) }
  )
}))
vi.mock('@/features/shell/AppShell', () => ({ AppShell: () => <button>页面操作</button> }))
vi.mock('@/features/shell/CloseAskDialog', () => ({ CloseAskDialog: () => null }))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))
vi.mock('@/hooks/use-error-toast', () => ({ useErrorToast: () => {} }))
vi.mock('@/hooks/use-scrollbar-auto-hide', () => ({ useScrollbarAutoHide: () => {} }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

beforeEach(() => {
  vi.useFakeTimers()
  engineState.engineError = null
  engineLoad.mockReset().mockResolvedValue(undefined)
  chatLoad.mockReset().mockResolvedValue(undefined)
  unbindEvents.mockReset()
  bindEvents.mockReset().mockReturnValue(unbindEvents)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('快速初始化也展示满两秒，淡出结束才恢复页面交互，页面不重挂', async () => {
  const { container } = render(<App />)
  const page = screen.getByRole('button', { name: '页面操作', hidden: true })
  const content = page.parentElement!
  const overlay = container.querySelector('[data-slot="startup-overlay"]')!
  expect(content).toHaveAttribute('inert')
  expect(screen.queryByRole('button', { name: '页面操作' })).not.toBeInTheDocument()
  expect(screen.getByRole('status', { name: '正在初始化引擎' })).toBeInTheDocument()
  await advance(1999)
  expect(overlay).toHaveAttribute('data-state', 'loading')
  await advance(1)
  expect(overlay).toHaveAttribute('data-state', 'fading')
  await advance(299)
  expect(content).toHaveAttribute('inert')
  expect(overlay).toBeInTheDocument()
  await advance(1)
  expect(overlay).not.toBeInTheDocument()
  expect(content).not.toHaveAttribute('inert')
  expect(screen.getByRole('button', { name: '页面操作' })).toBe(page)
})

it.each(['engine', 'chat'])('超过两秒仍等待 %s 完整加载，完成后直接淡出', async (pending) => {
  const load = deferred()
  ;(pending === 'engine' ? engineLoad : chatLoad).mockReturnValue(load.promise)
  const { container } = render(<App />)
  const overlay = container.querySelector('[data-slot="startup-overlay"]')!
  await advance(4000)
  expect(overlay).toHaveAttribute('data-state', 'loading')
  await act(async () => { load.resolve(); await load.promise })
  expect(overlay).toHaveAttribute('data-state', 'fading')
  await advance(300)
  expect(overlay).not.toBeInTheDocument()
})

it('初始化失败后撤去遮罩，保留真实错误与重试入口', async () => {
  vi.stubGlobal('cogent', { getStatus: vi.fn().mockResolvedValue({ state: 'failed', error: 'Host 启动失败' }) })
  engineLoad.mockImplementation(() => {
    engineState.engineError = 'Host 启动失败'
    return Promise.resolve()
  })
  render(<App />)
  await act(async () => { await Promise.resolve() })
  await advance(2000)
  await advance(300)
  expect(screen.queryByRole('status', { name: '正在初始化引擎' })).not.toBeInTheDocument()
  expect(screen.getByText('引擎服务不可用，对话与模型目录未加载')).toBeVisible()
  expect(screen.getByRole('button', { name: '重试' })).toBeVisible()
  expect(screen.getByText(/Host 启动失败/)).toBeVisible()
})

it('StrictMode 旧初始化的迟到完成不能结束当前等待，卸载清理订阅与定时器', async () => {
  const previous = deferred()
  const current = deferred()
  engineLoad.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
  const { container, unmount } = render(<StrictMode><App /></StrictMode>)
  const overlay = container.querySelector('[data-slot="startup-overlay"]')!
  expect(unbindEvents).toHaveBeenCalledTimes(1)
  await advance(2500)
  await act(async () => { previous.resolve(); await previous.promise })
  expect(overlay).toHaveAttribute('data-state', 'loading')
  await act(async () => { current.resolve(); await current.promise })
  expect(overlay).toHaveAttribute('data-state', 'fading')
  unmount()
  expect(unbindEvents).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
