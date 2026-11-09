/**
 * 第一方存储根（决策 D1，docs/计划-工作区与会话真实化.md §1/§2）：
 * `COGENT_HOME ?? ~/.cogent`，凭据/自定义 provider/会话/项目全在这一个根下。
 *
 * 为什么不用 userData：dev 态 userData 默认是 %APPDATA%\Electron（与一切 dev
 * 应用共用，易踩坑），且用户是开发者受众 —— 点文件夹可发现、可 grep、可整目录
 * 备份（~/.codex / ~/.zcode 同款惯例）。userData 退化为只装 Electron 自身缓存。
 *
 * migrateFromUserData：老版本把 credentials.json / custom-providers.json 存在
 * userData，首启搬一次（读出→写新→删旧）。**迁移不是复制**——删旧是避免双份
 * 分叉（用户改了旧文件却"不生效"是排障噩梦）。搬失败（磁盘/权限）抛给调用方，
 * 不静默：静默降级意味着 key 凭空消失。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function storageRoot(): string {
  return process.env.COGENT_HOME || join(homedir(), '.cogent')
}

/** 确保根目录存在（各 store 落盘前调用） */
export function ensureRoot(): void {
  if (!existsSync(storageRoot())) mkdirSync(storageRoot(), { recursive: true })
}

/**
 * 旧 userData 文件迁移（首启一次性）：存在即搬运（内容原样），完成后删旧文件。
 * 幂等：新根已有同名文件时不搬（以新根为准），旧文件仍删（迁移完成态）。
 */
export function migrateFromUserData(fileName: string, userDataDir: string): void {
  const legacy = join(userDataDir, fileName)
  if (!existsSync(legacy)) return
  ensureRoot()
  const target = join(storageRoot(), fileName)
  if (!existsSync(target)) writeFileSync(target, readFileSync(legacy))
  rmSync(legacy)
}
