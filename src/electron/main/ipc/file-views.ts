/** 文件视图 IPC：所有来源先验主窗口；主进程选择/项目事实生成授权，Host 复核每次读取。 */
import { dialog, ipcMain, shell } from 'electron'
import { copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import { FILE_VIEWS_CHANNEL, FILE_VIEW_FORWARD_METHODS, type FileViewRoot } from '../../../shared/file-views'
import { fileViewObject, fileViewString } from '../../../host/runtime/file-views/handlers'
import { FileViewGrants } from '../file-views/grants'
import { storageRoot } from '../storage-root'
import { requireFileWindow } from './files'
import { readSettingsFile, writeSettingsFile } from './settings'
import type { IpcDeps } from './index'

export function registerFileViewsIpc(deps: IpcDeps): void {
  const grants = new FileViewGrants(storageRoot())
  const registeredWindows = new Map<number, { epoch: number; closed: boolean; ready: Promise<void> }>()
  ipcMain.handle(FILE_VIEWS_CHANNEL, async (event, raw: unknown) => {
    requireFileWindow(event, deps)
    const payload = fileViewObject(raw); const method = fileViewString(payload, 'method'); const params = fileViewObject(payload.params)
    const win = deps.getWindow()!; const windowId = win.webContents.id
    let document = registeredWindows.get(windowId)
    if (document === undefined) {
      document = { epoch: 0, closed: false, ready: Promise.resolve() }
      registeredWindows.set(windowId, document)
      const owner = document
      const reset = () => {
        if (owner.closed) return
        owner.epoch++
        owner.ready = deps.host.request('fileViews.resetWindow', { windowId, windowEpoch: owner.epoch }).then(() => {})
        void owner.ready.catch(() => {}) // 错误由下一次页面调用可见地返回，避免事件回调未处理拒绝。
      }
      win.webContents.on('render-process-gone', reset)
      win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) reset() })
      win.webContents.once('destroyed', () => { owner.closed = true; registeredWindows.delete(windowId); void deps.host.request('fileViews.releaseWindow', { windowId }).catch(() => {}) })
    }
    const windowEpoch = document.epoch
    const assertActive = () => {
      if (document.closed || document.epoch !== windowEpoch || deps.getWindow()?.webContents !== win.webContents) throw new Error('文件页面已重载或关闭，旧操作已失效')
    }
    const active = async <T>(promise: Promise<T>): Promise<T> => { const result = await promise; assertActive(); return result }
    await active(document.ready)
    if (method === 'fileViews.openContext') {
      const scopeId = fileViewString(params, 'scopeId')
      if (params.grantIds !== undefined && (!Array.isArray(params.grantIds) || params.grantIds.length > 64 || params.grantIds.some((value) => typeof value !== 'string'))) throw new Error('文件授权列表不合法')
      const grantIds = [...(params.grantIds as string[] | undefined ?? [])]
      const roots: FileViewRoot[] = []
      if (params.projectId !== undefined) {
        const projectId = fileViewString(params, 'projectId')
        const project = (await active(deps.host.request('project.list', {}))).find((project) => project.id === projectId)
        if (project === undefined) throw new Error('项目不存在或已移除')
        roots.push(...project.cwds.map((path, index) => ({ id: `project:${project.id}:${index}`, path, name: basename(path) || path, kind: 'directory' as const })))
      }
      let selectedPaths: string[] = []; let canceled = false
      if (params.pick !== undefined) {
        if (params.pick !== 'file' && params.pick !== 'directory') throw new Error('文件选择类型不合法')
        const result = await active(dialog.showOpenDialog(win, { title: params.pick === 'file' ? '选择文件' : '选择目录', properties: [params.pick === 'file' ? 'openFile' : 'openDirectory', 'multiSelections'] }))
        canceled = result.canceled
        if (!canceled) { selectedPaths = result.filePaths; for (const path of result.filePaths) grantIds.push(await active(grants.add(path, assertActive))) }
      }
      roots.push(...await active(grants.roots(grantIds)))
      const unique = roots.filter((root, index) => roots.findIndex((value) => value.path === root.path) === index)
      const context = await active(deps.host.request('fileViews.registerContext', { windowId, windowEpoch, scopeId, roots: unique }))
      return { ...context, selectedPaths, canceled }
    }
    if (method === 'fileViews.action') {
      const leaseId = fileViewString(params, 'leaseId'); const action = fileViewString(params, 'action')
      if (!['open', 'reveal', 'save', 'editor'].includes(action)) throw new Error('文件动作不合法')
      const target = await active(deps.host.request('fileViews.actionTarget', { windowId, windowEpoch, leaseId, current: action === 'reveal' || action === 'editor' }))
      if (action === 'reveal') { if (target.kind === 'directory') { const error = await active(shell.openPath(target.path)); if (error !== '') throw new Error(error) } else shell.showItemInFolder(target.path); return { canceled: false } }
      if (action === 'open') { const error = await active(shell.openPath(target.path)); if (error !== '') throw new Error(error); return { canceled: false } }
      if (action === 'save') {
        if (target.kind === 'directory') throw new Error('目录不支持另存')
        const selected = await active(dialog.showSaveDialog(win, { title: '另存文件', defaultPath: target.name }))
        if (selected.canceled) return { canceled: true }
        const checked = await active(deps.host.request('fileViews.actionTarget', { windowId, windowEpoch, leaseId }))
        await active(copyFile(checked.path, selected.filePath)); return { canceled: false }
      }
      if (readSettingsFile().fileEditor === undefined) {
        const selected = await active(dialog.showOpenDialog(win, { title: '选择 VS Code 或 Cursor 的可执行文件', properties: ['openFile'] }))
        if (selected.canceled) return { canceled: true }
        writeSettingsFile({ fileEditor: selected.filePaths[0] })
      }
      const executable = readSettingsFile().fileEditor!
      if (!isAbsolute(executable)) throw new Error('编辑器必须是绝对路径')
      let location: { line: number; column?: number } | undefined
      if (params.location !== undefined) { const rawLocation = fileViewObject(params.location); for (const [key, value] of Object.entries(rawLocation)) if (!['line', 'column', 'endLine'].includes(key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('文件定位不合法'); if (typeof rawLocation.line !== 'number') throw new Error('文件行号不合法'); location = rawLocation as { line: number; column?: number } }
      const path = location === undefined ? target.path : `${target.path}:${location.line}:${location.column ?? 1}`
      await active(new Promise<void>((resolve, reject) => { const child = spawn(executable, target.kind === 'directory' ? ['--reuse-window', target.path] : ['--reuse-window', '--goto', path], { windowsHide: true, stdio: 'ignore' }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve() }) }))
      return { canceled: false }
    }
    if (!FILE_VIEW_FORWARD_METHODS.includes(method as typeof FILE_VIEW_FORWARD_METHODS[number])) throw new Error('文件视图方法不在白名单')
    return active(deps.host.request(method as typeof FILE_VIEW_FORWARD_METHODS[number], { ...params, windowId, windowEpoch } as never))
  })
}
