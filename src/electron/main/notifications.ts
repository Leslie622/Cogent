/**
 * 通知域 main 侧设施（设置「通知」分区的呈现端，条件判定在 renderer）：
 *
 * ① toast（notify:toast）：renderer 判定条件后发来，main 只展示 ——
 *    Electron Notification（silent：系统通知不发声，声音归应用内提示音），
 *    点击恢复/聚焦主窗口。Notification 对象显式持有到 close 防 GC
 *    （zcode desktopNotifications.ts:51-66 的坑：局部变量被回收时 click
 *    listener 丢失）。不支持系统通知的环境（无通知服务的 Linux）静默跳过。
 *
 * ② 自定义声音文件（sound:pick-file / sound:clear-file）：系统文件选择框
 *    （音频扩展名过滤）→ 拷贝进 ~/.cogent/sounds/ → 提交 settings.json 音源字段。
 *    main 管文件和字段，renderer 只消费提交结果。
 *
 * ③ cogent-sound:// 特权协议：renderer（dev 下是 http://localhost）不能直读
 *    file://，经本协议由 main 代理读 sounds/ 目录回流。handler 只接受纯
 *    文件名（拒绝路径分隔符与 ..，防穿越）。
 *
 * ④ 系统通知设置跳转（shell:open-notification-settings）：平台 URI，
 *    Linux 无统一入口不注册（renderer 按 preload 暴露的 platform 隐藏按钮）。
 */
import { randomUUID } from 'node:crypto'
import { constants, copyFileSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dialog, ipcMain, net, protocol, shell, Notification, type BrowserWindow } from 'electron'
import { IPC, NOTIFY_SOUND_FILE_FIELDS, type NotifyKind, type NotifyToastPayload } from '../../shared/ipc'
import { storageRoot } from './storage-root'
import { readSettingsFile, writeSettingsFile } from './ipc/settings'
import { managedSoundFileName } from './sound-files'

/** 「正在展示」的 toast 持有表（防 GC；进程退出自然清空） */
const liveToasts = new Set<Notification>()

/** 信任边界收窄：unknown → NotifyKind（越界即抛，约定 §1.1） */
function isNotifyKind(raw: unknown): raw is NotifyKind {
  return raw === 'turn-done' || raw === 'approval' || raw === 'question'
}

function soundsDir(): string {
  return join(storageRoot(), 'sounds')
}

/** cogent-sound:// 的 URL → sounds/ 下绝对路径；非纯文件名（含路径）拒绝。
    文件名放 pathname 段（hostname 段会被浏览器强制小写，大小写敏感盘会挂）；
    中文等非 ASCII 字符过 URL 被百分号编码，这里解码回真实文件名 */
function resolveSoundPath(url: string): string | null {
  const parsed = new URL(url)
  if (parsed.hostname !== 'local') return null
  let name: string
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  } catch {
    return null // 畸形编码序列
  }
  return managedSoundPath(name) ?? null
}

function managedSoundPath(value: unknown, kind?: NotifyKind): string | undefined {
  const name = managedSoundFileName(value, kind)
  return name === undefined ? undefined : join(soundsDir(), name)
}

function removeUnusedSound(path: string | undefined): void {
  if (path === undefined) return
  try { rmSync(path, { force: true }) }
  catch (error) {
    // 字段已提交，清理失败不影响当前音源，也不会误报配置未保存。
    console.warn('[main] 清理旧提示音文件失败:', error)
  }
}

/** 特权协议声明（必须在 app ready 前调，index.ts 顶层） */
export function registerSoundScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // stream: 音频按流加载；supportFetchAPI: handler 返回 fetch Response
    { scheme: 'cogent-sound', privileges: { stream: true, supportFetchAPI: true } }
  ])
}

export function registerNotifyIpc(deps: { getWindow: () => BrowserWindow | null }): void {
  // ———— toast：只展示，不判条件（单一判定源在 renderer）————
  ipcMain.handle(IPC.notifyToast, (_event, raw: unknown) => {
    // 信任边界：载荷收窄（约定 §1.1）
    const payload = raw as Partial<NotifyToastPayload>
    if (typeof payload.title !== 'string' || typeof payload.body !== 'string') {
      throw new Error('notify:toast 载荷必须是 { title: string, body: string }')
    }
    if (!Notification.isSupported()) return { ok: false as const, reason: 'unsupported' as const }
    const toast = new Notification({ title: payload.title, body: payload.body, silent: true })
    liveToasts.add(toast)
    toast.on('close', () => liveToasts.delete(toast))
    // 点击：恢复主窗口（minimize 档窗口藏在托盘也要能呼回）
    toast.on('click', () => {
      const win = deps.getWindow()
      if (!win || win.isDestroyed()) return
      win.show()
      win.focus()
    })
    toast.show()
    return { ok: true as const }
  })

  // ———— 自定义声音文件：选（拷贝）/ 清（删除）————
  ipcMain.handle(IPC.soundPickFile, async (_event, raw: unknown) => {
    if (!isNotifyKind(raw)) {
      throw new Error("sound:pick-file 载荷必须是 'turn-done' | 'approval' | 'question'")
    }
    const kind = raw
    // showOpenDialog 的重载：有父窗口用 (win, options)（模态挂靠），无窗退 (options)
    const options: Electron.OpenDialogOptions = {
      title: '选择提示音文件',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a'] }]
    }
    const parent = deps.getWindow()
    const picked =
      parent !== null
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return null // 用户取消是常态不是错误
    const source = picked.filePaths[0]
    const field = NOTIFY_SOUND_FILE_FIELDS[kind]
    const previous = managedSoundPath(readSettingsFile()[field], kind)
    // 同名原件也使用不同 ID；保存失败保留旧配置和字节，播放缓存也不会返回旧音频。
    const name = `${kind}-${randomUUID()}-${basename(source)}`
    const target = managedSoundPath(name, kind)
    if (target === undefined) throw new Error('仅支持 MP3、WAV、OGG、FLAC 和 M4A 提示音文件')
    mkdirSync(soundsDir(), { recursive: true })
    copyFileSync(source, target, constants.COPYFILE_EXCL)
    try { writeSettingsFile({ [field]: name }) }
    catch (error) { removeUnusedSound(target); throw error }
    removeUnusedSound(previous)
    return name
  })

  ipcMain.handle(IPC.soundClearFile, (_event, raw: unknown) => {
    if (!isNotifyKind(raw)) {
      throw new Error("sound:clear-file 载荷必须是 'turn-done' | 'approval' | 'question'")
    }
    const kind = raw
    const field = NOTIFY_SOUND_FILE_FIELDS[kind]
    const previous = managedSoundPath(readSettingsFile()[field], kind)
    writeSettingsFile({ [field]: undefined })
    removeUnusedSound(previous)
    return { ok: true as const }
  })

  // ———— 系统通知设置跳转：Linux 无统一入口不注册 ————
  if (process.platform === 'win32' || process.platform === 'darwin') {
    ipcMain.handle(IPC.openNotificationSettings, () => {
      const url =
        process.platform === 'win32'
          ? 'ms-settings:notifications'
          : 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
      return shell.openExternal(url)
    })
  }

  // ———— 系统通知开关快照（Windows）：注册表无变更事件，只能按需查一次 ————
  ipcMain.handle(IPC.notifySystemStatus, async () => {
    if (process.platform !== 'win32') return { enabled: null }
    // reg query 固定参数无用户输入；外部边界（spawn）失败按未知处理不炸调用方
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    try {
      const { stdout } = await promisify(execFile)('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications',
        '/v',
        'ToastEnabled'
      ])
      const match = /ToastEnabled\s+REG_DWORD\s+0x([01])/i.exec(stdout)
      return { enabled: match === null ? null : match[1] === '1' }
    } catch (error) {
      // 键不存在 = 用户从未动过开关 = Windows 默认开（reg 以非零退出 + stderr 报错）
      const message = error instanceof Error ? error.message : String(error)
      return { enabled: /unable to find|cannot find/i.test(message) ? true : null }
    }
  })

  // cogent-sound:// 代理读（协议声明在 ready 前，handle 在 ready 后都合法）
  protocol.handle('cogent-sound', (request) => {
    const file = resolveSoundPath(request.url)
    if (file === null) return new Response('forbidden', { status: 403 })
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}
