/**
 * window 域 IPC：自绘 header 的窗口控制通道。
 * 无入参（动作语义由 channel 本身表达），故无需参数校验；动作只影响窗口状态，无信任风险。
 * 按"发起窗口"寻址（event.sender）：控制台窗口引入后主/控制台两窗口共用这一套
 * channel，各控制各的窗口 —— 此前写死 mainWindow，第二个窗口的关闭钮会错关主窗口。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc'

export function registerWindowIpc(): void {
  const senderWindow = (event: { sender: Electron.WebContents }): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle(IPC.windowMinimize, (event) => senderWindow(event)?.minimize())
  // 双击标题栏/点最大化按钮：在最大化与还原之间切换
  ipcMain.handle(IPC.windowMaximizeToggle, (event) => {
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IPC.windowClose, (event) => senderWindow(event)?.close())
}
