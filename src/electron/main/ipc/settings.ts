/**
 * settings 域 IPC：会话级偏好（选中模型/思考力度）的宿主持久化。
 * 文件：<storageRoot>/settings.json（~/.cogent，壳配置归 main 写）。
 *
 * 写语义 = **字段合并**：saveSettings 载荷是部分字段，与盘上文件浅合并后
 * 整文档写回（两个 setter 各带一个字段，不能整文档覆盖否则互相抹掉）。
 * 读语义 = 宽容但有痕：无文件返回默认（首启常态）；损坏/版本不认识记 warn
 * 后回默认 —— 偏好可再生（与凭据的"降级引导"口径相比这里不值得 UI 呈现），
 * 但必须留日志痕迹，否则用户偏好无端丢失无从排障。
 */
import { handleTrusted } from './trusted'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { IPC, type RendererSettingsPatch, type SettingsFile } from '../../../shared/ipc'
import { storageRoot, ensureRoot, writeFileAtomic } from '../storage-root'
import { managedSoundFileName } from '../sound-files'

function filePath(): string {
  return join(storageRoot(), 'settings.json')
}

function readAll(): SettingsFile {
  // 迁移源与其他 store 统一：老版本存 userData（app.getPath），不是手拼 APPDATA
  // 路径 —— 非 Windows 上 APPDATA 为空时会得到碰运气的相对路径 'Electron'
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
      defaultPermissionMode: raw.defaultPermissionMode,
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
      turnDoneSoundFile: managedSoundFileName(raw.turnDoneSoundFile, 'turn-done'),
      approvalSoundFile: managedSoundFileName(raw.approvalSoundFile, 'approval'),
      questionSoundFile: managedSoundFileName(raw.questionSoundFile, 'question'),
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

// 普通设置只写偏好；编辑器和提示音文件由 main 的原生选择与清除入口提交。
const rendererPatch = z.strictObject({
  activeModelId: z.string(),
  activeProviderId: z.string(),
  thinkingLevel: z.string(),
  sendShortcut: z.enum(['enter', 'shift+enter', 'ctrl+enter']),
  closeBehavior: z.enum(['minimize', 'quit', 'ask']),
  hardwareAcceleration: z.boolean(),
  turnDoneNotify: z.enum(['always', 'never', 'unfocused']),
  approvalNotify: z.boolean(),
  questionNotify: z.boolean(),
  toastEnabled: z.boolean(),
  soundEnabled: z.boolean(),
  soundVolume: z.number().min(0).max(1),
  soundPitch: z.number().min(400).max(1200)
} satisfies Record<Exclude<keyof RendererSettingsPatch, 'defaultPermissionMode'>, z.ZodType>).partial()

/**
 * main 的单一字段合并写。各入口先校验自己接收的值；undefined 在落盘时删键，
 * 用于恢复默认音源或清除旧模型偏好。
 */
export function writeSettingsFile(patch: Partial<Omit<SettingsFile, 'version'>>): void {
  writeAll({ ...readAll(), ...patch })
}

export function registerSettingsIpc(): void {
  handleTrusted(IPC.settingsGet, () => readAll())

  handleTrusted(IPC.settingsSave, (_event, raw: unknown) => {
    writeSettingsFile(rendererPatch.parse(raw))
    return { ok: true as const }
  })
}
