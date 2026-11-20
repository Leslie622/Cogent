/** 桌面文件动作只接受可信主窗口顶层帧；fileId 在 Host 复核，路径不进入 shell 插值。 */
import { dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { IPC } from '../../../shared/ipc'
import type { FileActionRequest } from '../../../shared/files'
import { readSettingsFile, writeSettingsFile } from './settings'
import type { IpcDeps } from './index'

export function requireFileWindow(
  event: IpcMainInvokeEvent,
  { getWindow }: Pick<IpcDeps, 'getWindow'>
): void {
  const window = getWindow()
  if (
    window === null ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('文件能力仅允许主窗口顶层页面调用')
}
export function fileActionRequest(raw: unknown): FileActionRequest {
  if (raw === null || typeof raw !== 'object') throw new Error('文件操作参数必须是对象')
  const p = raw as Partial<FileActionRequest>
  if (
    typeof p.sessionId !== 'string' ||
    p.sessionId === '' ||
    typeof p.fileId !== 'string' ||
    p.fileId === '' ||
    !['open', 'reveal', 'save', 'editor'].includes(p.action as string)
  )
    throw new Error('文件操作参数不合法')
  if (p.location !== undefined) {
    const rawLocation: unknown = p.location
    if (rawLocation === null || typeof rawLocation !== 'object') throw new Error('文件位置不合法')
    for (const [key, value] of Object.entries(p.location))
      if (!['line', 'column', 'endLine'].includes(key) || !Number.isSafeInteger(value) || value < 1)
        throw new Error('文件位置不合法')
    if (!Number.isSafeInteger(p.location.line) || p.location.line < 1)
      throw new Error('文件位置不合法')
  }
  return p as FileActionRequest
}
export function registerFileIpc(deps: IpcDeps): void {
  const configure = async () => {
    const result = await dialog.showOpenDialog(deps.getWindow()!, {
      title: '选择 VS Code 或 Cursor 的可执行文件',
      properties: ['openFile'],
      ...(process.platform === 'win32' && {
        filters: [{ name: '编辑器可执行文件', extensions: ['exe'] }]
      })
    })
    if (result.canceled) return { canceled: true }
    writeSettingsFile({ fileEditor: result.filePaths[0] })
    return { canceled: false }
  }
  ipcMain.handle(IPC.filesConfigureEditor, async (event) => {
    requireFileWindow(event, deps)
    return configure()
  })
  ipcMain.handle(IPC.filesAction, async (event, raw: unknown) => {
    requireFileWindow(event, deps)
    const request = fileActionRequest(raw)
    const target = await deps.host.request('files.actionTarget', {
      sessionId: request.sessionId,
      fileId: request.fileId
    })
    if (request.action === 'reveal') {
      if (target.kind === 'directory') {
        const error = await shell.openPath(target.path)
        if (error !== '') throw new Error(error)
      } else shell.showItemInFolder(target.path)
      return { canceled: false }
    }
    if (request.action === 'open') {
      const error = await shell.openPath(target.path)
      if (error !== '') throw new Error(error)
      return { canceled: false }
    }
    if (request.action === 'save') {
      if (target.kind === 'directory') throw new Error('目录不支持另存为文件')
      const result = await dialog.showSaveDialog(deps.getWindow()!, {
        title: '另存文件',
        defaultPath: target.name
      })
      if (result.canceled) return { canceled: true }
      // 对话框期间文件可能被删除或替换，动作前重新向 Host 核对。
      const checked = await deps.host.request('files.actionTarget', request)
      await copyFile(checked.path, result.filePath)
      return { canceled: false }
    }
    if (readSettingsFile().fileEditor === undefined && (await configure()).canceled)
      return { canceled: true }
    const executable = readSettingsFile().fileEditor!
    if (!isAbsolute(executable)) throw new Error('编辑器必须为绝对可执行文件路径')
    const location = request.location
    const path =
      location === undefined
        ? target.path
        : `${target.path}:${location.line}:${location.column ?? 1}`
    // GUI 编辑器可能一直存活，因此确认 spawn 成功就返回，不等待编辑器退出，不设置 shell。
    await new Promise<void>((resolve, reject) => {
      const args =
        target.kind === 'directory'
          ? ['--reuse-window', target.path]
          : ['--reuse-window', '--goto', path]
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
    return { canceled: false }
  })
}
