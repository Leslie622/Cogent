/** 用户手势触发的文件选择/剪贴板/预览；只允许按附件 id 读取受管原件。 */
import { handleTrusted, checkCurrentCaller } from './trusted'
import { clipboard, dialog, nativeImage, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { copyFile, readFile } from 'node:fs/promises'
import { IPC } from '../../../shared/ipc'
import type { IpcDeps } from './index'

export function registerAttachmentIpc({ host, getWindow }: IpcDeps): void {
  handleTrusted(IPC.attachmentsPick, async () => {
    const parent = getWindow()
    const options = { title: '添加图片或文件', properties: ['openFile' as const, 'multiSelections' as const] }
    const result = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options)
    return result.filePaths
  })
  handleTrusted(IPC.attachmentsClipboard, async () => {
    if (process.platform === 'win32') {
      // 固定脚本，不把文件名拼进命令；STA 是 Windows Clipboard 的真实要求。
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; $files = @([System.Windows.Forms.Clipboard]::GetFileDropList()); ConvertTo-Json -Compress -InputObject $files'],
      { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
      const paths: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new Error('系统剪贴板未返回文件列表')
      return paths
    }
    const formats = clipboard.availableFormats()
    const format = formats.find((f) => f === 'x-special/gnome-copied-files' || f === 'text/uri-list')
    if (format === undefined) return []
    return clipboard.readBuffer(format).toString('utf8').split(/\r?\n/)
      .filter((line) => line.startsWith('file://')).map((line) => fileURLToPath(line))
  })
  const idFrom = (raw: unknown): { id: string; thumbnail?: boolean; action?: 'reveal' | 'save' } => {
    if (typeof raw !== 'object' || raw === null) throw new Error('附件参数必须是对象')
    const p = raw as { id?: unknown; thumbnail?: unknown; action?: unknown }
    if (typeof p.id !== 'string' || !/^[a-f0-9-]{36}$/.test(p.id) ||
      (p.thumbnail !== undefined && typeof p.thumbnail !== 'boolean') ||
      (p.action !== undefined && p.action !== 'reveal' && p.action !== 'save')) throw new Error('附件参数不合法')
    return p as { id: string; thumbnail?: boolean; action?: 'reveal' | 'save' }
  }
  handleTrusted(IPC.attachmentsPreview, async (_event, raw: unknown) => {
    const p = idFrom(raw)
    const { ref, path } = await host.request('attachments.resolve', { id: p.id })
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(ref.mime) || ref.size > 20 * 1024 * 1024) throw new Error('该附件不能作为图片预览')
    if (p.thumbnail) {
      const thumbnail = await nativeImage.createThumbnailFromPath(path, { width: 240, height: 240 })
      return thumbnail.toDataURL()
    }
    return `data:${ref.mime};base64,${(await readFile(path)).toString('base64')}`
  })
  handleTrusted(IPC.attachmentsAction, async (_event, raw: unknown) => {
    const p = idFrom(raw)
    if (p.action === undefined) throw new Error('缺少附件操作')
    const { ref, path } = await host.request('attachments.resolve', { id: p.id })
    checkCurrentCaller()
    if (p.action === 'reveal') { shell.showItemInFolder(path); return }
    const result = await dialog.showSaveDialog({ title: '另存附件', defaultPath: ref.name })
    checkCurrentCaller()
    if (!result.canceled) await copyFile(path, result.filePath)
  })
}
