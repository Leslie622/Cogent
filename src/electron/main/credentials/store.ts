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
 * 损坏降级（2026-11-10，架构审查 P0 修复）：文件损坏/跨机器恢复（Windows DPAPI
 * 密文与机器绑定，~/.cogent 整目录搬到新机器必然解密失败）不再炸应用启动 ——
 * 那样窗口和 IPC 都起不来，用户连"重输 key"的入口都没有。改为：降级为空表 +
 * 把错误暴露给 credentials:status（UI 呈现引导重置），下一次成功 write 即用
 * 全新合法文件覆盖旧损坏文件。错误可见（status + 日志），恢复是用户显式动作，
 * 不属于约定.md §1.1 禁止的"静默重建"。
 *
 * 文件格式：<storageRoot>/credentials.json（~/.cogent，2026-11-09 迁入，见 storage-root.ts）
 *   { version: 1, providers: { [providerId]: { apiKey: <base64 密文> } } }
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { storageRoot, ensureRoot, migrateFromUserData, writeFileAtomic } from '../storage-root'

const FILE_VERSION = 1

interface CredentialFile {
  version: number
  providers: Record<string, { apiKey: string }>
}

function filePath(): string {
  return join(storageRoot(), 'credentials.json')
}

/** 读整个密文文件并解密为明文表（进程内使用，不外传）。
    内存态用 Map：get() 天然返回可缺失，string-keyed 查找不落类型谎 */
function decryptAll(): Map<string, { apiKey: string }> {
  // 旧版存 userData：首启搬一次到 ~/.cogent（迁移不是复制，搬完删旧，见 storage-root.ts）
  migrateFromUserData('credentials.json', app.getPath('userData'))
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

export class CredentialStore {
  /** 进程内明文副本：启动时读一次，之后读写都走内存 + 落盘，避免反复解密整个文件 */
  private cache: Map<string, { apiKey: string }> | null = null
  /** 凭据链路的启动期故障（文件损坏/safeStorage 不可用）；null = 健康。见文件头"损坏降级" */
  private startupError: string | null = null

  private ensureLoaded(): Map<string, { apiKey: string }> {
    if (this.cache) return this.cache
    try {
      this.cache = decryptAll()
    } catch (error) {
      // 降级不炸启动：空表 + 错误进 status（UI 引导重置），成功 write 覆盖后自愈
      this.startupError = (error as Error).message
      console.error('[main] credential store degraded:', this.startupError)
      this.cache = new Map()
    }
    return this.cache
  }

  /** 凭据链路健康状态（credentials:status 响应）；error 为 null = 正常 */
  status(): { error: string | null } {
    this.ensureLoaded()
    return { error: this.startupError }
  }

  /** 记录启动期探测到的故障（assertAvailable 失败等，main/index.ts 调用） */
  noteStartupError(message: string): void {
    this.startupError = message
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
    this.assertAvailable()
    const providers = this.ensureLoaded()
    providers.set(providerId, { apiKey })
    this.encryptAll(providers)
    // 落盘成功 = 之前的损坏文件已被全新合法文件覆盖，降级态解除
    this.startupError = null
  }

  remove(providerId: string): void {
    const providers = this.ensureLoaded()
    providers.delete(providerId)
    this.encryptAll(providers)
  }

  private encryptAll(providers: Map<string, { apiKey: string }>): void {
    ensureRoot()
    const encrypted: Record<string, { apiKey: string }> = {}
    for (const [providerId, { apiKey }] of providers) {
      encrypted[providerId] = { apiKey: safeStorage.encryptString(apiKey).toString('base64') }
    }
    const file: CredentialFile = { version: FILE_VERSION, providers: encrypted }
    // 原子写：写入中途崩溃留下的是完整旧文件而非截断新文件（见 storage-root.writeFileAtomic）
    writeFileAtomic(filePath(), JSON.stringify(file, null, 2))
  }
}
