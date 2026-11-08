/**
 * 宿主侧凭据存取 —— Electron safeStorage 加密落盘（路线第 5 项）。
 *
 * 职责与边界：
 * - main 是壳：只做加密存取，不理解 provider 语义（目录在引擎）；
 * - key 明文只在 main 内存短暂存在（读写文件瞬间）。对外两路：credentials:list
 *   只吐 keyConfigured 布尔位；credentials:get 按需单取明文（设置页全量回显，
 *   用户拍板 2026-11-08）—— 批量状态与单取分离，避免整表明文随查询流动；
 * - safeStorage 不可用（Linux 无 keyring 等）直接抛错 —— 静默降级成明文存储
 *   是安全事故，不是兼容性优化。
 *
 * 文件格式：userData/credentials.json
 *   { version: 1, providers: { [providerId]: { apiKey: <base64 密文> } } }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

const FILE_VERSION = 1

interface CredentialFile {
  version: number
  providers: Record<string, { apiKey: string }>
}

function filePath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

/** 读整个密文文件并解密为明文表（进程内使用，不外传）。
    内存态用 Map：get() 天然返回可缺失，string-keyed 查找不落类型谎 */
function decryptAll(): Map<string, { apiKey: string }> {
  const path = filePath()
  if (!existsSync(path)) return new Map()

  // 信任边界：磁盘旧数据可能损坏/被手改 —— 校验形状，损坏报错而非静默重建（约定.md §1.1）
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    throw new Error(`凭据文件损坏（${path}）: ${(error as Error).message}`)
  }
  const file = raw as Partial<CredentialFile>
  if (file.version !== FILE_VERSION || typeof file.providers !== 'object' || Array.isArray(file.providers)) {
    throw new Error(`凭据文件版本/形状不合法（${path}），请手工处理后重启`)
  }

  const result = new Map<string, { apiKey: string }>()
  for (const [providerId, entry] of Object.entries(file.providers)) {
    const buffer = safeStorage.decryptString(Buffer.from(entry.apiKey, 'base64'))
    result.set(providerId, { apiKey: buffer })
  }
  return result
}

function encryptAll(providers: Map<string, { apiKey: string }>): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const encrypted: Record<string, { apiKey: string }> = {}
  for (const [providerId, { apiKey }] of providers) {
    encrypted[providerId] = { apiKey: safeStorage.encryptString(apiKey).toString('base64') }
  }
  const file: CredentialFile = { version: FILE_VERSION, providers: encrypted }
  writeFileSync(filePath(), JSON.stringify(file, null, 2), 'utf-8')
}

export class CredentialStore {
  /** 进程内明文副本：启动时读一次，之后读写都走内存 + 落盘，避免反复解密整个文件 */
  private cache: Map<string, { apiKey: string }> | null = null

  private ensureLoaded(): Map<string, { apiKey: string }> {
    if (!this.cache) this.cache = decryptAll()
    return this.cache
  }

  /** safeStorage 可用性守卫：引擎握手前调用，失败要挡在"写文件"之前 */
  assertAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统不支持凭据加密（safeStorage 不可用），无法安全存储 API key')
    }
  }

  /** 全量明文表（仅引擎握手注入用；日志不得使用本方法的返回值） */
  readAll(): Record<string, { apiKey: string }> {
    return Object.fromEntries(this.ensureLoaded())
  }

  /** provider id → 是否已配 key（credentials:list 响应；布尔位可安全外发） */
  listConfigured(): Array<{ providerId: string; keyConfigured: boolean }> {
    return [...this.ensureLoaded()].map(([providerId, { apiKey }]) => ({
      providerId,
      keyConfigured: apiKey.length > 0
    }))
  }

  /** 单 provider 的 key 明文（credentials:get 响应；无记录返回空串） */
  read(providerId: string): string {
    const entry = this.ensureLoaded().get(providerId)
    return entry === undefined ? '' : entry.apiKey
  }

  write(providerId: string, apiKey: string): void {
    const providers = this.ensureLoaded()
    providers.set(providerId, { apiKey })
    encryptAll(providers)
  }

  remove(providerId: string): void {
    const providers = this.ensureLoaded()
    providers.delete(providerId)
    encryptAll(providers)
  }
}
