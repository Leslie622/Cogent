import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../../../src/shared/ipc'

const electron = vi.hoisted(() => {
  const buildWindow = () => ({
    on: vi.fn<(event: string, listener: () => void) => void>(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn() }
  })
  const windows: ReturnType<typeof buildWindow>[] = []
  const createWindow = vi.fn(() => {
    const window = buildWindow()
    windows.push(window)
    return window
  })
  return {
    createWindow,
    windows,
    handle: vi.fn<(channel: string, handler: () => void) => void>()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function () { return electron.createWindow() }),
  ipcMain: { handle: electron.handle },
  shell: { openExternal: vi.fn() }
}))

async function registerOpen(): Promise<() => void> {
  const { registerConsoleIpc } = await import('../../../../src/electron/main/ipc/console')
  registerConsoleIpc()
  expect(electron.handle.mock.calls[0][0]).toBe(IPC.consoleOpen)
  return electron.handle.mock.calls[0][1]
}

describe('控制台窗口入口', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    electron.windows.length = 0
  })

  it('首次打开在窗口就绪后显示', async () => {
    const open = await registerOpen()
    open()
    const window = electron.windows[0]
    expect(window.show).not.toHaveBeenCalled()
    const ready = window.on.mock.calls.find(([event]: [string, () => void]) => event === 'ready-to-show')!
    ready[1]()
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('最小化后再次打开，先恢复再聚焦，复用原窗口', async () => {
    const open = await registerOpen()
    open()
    const window = electron.windows[0]
    window.isMinimized.mockReturnValue(true)
    open()
    expect(electron.createWindow).toHaveBeenCalledOnce()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.restore.mock.invocationCallOrder[0]).toBeLessThan(window.focus.mock.invocationCallOrder[0])
  })

  it('非最小化窗口再次打开时只聚焦，保留原窗口状态', async () => {
    const open = await registerOpen()
    open()
    const window = electron.windows[0]
    open()
    expect(electron.createWindow).toHaveBeenCalledOnce()
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('窗口关闭后可重新创建', async () => {
    const open = await registerOpen()
    open()
    const window = electron.windows[0]
    const closed = window.on.mock.calls.find(([event]: [string, () => void]) => event === 'closed')!
    closed[1]()
    open()
    expect(electron.createWindow).toHaveBeenCalledTimes(2)
    expect(window.focus).not.toHaveBeenCalled()
  })
})

// 入口身份合同由 trusted.test.ts 直接验证；本件保留各域参数与资源 owner 回归。
vi.mock('../../../../src/electron/main/ipc/trusted', async () => {
  const { ipcMain } = await import('electron')
  return { handleTrusted: (...args: Parameters<typeof ipcMain.handle>) => ipcMain.handle(...args), registerTrustedContents: vi.fn(), checkCurrentCaller: vi.fn() }
})
