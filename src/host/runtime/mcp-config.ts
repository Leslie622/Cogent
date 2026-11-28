/**
 * Host 拥有的 MCP 配置真源（docs/模块/MCP座.md）。
 * 用户定义 → 标准项目文件 → Cogent 项目文件；项目新定义必须逐文件摘要受信。
 * 同一物理文件只按先出现的来源读取一次，项目槽位与用户文件重合时不降级为项目定义。
 * 原始定义无损回填，运行配置统一 deferred；读取不触发网络或子进程。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isMcpServerOverride, mcpNamespace, validateMcpServerConfig } from '@earendil-works/pi-mcp'
import type { LoadedMcpConfig, McpServerEntry } from '@earendil-works/pi-coding-agent'
import type { McpExposure, McpListResult, McpPendingTrustFile, McpServerDef, McpServerSummary } from '../../protocol'
import { ProtocolError, RpcErrorCode } from '../../protocol'
import { mcpFileDigest, McpTrustStore, writeMcpFileAtomically } from './mcp-trust'

const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'] as const
const EXPOSURES: readonly McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden']
const KNOWN_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd', 'sanitizeHostEnv', 'url', 'headers', 'oauth', 'description', 'enabled', 'exposure', 'toolExposure', 'timeout'])

export interface CogentMcpEntry {
  name: string
  config: McpServerDef
  source: string
  scope: 'global' | 'project'
  origin: 'user' | 'project-file' | 'project-cogent'
  trusted: boolean
  override?: string
  /** 原始定义供 UI 回填；运行配置中的默认值与 override 不回写。 */
  definition?: McpServerDef
}

export interface McpSettingsPatch {
  enabled?: boolean
  exposure?: McpExposure
  toolExposure?: Record<string, McpExposure>
}

interface ConfigFile {
  document: Record<string, unknown>
  servers: Record<string, unknown>
  text: string
  sha256: string
  source: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exposureError(config: { exposure?: unknown; toolExposure?: unknown }): string | undefined {
  if (config.exposure !== undefined && !EXPOSURES.includes(config.exposure as McpExposure)) return 'exposure must be direct, deferred, codemode or hidden'
  if (config.toolExposure !== undefined && (!isRecord(config.toolExposure) || Object.values(config.toolExposure).some((value) => !EXPOSURES.includes(value as McpExposure)))) return 'toolExposure must map tool names to exposures'
  return undefined
}

/** 扩展字段只透传到盘，已知字段始终以收窄后的定义为准。 */
export function mcpDefToRaw(definition: McpServerDef): Record<string, unknown> {
  const { name: _name, extraFields, ...fields } = definition
  if (Object.keys(extraFields ?? {}).some((key) => KNOWN_FIELDS.has(key))) throw new ProtocolError(RpcErrorCode.InvalidParams, 'extraFields 只能包含未知扩展字段')
  return { ...extraFields, ...fields }
}

/** 配置为外部输入：复用 pi 字段校验；SSE 复用 HTTP 合同，不绕过 OAuth 校验。 */
export function parseMcpServerDefinition(name: string, raw: unknown): McpServerDef {
  if (!isRecord(raw)) throw new ProtocolError(RpcErrorCode.InvalidParams, `server "${name}" must be an object`)
  const customError = exposureError(raw)
  if (customError !== undefined) throw new ProtocolError(RpcErrorCode.InvalidParams, `server "${name}": ${customError}`)
  if (raw.sanitizeHostEnv !== undefined && typeof raw.sanitizeHostEnv !== 'boolean') throw new ProtocolError(RpcErrorCode.InvalidParams, `server "${name}": sanitizeHostEnv must be a boolean`)
  if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout))) throw new ProtocolError(RpcErrorCode.InvalidParams, `server "${name}": timeout must be finite`)
  const candidate: Record<string, unknown> = { ...raw, ...(raw.type === 'sse' && { type: 'http' }) }
  // 含引用的 URL 在建连瞬间展开后校验；配置读取不得求值或触碰凭据。
  if (typeof candidate.url === 'string' && candidate.url.includes('${')) candidate.url = 'https://mcp-template.invalid'
  const result = validateMcpServerConfig(name, candidate, {
    checkMetadataDocumentCallback: (callbackUrl) => callbackUrl === undefined || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/callback$/.test(callbackUrl)
      ? undefined : 'CIMD callback must be /callback on localhost or 127.0.0.1'
  })
  if (result.kind === 'invalid') throw new ProtocolError(RpcErrorCode.InvalidParams, result.error)
  const extraFields = Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN_FIELDS.has(key)))
  const shared = {
    ...(raw.description !== undefined && { description: raw.description as string }),
    ...(raw.enabled !== undefined && { enabled: raw.enabled as boolean }),
    ...(raw.exposure !== undefined && { exposure: raw.exposure as McpExposure }),
    ...(raw.toolExposure !== undefined && { toolExposure: raw.toolExposure as Record<string, McpExposure> }),
    ...(raw.timeout !== undefined && { timeout: raw.timeout }),
    ...(Object.keys(extraFields).length > 0 && { extraFields })
  }
  if (result.kind === 'stdio') return {
    name, type: 'stdio', command: result.config.command,
    ...(result.config.args !== undefined && { args: result.config.args }),
    ...(result.config.env !== undefined && { env: result.config.env }),
    ...(result.config.cwd !== undefined && { cwd: result.config.cwd }),
    ...(raw.sanitizeHostEnv !== undefined && { sanitizeHostEnv: raw.sanitizeHostEnv }), ...shared
  }
  return {
    name, type: raw.type === 'sse' ? 'sse' : 'http', url: raw.url as string,
    ...(result.config.headers !== undefined && { headers: result.config.headers }),
    ...(result.config.oauth !== undefined && { oauth: result.config.oauth }), ...shared
  }
}

function effectiveExposure(exposure: McpExposure | undefined): McpExposure {
  return exposure === undefined || exposure === 'codemode' ? 'deferred' : exposure
}

function effectiveConfig(definition: McpServerDef): McpServerDef {
  return { ...definition, exposure: effectiveExposure(definition.exposure), ...(definition.toolExposure !== undefined && {
    toolExposure: Object.fromEntries(Object.entries(definition.toolExposure).map(([name, exposure]) => [name, effectiveExposure(exposure)]))
  }) }
}

function readConfigFile(filePath: string): ConfigFile {
  if (!existsSync(filePath)) return { document: {}, servers: {}, text: '', sha256: '', source: filePath }
  const source = realpathSync.native(filePath)
  const bytes = readFileSync(source)
  const text = bytes.toString('utf8')
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) throw new Error(`${filePath}: expected an object with an "mcpServers" object`)
  return { document: parsed, servers: parsed.mcpServers ?? {}, text, sha256: mcpFileDigest(bytes), source }
}

/** 文件身份按真实路径比较（Windows 不区分大小写）；不存在的文件退回绝对路径。 */
function fileIdentity(path: string): string {
  const canonical = existsSync(path) ? realpathSync.native(path) : resolve(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function checkNamespace(name: string, entries: ReadonlyMap<string, unknown>): void {
  const collision = [...entries.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name))
  if (collision !== undefined) throw new Error(`server "${name}" 与 "${collision}" 工具命名空间冲突`)
}

/** 整包纯校验供 RPC 在任何 vault 写入前调用；同步保存复用同一批规则。 */
export function validateMcpDefinitions(definitions: readonly McpServerDef[]): Record<string, Record<string, unknown>> {
  const validated = new Map<string, McpServerDef>()
  const rawEntries: Array<[string, Record<string, unknown>]> = []
  for (const definition of definitions) {
    if (validated.has(definition.name)) throw new ProtocolError(RpcErrorCode.InvalidParams, `server 名重复: ${definition.name}`)
    const raw = mcpDefToRaw(definition)
    const parsed = parseMcpServerDefinition(definition.name, raw)
    try { checkNamespace(definition.name, validated) } catch (error) { throw new ProtocolError(RpcErrorCode.InvalidParams, errorText(error)) }
    validated.set(definition.name, parsed)
    rawEntries.push([definition.name, raw])
  }
  return Object.fromEntries(rawEntries)
}

export class McpConfigStore {
  private readonly userFile: string
  readonly trust: McpTrustStore

  constructor(root: string, trust?: McpTrustStore) {
    this.userFile = join(root, 'mcp.json')
    this.trust = trust ?? new McpTrustStore(root)
  }

  private projectFile(cwd: string): string { return join(cwd, '.cogent', 'mcp.json') }

  resolve(cwd?: string, projectId?: string): { servers: CogentMcpEntry[]; errors: string[]; pendingTrustFiles: McpPendingTrustFile[] } {
    const entries = new Map<string, CogentMcpEntry>()
    const errors = [...this.trust.errors]
    const pending = new Map<string, McpPendingTrustFile>()
    const files: Array<{ path: string; origin: CogentMcpEntry['origin'] }> = [{ path: this.userFile, origin: 'user' }]
    if (cwd !== undefined) files.push({ path: join(cwd, '.mcp.json'), origin: 'project-file' }, { path: this.projectFile(cwd), origin: 'project-cogent' })
    const seen = new Set<string>()
    for (const { path, origin } of files) {
      // 默认主目录会话的 <cwd>/.cogent/mcp.json 就是用户文件：再读一遍会把用户定义变成未受信的项目定义。
      const identity = fileIdentity(path)
      if (seen.has(identity)) continue
      seen.add(identity)
      let file: ConfigFile
      try { file = readConfigFile(path) } catch (error) { errors.push(`${path}: ${errorText(error)}`); continue }
      for (const [name, raw] of Object.entries(file.servers)) {
        try {
          if (origin !== 'user' && isRecord(raw) && isMcpServerOverride(raw)) {
            const base = entries.get(name)
            if (base === undefined) throw new Error(`server "${name}" 没有可覆盖的用户级定义`)
            const extra = Object.keys(raw).filter((key) => !(OVERRIDE_KEYS as readonly string[]).includes(key))
            if (extra.length > 0) throw new Error(`server "${name}" 的 override 只能覆盖 ${OVERRIDE_KEYS.join(', ')}`)
            const override = parseMcpServerDefinition(name, { ...mcpDefToRaw(base.config), ...raw })
            entries.set(name, { ...base, config: effectiveConfig(override), override: file.source })
            continue
          }
          const definition = parseMcpServerDefinition(name, raw)
          checkNamespace(name, entries)
          const trusted = origin === 'user' || this.trust.isTrusted(projectId, file.source, file.sha256, name)
          entries.set(name, { name, config: effectiveConfig(definition), definition, source: file.source, scope: origin === 'user' ? 'global' : 'project', origin, trusted })
          if (!trusted) {
            let item = pending.get(file.source)
            if (item === undefined) {
              item = { ...(projectId !== undefined && { projectId }), filePath: file.source, sha256: file.sha256, servers: [] }
              pending.set(file.source, item)
            }
            item.servers.push({ name, type: definition.type, ...(definition.type === 'stdio' ? { command: definition.command } : { url: definition.url }),
              envKeys: definition.type === 'stdio' ? Object.keys(definition.env ?? {}) : [], headerKeys: definition.type === 'stdio' ? [] : Object.keys(definition.headers ?? {}) })
          }
        } catch (error) { errors.push(`${path}: ${errorText(error)}`) }
      }
    }
    const pendingTrustFiles = [...pending.values()].map((file) => ({ ...file,
      servers: file.servers.filter((server) => entries.get(server.name)?.source === file.filePath)
    })).filter((file) => file.servers.length > 0)
    return { servers: [...entries.values()], errors, pendingTrustFiles }
  }

  list(cwd?: string, projectId?: string): McpListResult {
    const resolved = this.resolve(cwd, projectId)
    const servers: McpServerSummary[] = resolved.servers.map((entry) => {
      const definition = entry.definition ?? entry.config
      let override: McpSettingsPatch | undefined
      if (entry.override !== undefined) {
        try {
          const raw = readConfigFile(entry.override).servers[entry.name]
          if (isRecord(raw) && isMcpServerOverride(raw) && exposureError(raw) === undefined) override = raw
        } catch (error) { resolved.errors.push(`${entry.override}: ${errorText(error)}`) }
      }
      return {
        name: entry.name, type: entry.config.type,
        detail: entry.config.type === 'stdio' ? [entry.config.command, ...(entry.config.args ?? [])].join(' ') : entry.config.url,
        ...(entry.config.description !== undefined && { description: entry.config.description }),
        enabled: entry.config.enabled !== false, exposure: effectiveExposure(entry.config.exposure), def: definition,
        origin: entry.origin, source: entry.source, trusted: entry.trusted,
        ...(entry.config.toolExposure !== undefined && { toolExposure: entry.config.toolExposure }),
        ...(entry.override !== undefined && { overrideApplied: true, ...(override !== undefined && { override }) })
      }
    })
    return { servers, errors: resolved.errors, pendingTrustFiles: resolved.pendingTrustFiles }
  }

  /** 旧工厂的适配；新连接池直接用 resolve，不会通过此处将 SSE 降成 HTTP。 */
  snapshot(cwd: string, projectId?: string): LoadedMcpConfig {
    const resolved = this.resolve(cwd, projectId)
    const servers: McpServerEntry[] = []
    for (const entry of resolved.servers) {
      if (!entry.trusted || entry.config.type === 'sse') continue
      const config = entry.config.type === 'stdio' ? entry.config : { ...entry.config, type: 'http' as const }
      servers.push({ name: entry.name, config, source: entry.source, scope: entry.scope, ...(entry.override !== undefined && { override: entry.override }) })
    }
    return { servers, errors: resolved.errors }
  }

  override(cwd: string, name: string, patch: McpSettingsPatch): void {
    const patchError = exposureError(patch)
    if (patchError !== undefined || (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')) throw new ProtocolError(RpcErrorCode.InvalidParams, patchError ?? 'enabled must be boolean')
    // 项目自己的定义在其来源文件原位更新；新摘要自然失去旧授权，绝不改成用户级定义。
    const effective = this.resolve(cwd).servers.find((entry) => entry.name === name)
    if (effective?.scope === 'project' && effective.override === undefined) {
      const file = readConfigFile(effective.source)
      const raw = file.servers[name]
      if (!isRecord(raw) || isMcpServerOverride(raw)) throw new ProtocolError(RpcErrorCode.InvalidParams, '项目 MCP 定义已变化，请刷新后重试')
      const candidate = { ...raw, ...patch }
      parseMcpServerDefinition(name, candidate)
      writeMcpFileAtomically(effective.source, `${JSON.stringify({ ...file.document, mcpServers: { ...file.servers, [name]: candidate } }, null, /^([ \t]+)\S/m.exec(file.text)?.[1] ?? '  ')}\n`)
      return
    }
    if (effective === undefined && !this.resolve().servers.some((entry) => entry.name === name)) throw new ProtocolError(RpcErrorCode.InvalidParams, `没有名为 "${name}" 的用户级 MCP server 可覆盖`)
    const projectFile = this.projectFile(cwd)
    // 项目主根就是用户级配置目录时没有独立的项目槽位：明确拒绝，不把单个项目的意图写进所有会话共用的用户定义。
    if (effective?.override === undefined && fileIdentity(projectFile) === fileIdentity(this.userFile)) throw new ProtocolError(RpcErrorCode.InvalidParams, '此项目的主根就是用户级 MCP 配置目录，无法单独覆盖用户级定义，请在用户级设置中修改')
    const path = effective?.override ?? projectFile
    const file = readConfigFile(path)
    const previous = file.servers[name]
    if (isRecord(previous) && !isMcpServerOverride(previous)) throw new ProtocolError(RpcErrorCode.InvalidParams, '项目文件已有同名 server 定义，不能以 override 覆盖定义')
    const next = { ...file.servers }
    if (Object.keys(patch).length === 0) delete next[name]
    else Object.defineProperty(next, name, { value: patch, enumerable: true, configurable: true, writable: true })
    const indent = /^([ \t]+)\S/m.exec(file.text)?.[1] ?? '  '
    writeMcpFileAtomically(path, `${JSON.stringify({ ...file.document, mcpServers: next }, null, indent)}\n`)
  }

  sync(definitions: McpServerDef[]): number {
    const servers = validateMcpDefinitions(definitions)
    // 编辑 server 不应清掉其他客户端的顶层扩展配置。
    const file = readConfigFile(this.userFile)
    writeMcpFileAtomically(this.userFile, `${JSON.stringify({ ...file.document, mcpServers: servers }, null, 2)}\n`)
    return definitions.length
  }

  applyPatch(entry: Pick<McpServerEntry, 'name' | 'source' | 'override'>, patch: McpSettingsPatch): void {
    const path = entry.override ?? entry.source
    const file = readConfigFile(path)
    const raw = file.servers[entry.name]
    if (!isRecord(raw) && entry.override === undefined) throw new Error(`${path} 未定义 MCP server "${entry.name}"`)
    const server = isRecord(raw) ? { ...raw } : {}
    const keepDefaults = isMcpServerOverride(server)
    const patchError = exposureError(patch)
    if (patchError !== undefined) throw new ProtocolError(RpcErrorCode.InvalidParams, patchError)
    if (patch.enabled !== undefined) {
      if (patch.enabled && !keepDefaults) delete server.enabled
      else server.enabled = patch.enabled
    }
    if (patch.exposure !== undefined) {
      if (patch.exposure === 'deferred' && !keepDefaults) delete server.exposure
      else server.exposure = patch.exposure
    }
    if (patch.toolExposure !== undefined) server.toolExposure = patch.toolExposure
    const indent = /^([ \t]+)\S/m.exec(file.text)?.[1] ?? '  '
    writeMcpFileAtomically(path, `${JSON.stringify({ ...file.document, mcpServers: { ...file.servers, [entry.name]: server } }, null, indent)}\n`)
  }
}
