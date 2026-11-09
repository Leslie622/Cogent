/**
 * workspace 域 IPC：系统目录选择框（创建项目/工作区绑定的入口）。
 * renderer 不碰文件系统（contextIsolation 纪律）——目录浏览这种必须进
 * OS 的能力由 main 用 dialog 提供，选完只回一个字符串路径。
 */
import { dialog, ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { IpcDeps } from './index'

export function registerWorkspaceIpc({ getWindow }: IpcDeps): void {
  ipcMain.handle(IPC.workspacePickDirectory, async () => {
    // parent 可缺省（窗口尚未创建时也能选目录）：无窗即独立弹窗（两个重载口径）
    const window = getWindow()
    const options = {
      title: '选择项目文件夹',
      properties: ['openDirectory' as const]
    }
    const result = window && !window.isDestroyed()
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
