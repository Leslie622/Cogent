/** MCP OAuth 状态的唯一持久化 owner；读取故障不挡启动，显式加密提交后才自愈。 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { storageRoot, writeFileAtomic } from '../storage-root'

export interface McpCredentialSnapshot {
  oauthStates: Record<string, unknown>
}

interface EncryptedFile {
  version: 1
  oauthStates: Record<string, string>
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every(entry => typeof entry === 'string')
}

export class McpCredentialStore {
  private cache: McpCredentialSnapshot | undefined
  private startupError: string | null = null
  private readonly path: string

  constructor(private readonly root = storageRoot()) { this.path = join(root, 'mcp-credentials.json') }

  private assertAvailable(): void {
    // backend 探测 API 仅 Linux 提供；Windows/macOS 只检查系统加密可用性。
    if (!safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('系统安全存储不可用，无法加密保存 MCP OAuth 凭据')
    }
  }

  private load(): McpCredentialSnapshot {
    if (this.cache !== undefined) return this.cache
    if (!existsSync(this.path)) return this.cache = { oauthStates: {} }
    try {
      this.assertAvailable()
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof raw !== 'object' || raw === null || !('version' in raw) || raw.version !== 1 ||
          !('oauthStates' in raw) || !isStringRecord(raw.oauthStates)) {
        throw new Error('MCP 凭据文件版本或形状不合法，请修复后重试')
      }
      const decrypt = (cipher: string): string => safeStorage.decryptString(Buffer.from(cipher, 'base64'))
      // 旧版 secrets 字段不再消费或解密；只读旧文件，直到用户显式保存 OAuth 状态。
      const oauthStates = Object.fromEntries(Object.entries(raw.oauthStates).map(([key, value]) => [key, JSON.parse(decrypt(value)) as unknown]))
      this.cache = { oauthStates }
    } catch (error) {
      this.startupError = error instanceof Error ? error.message : String(error)
      console.error('[main] MCP credential store degraded:', this.startupError)
      // 保留原文件供恢复；重新登录成功写入前，不让损坏或跨机密文阻断整个桌面启动。
      this.cache = { oauthStates: {} }
    }
    return this.cache
  }

  /** 仅传给同代 Host 的 stdio 握手/交接，绝不用于 renderer 列表或诊断。 */
  readAll(): McpCredentialSnapshot { return structuredClone(this.load()) }

  /** 启动读取的故障保留在日志与状态中，成功加密写入后解除。 */
  status(): { error: string | null } { this.load(); return { error: this.startupError } }

  setOAuthState(key: string, state: unknown): void {
    const candidate = this.readAll()
    if (state === undefined) delete candidate.oauthStates[key]
    else candidate.oauthStates[key] = structuredClone(state)
    this.commit(candidate)
  }

  private commit(candidate: McpCredentialSnapshot): void {
    this.assertAvailable()
    const encrypt = (value: string): string => safeStorage.encryptString(value).toString('base64')
    const file: EncryptedFile = {
      version: 1,
      oauthStates: Object.fromEntries(Object.entries(candidate.oauthStates).map(([key, value]) => [key, encrypt(JSON.stringify(value))]))
    }
    mkdirSync(this.root, { recursive: true })
    writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`)
    this.cache = candidate
    this.startupError = null
  }
}
