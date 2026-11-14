/**
 * MCP 客户端配置 store（阶段 4a，docs/计划/MCP座实现.md §3）——
 * Host 侧的 MCP server 配置真源，pi `createMcpExtension` 的配置供给方。
 *
 * 两级文件（与 pi 语义对齐，出处 reference/pi/packages/coding-agent/src/
 * extensions/mcp/config.ts:83-131）：
 * - user 级 `<root>/mcp.json`：server 定义（唯一可定义新 server 的地方），
 *   `mcpServers` 通用形状（pi-mcp config.d.ts —— 与生态互拷）；
 * - 项目级 `<cwd>/.cogent/mcp.json`：仅 override（enabled/exposure/
 *   toolExposure，`isMcpServerOverride` 判别）—— 低信文件开不了新进程，
 *   是天然的信任门（zcode 工作区信任门的轻量等价物）。
 *
 * 快照语义（Pi-meme 手法，packages/pi-runtime/src/sdk/session.ts:793 同款
 * 思路）：SessionManager 装配 pi 会话时调 snapshot() 定格合并结果，之后
 * 改配置不影响在跑会话（新会话生效）；updateConfig 写回文件供 /mcp 通道
 * （headless 不可达，保留契约完整）。
 *
 * 边界：配置文件是外部输入（约定.md §1.1 持久化读取）——损坏 JSON /
 * 非法条目逐条诊断收集，不炸构造（list/snapshot 带回 errors）；mcp.sync
 * 是手动设置动作，非法输入显式 throw（fail-fast）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isMcpServerOverride,
  mcpNamespace,
  validateMcpServerConfig,
  type McpServerConfigResult
} from '@earendil-works/pi-mcp'
import type { LoadedMcpConfig, McpExposure, McpServerConfig, McpServerEntry } from '@earendil-works/pi-coding-agent'
import type { McpListResult, McpServerDef, McpServerSummary } from '../../protocol'
import { ProtocolError, RpcErrorCode } from '../../protocol'

/** 项目级 override 可写的键（pi OVERRIDE_KEYS，config.ts:71 同款） */
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'] as const

const MCP_EXPOSURES: readonly McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden']

/** pi 的 core/mcp-servers.ts:180-190 同款检查（pi 包未从 index 导出该函数，此处镜像）：
    pi-mcp 的校验器对未知字段（exposure/toolExposure 是 pi 应用层字段）原样保留不查 */
function checkExposureFields(name: string, config: Record<string, unknown>): string | undefined {
  const exposures = MCP_EXPOSURES.map((value) => `"${value}"`).join(', ')
  if (config.exposure !== undefined && !MCP_EXPOSURES.includes(config.exposure as McpExposure)) {
    return `server "${name}": exposure must be one of ${exposures}`
  }
  if (config.toolExposure !== undefined) {
    const entries = config.toolExposure
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      return `server "${name}": toolExposure must map tool names to exposures`
    }
    for (const [tool, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!MCP_EXPOSURES.includes(value as McpExposure)) {
        return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`
      }
    }
  }
  return undefined
}

/**
 * pi-mcp 校验器的返回类型是 `McpServerConfig & Record<string, unknown>`
 * （未知字段原样保留不查）——exposure/toolExposure 是 pi 应用层字段，不在
 * 其类型上。值域已由 checkExposureFields 运行时核过，这里只收掉索引签名
 * 补类型面（忘掉 Record 不丢运行时字段， widen 而非断言）。
 */
type ValidatedMcpConfig = Extract<McpServerConfigResult, { kind: 'stdio' | 'http' }>['config']

function asPiConfig(config: ValidatedMcpConfig): McpServerConfig {
  return config
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读 mcp.json 顶层（BOM 容错：Windows 手改文件常见）——解析失败带回诊断而非炸 */
function readConfigFile(path: string): { mcpServers: Record<string, unknown>; error?: string } {
  if (!existsSync(path)) return { mcpServers: {} }
  let text = readFileSync(path, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { mcpServers: {}, error: `${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    return { mcpServers: {}, error: `${path}: expected an object with an "mcpServers" object` }
  }
  return { mcpServers: parsed.mcpServers ?? {} }
}

/** 协议 def → 盘上通用形状（type 恒显式写出：自描述，手改文件可读） */
function defToRaw(def: McpServerDef): Record<string, unknown> {
  const shared = {
    ...(def.description !== undefined && { description: def.description }),
    ...(def.enabled !== undefined && { enabled: def.enabled }),
    ...(def.exposure !== undefined && { exposure: def.exposure }),
    ...(def.timeout !== undefined && { timeout: def.timeout })
  }
  return def.type === 'stdio'
    ? {
        type: 'stdio',
        command: def.command,
        ...(def.args !== undefined && { args: def.args }),
        ...(def.env !== undefined && { env: def.env }),
        ...(def.cwd !== undefined && { cwd: def.cwd }),
        ...shared
      }
    : { type: 'http', url: def.url, ...(def.headers !== undefined && { headers: def.headers }), ...shared }
}

/** 原子替换写（JsonStorageDriver 同款纪律，json-driver.ts:46-53：tmp + rename，Windows 同卷原子） */
function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** pi settings 补丁（config.ts:150-154 McpServerConfigPatch 的结构镜像；pi 包未导出该类型） */
export interface McpSettingsPatch {
  enabled?: boolean
  exposure?: McpExposure
}

export class McpConfigStore {
  private readonly userFile: string

  constructor(root: string) {
    this.userFile = join(root, 'mcp.json')
  }

  /** 项目级 override 文件路径（会话主根下的 .cogent/mcp.json） */
  private projectFile(cwd: string): string {
    return join(cwd, '.cogent', 'mcp.json')
  }

  /** user 级条目校验装载（list 与 snapshot 的共用底座） */
  private loadUser(errors: string[]): Map<string, McpServerEntry> {
    const servers = new Map<string, McpServerEntry>()
    const { mcpServers, error } = readConfigFile(this.userFile)
    if (error !== undefined) errors.push(error)
    for (const [name, value] of Object.entries(mcpServers)) {
      const result = validateMcpServerConfig(name, value)
      if (result.kind === 'invalid') {
        errors.push(`${this.userFile}: ${result.error}`)
        continue
      }
      const exposureError = checkExposureFields(name, result.config)
      if (exposureError !== undefined) {
        errors.push(`${this.userFile}: ${exposureError}`)
        continue
      }
      // 名字只差 -/_ 的两个 server 共享工具命名空间（pi config.ts:119-124 同查）
      const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name))
      if (clash !== undefined) {
        errors.push(`${this.userFile}: server "${name}" conflicts with "${clash}"`)
        continue
      }
      servers.set(name, { name, config: asPiConfig(result.config), source: this.userFile, scope: 'global' })
    }
    return servers
  }

  /** user 级摘要（mcp.list 响应；项目级 override 是 cwd 相关的高级面，不进本视图） */
  list(): McpListResult {
    const errors: string[] = []
    const servers = this.loadUser(errors)
    const summaries: McpServerSummary[] = [...servers.values()].map(({ name, config }) => ({
      name,
      type: 'url' in config ? 'http' : 'stdio',
      detail: 'url' in config ? config.url : [config.command, ...(config.args ?? [])].join(' '),
      ...(config.description !== undefined && { description: config.description }),
      enabled: config.enabled !== false,
      exposure: config.exposure ?? 'codemode'
    }))
    return { servers: summaries, errors }
  }

  /**
   * 合并快照（会话装配用，Pi-meme 快照语义的定格点）：user 定义 + 项目级
   * override。项目级条目限制比 pi 更严 —— 只收 override（带 command/url/type
   * 的定义条目显式报错跳过，pi 允许项目定义 server，Cogent 的信任门不开）。
   */
  snapshot(cwd: string): LoadedMcpConfig {
    const errors: string[] = []
    const servers = this.loadUser(errors)
    const projectPath = this.projectFile(cwd)
    const { mcpServers: projectEntries, error } = readConfigFile(projectPath)
    if (error !== undefined) errors.push(error)
    for (const [name, value] of Object.entries(projectEntries)) {
      if (!isRecord(value)) {
        errors.push(`${projectPath}: server "${name}" must be an object`)
        continue
      }
      // override 判别（isMcpServerOverride：无 command/url/type 即 override 条目）
      if (!isMcpServerOverride(value)) {
        errors.push(`${projectPath}: server "${name}" 定义了新 server —— 项目级 mcp.json 只能覆盖 ${OVERRIDE_KEYS.join('/')}（定义请放用户级 ~/.cogent/mcp.json）`)
        continue
      }
      const base = servers.get(name)
      if (base === undefined) {
        errors.push(`${projectPath}: server "${name}" 没有可覆盖的用户级定义`)
        continue
      }
      const extra = Object.keys(value).filter((key) => !(OVERRIDE_KEYS as readonly string[]).includes(key))
      if (extra.length > 0) {
        errors.push(`${projectPath}: server "${name}" 的 override 只能设 ${OVERRIDE_KEYS.join(', ')}`)
        continue
      }
      const merged = validateMcpServerConfig(name, { ...base.config, ...value })
      if (merged.kind === 'invalid') {
        errors.push(`${projectPath}: ${merged.error}`)
        continue
      }
      servers.set(name, { ...base, config: asPiConfig(merged.config), override: projectPath })
    }
    return { servers: [...servers.values()], errors }
  }

  /**
   * 全量写 user 级定义（mcp.sync 委托，替换语义）：先整包校验，任一非法
   * 即 throw（手动设置动作要明确反馈，不半写）；通过后原子写盘。
   * 载荷已在 dispatch 入口按协议类型收窄（stdio 帧边界），这里只跑
   * 入口窄化覆盖不到的规则：server 名字符规则（pi-mcp 校验器）与命名空间撞名。
   */
  sync(defs: McpServerDef[]): number {
    const raw: Record<string, unknown> = {}
    const errors: string[] = []
    const seen = new Set<string>()
    for (const def of defs) {
      if (seen.has(def.name)) {
        errors.push(`server 名重复: ${def.name}`)
        continue
      }
      seen.add(def.name)
      const result = validateMcpServerConfig(def.name, defToRaw(def))
      if (result.kind === 'invalid') {
        errors.push(`server "${def.name}": ${result.error}`)
        continue
      }
      const clash = defs.some((other) => other.name !== def.name && mcpNamespace(other.name) === mcpNamespace(def.name))
      if (clash) {
        errors.push(`server "${def.name}" 与其他条目只差 -/_，工具命名空间冲突`)
        continue
      }
      raw[def.name] = defToRaw(def)
    }
    if (errors.length > 0) {
      throw new ProtocolError(RpcErrorCode.InvalidParams, errors.join('；'))
    }
    atomicWrite(this.userFile, `${JSON.stringify({ mcpServers: raw }, null, 2)}\n`)
    return defs.length
  }

  /**
   * 设置补丁写回（createMcpExtension 的 updateConfig 通道）：目标 = 项目级
   * override 文件（条目带 override 时）否则用户级定义文件。pi 的
   * updateMcpServerConfig（config.ts:161-185）同款语义 —— 默认值（enabled:
   * true / codemode）在定义文件里删键、在 override 里保留显式值。
   */
  applyPatch(entry: McpServerEntry, patch: McpSettingsPatch): void {
    const path = entry.override ?? entry.source
    let text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed: unknown = text === '' ? {} : JSON.parse(text)
    if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
      throw new Error(`${path}: expected an object with an "mcpServers" object`)
    }
    const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined
    let server = servers?.[entry.name]
    // override 文件里缺条目 = 新增 override（pi updateMcpServerConfig 的 override 语义）
    if (server === undefined && entry.override !== undefined) {
      server = {}
      parsed.mcpServers = { ...servers, [entry.name]: server }
    }
    if (!isRecord(server)) {
      throw new Error(`${path} 未定义 MCP server "${entry.name}"`)
    }
    const keepDefaults = isMcpServerOverride(server)
    if (patch.enabled !== undefined) {
      if (patch.enabled && !keepDefaults) delete server.enabled
      else server.enabled = patch.enabled
    }
    if (patch.exposure !== undefined) {
      if (patch.exposure === 'codemode' && !keepDefaults) delete server.exposure
      else server.exposure = patch.exposure
    }
    // 保留原缩进（手改文件的习惯格式不被整包重排）
    const indent = (/^([ \t]+)\S/m.exec(text)?.[1]) ?? '  '
    atomicWrite(path, `${JSON.stringify(parsed, null, indent)}\n`)
  }
}
