/**
 * window 域 IPC：自绘 header 的窗口控制通道。
 * 无入参（动作语义由 channel 本身表达），故无需参数校验；动作只影响窗口状态，无信任风险。
 */
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { IpcDeps } from './index'

export function registerWindowIpc(getWindow: IpcDeps['getWindow']): void {
  ipcMain.handle(IPC.windowMinimize, () => getWindow()?.minimize())
  // 双击标题栏/点最大化按钮：在最大化与还原之间切换
  ipcMain.handle(IPC.windowMaximizeToggle, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IPC.windowClose, () => getWindow()?.close())
}
