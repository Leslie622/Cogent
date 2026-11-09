/**
 * 自定义 provider 定义的宿主持久化（明文 JSON，非机密）。
 *
 * 与 credentials 的分工：这里只存"定义"（name/baseUrl/模型列表、内置 provider 的
 * baseUrl 覆盖），不含 key —— key 走 credentials.json（safeStorage 加密）。
 * 明文的理由：定义本身不敏感（端点地址不是秘密），用户可以直接手改文件排障。
 *
 * 文件：<storageRoot>/custom-providers.json（~/.cogent，2026-11-09 迁入，见 storage-root.ts）
 *   { version: 1, providers: CustomProviderDef[], overrides: ProviderOverrideDef[] }
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { CustomProviderDef, ProviderOverrideDef } from '../../../protocol'
import { storageRoot, ensureRoot, migrateFromUserData } from '../storage-root'

const FILE_VERSION = 1

interface CustomProvidersFile {
  version: number
  providers: CustomProviderDef[]
  overrides: ProviderOverrideDef[]
}

function filePath(): string {
  return join(storageRoot(), 'custom-providers.json')
}

export class CustomProvidersStore {
  private cache: CustomProvidersFile | null = null

  private ensureLoaded(): CustomProvidersFile {
    if (this.cache) return this.cache
    // 旧版存 userData：首启搬一次到 ~/.cogent（迁移不是复制，搬完删旧，见 storage-root.ts）
    migrateFromUserData('custom-providers.json', app.getPath('userData'))
    const path = filePath()
    if (!existsSync(path)) {
      this.cache = { version: FILE_VERSION, providers: [], overrides: [] }
      return this.cache
    }

    // 信任边界：磁盘旧数据可能损坏/被手改 —— 校验形状，损坏报错而非静默重建（约定.md §1.1）
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (error) {
      throw new Error(`自定义 provider 文件损坏（${path}）: ${(error as Error).message}`)
    }
    const file = raw as Partial<CustomProvidersFile>
    if (
      file.version !== FILE_VERSION ||
      !Array.isArray(file.providers) ||
      !Array.isArray(file.overrides)
    ) {
      throw new Error(`自定义 provider 文件版本/形状不合法（${path}），请手工处理后重启`)
    }
    this.cache = { version: FILE_VERSION, providers: file.providers, overrides: file.overrides }
    return this.cache
  }

  readAll(): { providers: CustomProviderDef[]; overrides: ProviderOverrideDef[] } {
    const file = this.ensureLoaded()
    return { providers: [...file.providers], overrides: [...file.overrides] }
  }

  writeAll(providers: CustomProviderDef[], overrides: ProviderOverrideDef[]): void {
    ensureRoot()
    this.cache = { version: FILE_VERSION, providers, overrides }
    writeFileSync(filePath(), JSON.stringify(this.cache, null, 2), 'utf-8')
  }
}
