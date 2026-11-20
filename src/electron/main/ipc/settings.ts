/**
 * settings 域 IPC：会话级偏好（选中模型/思考力度）的宿主持久化。
 * 文件：<storageRoot>/settings.json（~/.cogent，壳配置归 main 写，计划 D2）。
 *
 * 写语义 = **字段合并**：saveSettings 载荷是部分字段，与盘上文件浅合并后
 * 整文档写回（两个 setter 各带一个字段，不能整文档覆盖否则互相抹掉）。
 * 读语义 = 宽容但有痕：无文件返回默认（首启常态）；损坏/版本不认识记 warn
 * 后回默认 —— 偏好可再生（与凭据的"降级引导"口径相比这里不值得 UI 呈现），
 * 但必须留日志痕迹，否则用户偏好无端丢失无从排障。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { IPC, type SettingsFile } from '../../../shared/ipc'
import { storageRoot, ensureRoot, migrateFromUserData, writeFileAtomic } from '../storage-root'

function filePath(): string {
  return join(storageRoot(), 'settings.json')
}

function readAll(): SettingsFile {
  // 迁移源与其他 store 统一：老版本存 userData（app.getPath），不是手拼 APPDATA
  // 路径 —— 非 Windows 上 APPDATA 为空时会得到碰运气的相对路径 'Electron'
  migrateFromUserData('settings.json', app.getPath('userData'))
  if (!existsSync(filePath())) return { version: 1 }
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8')) as Partial<SettingsFile>
    if (raw.version !== 1) {
      // 版本不认识 = 未来版本写的文件或手改，按可再生数据记痕回默认（不静默）
      console.warn(`[main] settings.json 版本不认识（${raw.version}），按默认处理: ${filePath()}`)
      return { version: 1 }
    }
    return {
      version: 1,
      fileEditor: typeof raw.fileEditor === 'string' ? raw.fileEditor : undefined,
      activeModelId: raw.activeModelId,
      activeProviderId: raw.activeProviderId,
      thinkingLevel: raw.thinkingLevel,
      defaultPermissionMode: raw.defaultPermissionMode === 'auto' ? 'auto' : 'ask',
      // 发送组合键：越界值（手改文件/未来版本）按可再生偏好归缺省（enter 由消费侧补）
      sendShortcut:
        raw.sendShortcut === 'enter' || raw.sendShortcut === 'shift+enter' || raw.sendShortcut === 'ctrl+enter'
          ? raw.sendShortcut
          : undefined,
      // 关闭行为：同上按可再生偏好归缺省（quit 由消费侧补）
      closeBehavior:
        raw.closeBehavior === 'minimize' || raw.closeBehavior === 'quit' || raw.closeBehavior === 'ask'
          ? raw.closeBehavior
          : undefined,
      // 硬件加速：只认 boolean（true=开/false=关），其余归缺省（开）
      hardwareAcceleration: typeof raw.hardwareAcceleration === 'boolean' ? raw.hardwareAcceleration : undefined,
      // —— 通知与提示音：越界值按可再生偏好归缺省（消费侧补默认）——
      turnDoneNotify:
        raw.turnDoneNotify === 'always' || raw.turnDoneNotify === 'never' || raw.turnDoneNotify === 'unfocused'
          ? raw.turnDoneNotify
          : undefined,
      approvalNotify: typeof raw.approvalNotify === 'boolean' ? raw.approvalNotify : undefined,
      questionNotify: typeof raw.questionNotify === 'boolean' ? raw.questionNotify : undefined,
      toastEnabled: typeof raw.toastEnabled === 'boolean' ? raw.toastEnabled : undefined,
      soundEnabled: typeof raw.soundEnabled === 'boolean' ? raw.soundEnabled : undefined,
      // 数值域（0–1 音量 / 400–1200Hz 基频）：越界即丢回缺省，不钳制 —— 钳移
      // 会把手改的 0.3 静默变成另一档值，缺省化更可预期
      soundVolume: typeof raw.soundVolume === 'number' && raw.soundVolume >= 0 && raw.soundVolume <= 1 ? raw.soundVolume : undefined,
      soundPitch:
        typeof raw.soundPitch === 'number' && raw.soundPitch >= 400 && raw.soundPitch <= 1200
          ? raw.soundPitch
          : undefined,
      // 声音文件名：播放时 protocol handler 还有 basename 防穿越二道闸，这里只验类型
      turnDoneSoundFile: typeof raw.turnDoneSoundFile === 'string' ? raw.turnDoneSoundFile : undefined,
      approvalSoundFile: typeof raw.approvalSoundFile === 'string' ? raw.approvalSoundFile : undefined,
      questionSoundFile: typeof raw.questionSoundFile === 'string' ? raw.questionSoundFile : undefined,
      // externalMcp 是文件级配置（手编），形状不对按缺省关（持久化读取边界）
      externalMcp:
        raw.externalMcp !== undefined &&
        typeof raw.externalMcp === 'object' &&
        typeof raw.externalMcp.enabled === 'boolean' &&
        typeof raw.externalMcp.allowWrites === 'boolean'
          ? { enabled: raw.externalMcp.enabled, allowWrites: raw.externalMcp.allowWrites }
          : undefined
    }
  } catch (error) {
    console.warn(`[main] settings.json 损坏，按默认处理（${filePath()}）: ${(error as Error).message}`)
    return { version: 1 }
  }
}

/** main 内部消费（对外 MCP 凭据写入读配置用；IPC 之外的只读出口） */
export function readSettingsFile(): SettingsFile {
  return readAll()
}

function writeAll(settings: SettingsFile): void {
  ensureRoot()
  // 原子写：偏好虽可再生，但截断文件会在下次启动多一条 warn —— 顺手堵住（见 storage-root）
  writeFileAtomic(filePath(), JSON.stringify(settings, null, 2))
}

/**
 * 字段级校验（saveSettings IPC 与 writeSettingsFile 共用的信任边界）：
 * 带了但类型不对 = 越界，直接抛错（约定 §1.1"越界即抛"）
 */
function assertPatchShape(patch: Partial<Record<keyof SettingsFile, unknown>>): void {
  if (patch.fileEditor !== undefined && (typeof patch.fileEditor !== 'string' || patch.fileEditor.includes('\0'))) throw new Error('编辑器路径必须是字符串')
  if (patch.activeModelId !== undefined && typeof patch.activeModelId !== 'string') {
    throw new Error('settings:save 的 activeModelId 必须是 string')
  }
  if (patch.activeProviderId !== undefined && typeof patch.activeProviderId !== 'string') {
    throw new Error('settings:save 的 activeProviderId 必须是 string')
  }
  if (patch.thinkingLevel !== undefined && typeof patch.thinkingLevel !== 'string') {
    throw new Error('settings:save 的 thinkingLevel 必须是 string')
  }
  if (patch.defaultPermissionMode !== undefined && patch.defaultPermissionMode !== 'ask' && patch.defaultPermissionMode !== 'auto') {
    throw new Error("settings:save 的 defaultPermissionMode 必须是 'ask' | 'auto'")
  }
  if (
    patch.sendShortcut !== undefined &&
    patch.sendShortcut !== 'enter' &&
    patch.sendShortcut !== 'shift+enter' &&
    patch.sendShortcut !== 'ctrl+enter'
  ) {
    throw new Error("settings:save 的 sendShortcut 必须是 'enter' | 'shift+enter' | 'ctrl+enter'")
  }
  if (
    patch.closeBehavior !== undefined &&
    patch.closeBehavior !== 'minimize' &&
    patch.closeBehavior !== 'quit' &&
    patch.closeBehavior !== 'ask'
  ) {
    throw new Error("settings:save 的 closeBehavior 必须是 'minimize' | 'quit' | 'ask'")
  }
  if (patch.hardwareAcceleration !== undefined && typeof patch.hardwareAcceleration !== 'boolean') {
    throw new Error('settings:save 的 hardwareAcceleration 必须是 boolean')
  }
  if (
    patch.turnDoneNotify !== undefined &&
    patch.turnDoneNotify !== 'always' &&
    patch.turnDoneNotify !== 'never' &&
    patch.turnDoneNotify !== 'unfocused'
  ) {
    throw new Error("settings:save 的 turnDoneNotify 必须是 'always' | 'never' | 'unfocused'")
  }
  for (const field of ['approvalNotify', 'questionNotify', 'toastEnabled', 'soundEnabled'] as const) {
    if (patch[field] !== undefined && typeof patch[field] !== 'boolean') {
      throw new Error(`settings:save 的 ${field} 必须是 boolean`)
    }
  }
  if (patch.soundVolume !== undefined && (typeof patch.soundVolume !== 'number' || patch.soundVolume < 0 || patch.soundVolume > 1)) {
    throw new Error('settings:save 的 soundVolume 必须是 0–1 的 number')
  }
  if (patch.soundPitch !== undefined && (typeof patch.soundPitch !== 'number' || patch.soundPitch < 400 || patch.soundPitch > 1200)) {
    throw new Error('settings:save 的 soundPitch 必须是 400–1200 的 number')
  }
  for (const field of ['turnDoneSoundFile', 'approvalSoundFile', 'questionSoundFile'] as const) {
    if (patch[field] !== undefined && typeof patch[field] !== 'string') {
      throw new Error(`settings:save 的 ${field} 必须是 string`)
    }
  }
}

/**
 * 字段合并写（main 内部复用出口，notifications.ts 的声音文件 pick/clear 用）：
 * patch 里 undefined = **删键**（「恢复默认」语义；JSON.stringify 不会写出
 * undefined 值的键），带值 = 覆盖。返回合并后的完整设置。
 */
export function writeSettingsFile(patch: Partial<SettingsFile>): SettingsFile {
  assertPatchShape(patch)
  const settings = readAll()
  // keyof 交叉赋值 TS 不认（值联合 vs 各键具体类型），经 unknown record 收窄
  const target = settings as Partial<Record<keyof SettingsFile, unknown>>
  for (const [key, value] of Object.entries(patch) as Array<[keyof SettingsFile, unknown]>) {
    if (key === 'version') continue
    if (value === undefined) delete target[key]
    else target[key] = value
  }
  writeAll(settings)
  return settings
}

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => readAll())

  ipcMain.handle(IPC.settingsSave, (_event, raw: unknown) => {
    // 信任边界收窄进 assertPatchShape（writeSettingsFile 共用）；字段合并语义
    // 含"undefined=删键"，renderer 的 settings:save 载荷不带 undefined（只设值）
    writeSettingsFile(raw as Partial<SettingsFile>)
    return { ok: true as const }
  })
}
