/** IPC 边界使用实际注册器：guest/iframe 无能力，原生动作只取 Host 复核结果。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcDeps } from '../../../../src/electron/main/ipc'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => Promise<unknown>>(),
  openPath: vi.fn<(path: string) => Promise<string>>().mockResolvedValue(''),
  showItemInFolder: vi.fn(),
  showSaveDialog: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>().mockResolvedValue({ canceled: true, filePath: '' }),
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>().mockResolvedValue({ canceled: true, filePaths: [] }),
}))
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, fn: (event: IpcMainInvokeEvent, payload?: unknown) => Promise<unknown>) => mocks.handlers.set(key, fn) },
  shell: { openPath: mocks.openPath, showItemInFolder: mocks.showItemInFolder }, dialog: { showSaveDialog: mocks.showSaveDialog, showOpenDialog: mocks.showOpenDialog } }))
vi.mock('../../../../src/electron/main/ipc/settings', () => ({ readSettingsFile: () => ({ version: 1 }), writeSettingsFile: vi.fn() }))
import { fileActionRequest, registerFileIpc } from '../../../../src/electron/main/ipc/files'

const frame = {}
const sender = { mainFrame: frame }
const trusted = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
const request = vi.fn().mockResolvedValue({ path: 'C:/actual/file.txt', name: 'file.txt', kind: 'text' })
beforeEach(() => { vi.clearAllMocks(); mocks.handlers.clear(); registerFileIpc({ host: { request }, getWindow: () => ({ webContents: sender }) } as unknown as IpcDeps) })
describe('文件桌面边界', () => {
  it('guest 与 iframe 在询问 Host 前就被拒绝', async () => {
    const action = mocks.handlers.get('files:action')!
    for (const event of [{ sender: {}, senderFrame: frame }, { sender, senderFrame: {} }]) await expect(action(event as IpcMainInvokeEvent, { sessionId: 's', fileId: 'f', action: 'open' })).rejects.toThrow('主窗口顶层')
    expect(request).not.toHaveBeenCalled()
  })
  it('任意路径/命令与坏定位不能当操作参数，系统错误真实返回', async () => {
    expect(() => fileActionRequest({ action: 'exec', path: 'calc.exe' })).toThrow('不合法')
    expect(() => fileActionRequest({ sessionId: 's', fileId: 'f', action: 'open', location: { line: 0 } })).toThrow('位置')
    mocks.openPath.mockResolvedValueOnce('没有关联应用')
    await expect(mocks.handlers.get('files:action')!(trusted, { sessionId: 's', fileId: 'f', action: 'open', path: 'C:/untrusted.txt' })).rejects.toThrow('没有关联应用')
    expect(mocks.openPath).toHaveBeenCalledWith('C:/actual/file.txt')
  })
  it('另存取消返回 canceled，不伪装保存成功', async () => {
    await expect(mocks.handlers.get('files:action')!(trusted, { sessionId: 's', fileId: 'f', action: 'save' })).resolves.toEqual({ canceled: true })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

// 入口身份合同由 trusted.test.ts 直接验证；本件保留各域参数与资源 owner 回归。
vi.mock('../../../../src/electron/main/ipc/trusted', async () => {
  const { ipcMain } = await import('electron')
  return { handleTrusted: (...args: Parameters<typeof ipcMain.handle>) => ipcMain.handle(...args), registerTrustedContents: vi.fn(), checkCurrentCaller: vi.fn() }
})
