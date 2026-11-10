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
      activeModelId: raw.activeModelId,
      activeProviderId: raw.activeProviderId,
      thinkingLevel: raw.thinkingLevel
    }
  } catch (error) {
    console.warn(`[main] settings.json 损坏，按默认处理（${filePath()}）: ${(error as Error).message}`)
    return { version: 1 }
  }
}

function writeAll(settings: SettingsFile): void {
  ensureRoot()
  // 原子写：偏好虽可再生，但截断文件会在下次启动多一条 warn —— 顺手堵住（见 storage-root）
  writeFileAtomic(filePath(), JSON.stringify(settings, null, 2))
}

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => readAll())

  ipcMain.handle(IPC.settingsSave, (_event, raw: unknown) => {
    // 信任边界：字段级收窄（unknown → 只认三个可选字段）。带了但类型不对 = 越界，
    // 直接抛错而非静默忽略 —— 假成功会掩盖 renderer 侧 bug（约定.md §1.1"越界即抛"）
    const payload = raw as Partial<{ activeModelId: unknown; activeProviderId: unknown; thinkingLevel: unknown }>
    if (payload.activeModelId !== undefined && typeof payload.activeModelId !== 'string') {
      throw new Error('settings:save 的 activeModelId 必须是 string')
    }
    if (payload.activeProviderId !== undefined && typeof payload.activeProviderId !== 'string') {
      throw new Error('settings:save 的 activeProviderId 必须是 string')
    }
    if (payload.thinkingLevel !== undefined && typeof payload.thinkingLevel !== 'string') {
      throw new Error('settings:save 的 thinkingLevel 必须是 string')
    }
    const settings = readAll()
    if (payload.activeModelId !== undefined) settings.activeModelId = payload.activeModelId
    if (payload.activeProviderId !== undefined) settings.activeProviderId = payload.activeProviderId
    if (payload.thinkingLevel !== undefined) settings.thinkingLevel = payload.thinkingLevel
    writeAll(settings)
    return { ok: true as const }
  })
}
