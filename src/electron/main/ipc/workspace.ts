/**
 * workspace 域 IPC：系统目录选择框（创建项目/工作区绑定的入口）+ 系统打开。
 * renderer 不碰文件系统（contextIsolation 纪律）——目录浏览这类必须进
 * OS 的能力由 main 用 dialog/shell 提供，选完只回一个字符串路径。
 */
import { dialog, ipcMain, shell } from 'electron'
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

  // 系统默认程序打开（目录 = 资源管理器）。IPC 是信任边界（约定 §1.1）：入口
  // 校验形状即拒收非字符串；打开失败（如目录已被删）是外部世界常态 —— 不抛，
  // 错误串原样返回由调用方呈现，与 pickDirectory 的 null 语义同风格
  ipcMain.handle(IPC.shellOpenPath, async (_event, path: unknown) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('shell:open-path requires a non-empty string path')
    }
    const error = await shell.openPath(path)
    return error === '' ? null : error
  })
}
