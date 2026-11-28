/**
 * 项目 MCP 定义信任账本（docs/计划/MCP座升级实现.md §4.2）。
 * 身份、文件真实路径、精确字节摘要与 server 名共同决定授权；写盘成功后才发布。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ProtocolError, RpcErrorCode } from '../../protocol'

export interface McpTrustRecord {
  projectId: string
  filePath: string
  sha256: string
  trustedServers: string[]
  decidedAt: string
}

export interface McpTrustDecision {
  projectId: string
  cwd: string
  filePath: string
  sha256: string
  decision: 'trust' | 'reject'
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function mcpFileDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function writeMcpFileAtomically(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { mode: 0o600 })
    renameSync(temporary, filePath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTrustRecord(value: unknown): value is McpTrustRecord {
  return isRecord(value) && typeof value.projectId === 'string' && value.projectId.length > 0
    && typeof value.filePath === 'string' && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
    && Array.isArray(value.trustedServers) && value.trustedServers.every((name) => typeof name === 'string')
    && typeof value.decidedAt === 'string'
}

export class McpTrustStore {
  private readonly file: string
  private records: McpTrustRecord[] = []
  readonly errors: string[] = []

  constructor(root: string) {
    this.file = join(root, 'mcp-trust.json')
    if (!existsSync(this.file)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(isTrustRecord)) {
        throw new Error('expected version 1 trust records')
      }
      this.records = parsed.records
    } catch (error) {
      // 损坏资料没有任何授权效力；诊断随 mcp.list 返回，不阻断其他业务恢复。
      this.errors.push(`${this.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  inspect(filePath: string): { filePath: string; sha256: string } {
    const canonical = realpathSync.native(filePath)
    return { filePath: canonical, sha256: mcpFileDigest(readFileSync(canonical)) }
  }

  isTrusted(projectId: string | undefined, filePath: string, sha256: string, name: string): boolean {
    if (projectId === undefined) return false
    return this.records.some((record) => record.projectId === projectId && samePath(record.filePath, filePath)
      && record.sha256 === sha256 && (record.trustedServers.includes('*') || record.trustedServers.includes(name)))
  }

  /** 项目 ID 与注册表主根的匹配由 Host RPC 入口负责，本层再核根内配置文件身份及摘要。 */
  decide(params: McpTrustDecision): void {
    if (params.projectId.trim() === '') throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 信任需要有效 projectId')
    const root = realpathSync.native(params.cwd)
    const supplied = this.inspect(params.filePath)
    const candidates = [join(root, '.mcp.json'), join(root, '.cogent', 'mcp.json')]
    if (!candidates.some((filePath) => existsSync(filePath) && samePath(realpathSync.native(filePath), supplied.filePath))) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 信任文件不属于项目主根')
    }
    if (supplied.sha256 !== params.sha256) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 配置文件已变更，请重新审阅')
    }
    const next: McpTrustRecord[] = this.records.filter((record) => record.projectId !== params.projectId || !samePath(record.filePath, supplied.filePath))
    next.push({ projectId: params.projectId, ...supplied, trustedServers: params.decision === 'trust' ? ['*'] : [], decidedAt: new Date().toISOString() })
    // 写盘前再取一次指向，防止审阅期间改文件或改符号链接后沿用旧摘要。
    const latest = this.inspect(resolve(params.filePath))
    if (!samePath(latest.filePath, supplied.filePath) || latest.sha256 !== supplied.sha256) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 配置文件已变更，请重新审阅')
    }
    writeMcpFileAtomically(this.file, `${JSON.stringify({ version: 1, records: next }, null, 2)}\n`)
    this.records = next
    this.errors.length = 0
  }
}
