/**
 * settings 域 IPC：会话级偏好（选中模型/思考力度）的宿主持久化。
 * 文件：<storageRoot>/settings.json（~/.cogent，壳配置归 main 写，计划 D2）。
 *
 * 写语义 = **字段合并**：saveSettings 载荷是部分字段，与盘上文件浅合并后
 * 整文档写回（两个 setter 各带一个字段，不能整文档覆盖否则互相抹掉）。
 * 读语义 = 宽容：无文件/损坏返回 {}（首启常态），字段级形状由消费方校验
 * （engine store 只认认识的值）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import { storageRoot, ensureRoot, migrateFromUserData } from '../storage-root'

interface SettingsFile {
  version: 1
  activeModelId?: string
  /** 选中模型的 provider（同名模型跨 provider 消歧，与 activeModelId 成对；
      旧文件缺省 = 单键语义，用户下一次点选后补全） */
  activeProviderId?: string
  thinkingLevel?: string
}

function filePath(): string {
  return join(storageRoot(), 'settings.json')
}

function readAll(): SettingsFile {
  migrateFromUserData('settings.json', join(process.env.APPDATA ?? '', 'Electron'))
  if (!existsSync(filePath())) return { version: 1 }
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8')) as Partial<SettingsFile>
    return {
      version: 1,
      activeModelId: raw.activeModelId,
      activeProviderId: raw.activeProviderId,
      thinkingLevel: raw.thinkingLevel
    }
  } catch {
    // 损坏不炸应用：偏好文件丢了只是回默认值（与凭据文件的"报错"口径不同——
    // 偏好可再生，凭据不可再生）
    return { version: 1 }
  }
}

function writeAll(settings: SettingsFile): void {
  ensureRoot()
  writeFileSync(filePath(), JSON.stringify(settings, null, 2), 'utf-8')
}

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => readAll())

  ipcMain.handle(IPC.settingsSave, (_event, raw: unknown) => {
    // 信任边界：字段级收窄（unknown → 只留认识的三个可选字段）
    const payload = raw as Partial<{
      activeModelId: unknown
      activeProviderId: unknown
      thinkingLevel: unknown
    }>
    const settings = readAll()
    if (typeof payload.activeModelId === 'string') settings.activeModelId = payload.activeModelId
    if (typeof payload.activeProviderId === 'string') settings.activeProviderId = payload.activeProviderId
    if (typeof payload.thinkingLevel === 'string') settings.thinkingLevel = payload.thinkingLevel
    writeAll(settings)
    return { ok: true as const }
  })
}
