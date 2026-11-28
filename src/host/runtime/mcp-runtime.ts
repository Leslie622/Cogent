/**
 * Host 单例 MCP 运行时：连接归池、会话仅持作用域引用，避免每个聊天重复启动进程。
 * 所有读取与调用先重新核对配置/信任；连接代次隔离晚到的建连和通知结果。
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createMcpToolName, McpAuthRequiredError, McpClient, McpError,
  type AuthProvider, type CallToolResult, type McpTransport, type Resource,
  type ResourceTemplate, type Tool
} from '@earendil-works/pi-mcp'
import type {
  McpExposure, McpListResult, McpPromptInfo, McpResourceInfo, McpResourceTemplateInfo,
  McpScope, McpServerDef, McpServerRuntimeStatus, McpToolInfo
} from '../../protocol'
import { McpConfigStore, type CogentMcpEntry } from './mcp-config'
import { dependsOnProject, expandMcpValue, MCP_SENSITIVE_ENV, resolveMcpEnvironment } from './mcp-env'
import { closeMcpTransport, createMcpTransport, type McpTransportOptions } from './mcp-transports'

export type McpRuntimeScope = McpScope
export type McpRuntimeStatus = McpServerRuntimeStatus
export interface McpRuntimeTool extends McpToolInfo { serverName: string; outputSchema?: Record<string, unknown>; serverDescription?: string }
export interface McpCallContext { sessionId?: string; signal?: AbortSignal }

export interface McpRuntimeOptions {
  config: McpConfigStore
  hostRoot: string
  authProvider?: (entry: CogentMcpEntry, scope: McpRuntimeScope) => AuthProvider | undefined
  oauthAuthorized?: (def: McpServerDef, scope: McpRuntimeScope) => boolean
  onStatus?: (statuses: McpServerRuntimeStatus[], scope?: McpRuntimeScope) => void
  onElicitation?: (params: unknown, context: { server: string; sessionId?: string; signal?: AbortSignal }) => Promise<unknown>
  /** 测试可注入真实协议管道；生产始终使用统一传输工厂。 */
  transportFactory?: (def: McpServerDef, options: McpTransportOptions) => McpTransport
  idleTimeoutMs?: number
  startupTimeoutMs?: number
}

interface PoolEntry {
  key: string
  entry: CogentMcpEntry
  scope: McpRuntimeScope
  fingerprint: string
  client?: McpClient
  transport?: McpTransport
  ready?: Promise<void>
  status: McpServerRuntimeStatus
  tools: McpRuntimeTool[]
  resources: Resource[]
  templates: ResourceTemplate[]
  prompts: McpPromptInfo[]
  closing: boolean
  activeCall?: McpCallContext
  callQueue: Promise<void>
  capabilityQueue: Promise<void>
  idleTimer?: ReturnType<typeof setTimeout>
  secrets: string[]
}

interface ScopeView { scope: McpRuntimeScope; entries: CogentMcpEntry[]; keys: string[] }

function actualPath(path: string): string {
  const absolute = resolve(path)
  const canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function scopeId(scope: McpRuntimeScope): string {
  return `${scope.projectId ?? ''}\0${scope.cwd === undefined ? '' : actualPath(scope.cwd)}`
}

function exposureOf(def: McpServerDef, tool: string): McpExposure {
  const overrides = def.toolExposure ?? {}
  let exposure = Object.entries(overrides).find(([name]) => name === tool)?.[1]
  if (exposure === undefined) {
    for (const [pattern, value] of Object.entries(overrides)) {
      if (!pattern.includes('*')) continue
      const expression = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      if (new RegExp(`^${expression}$`).test(tool)) { exposure = value; break }
    }
  }
  const result = exposure ?? def.exposure ?? 'deferred'
  return result === 'codemode' ? 'deferred' : result
}

/** 暴露与启停属于调用作用域策略，不是共享传输的身份。 */
function connectionIdentity(def: McpServerDef): Record<string, unknown> {
  const { enabled: _enabled, exposure: _exposure, toolExposure: _tools, description: _description, ...connection } = def
  return connection
}

/** 提取最外层占位符；默认值可含字面量 ${...}，不能把它再次当变量求值。 */
function templateTokens(value: string): string[] {
  const tokens: string[] = []
  let offset = 0
  while (offset < value.length) {
    const start = value.indexOf('${', offset)
    if (start < 0) break
    let depth = 1; let end = start + 2
    for (; end < value.length; end++) {
      if (value[end] === '$' && value[end + 1] === '{') { depth++; end++ }
      else if (value[end] === '}' && --depth === 0) break
    }
    tokens.push(value.slice(start, end + 1)); offset = end + 1
  }
  return tokens
}

/** 只列出真正展开的连接字段；描述、未知扩展与默认值中的字面量不构成凭据依赖。 */
function transportFields(def: McpServerDef): string[] {
  return def.type === 'stdio'
    ? [def.command, ...(def.args ?? []), ...(def.cwd === undefined ? [] : [def.cwd]), ...Object.values(def.env ?? {})]
    : [def.url, ...Object.values(def.headers ?? {}), ...(def.oauth?.clientSecret === undefined ? [] : [def.oauth.clientSecret])]
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join('[REDACTED]')
  return result
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|token|api_key|key|client_secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|secret|password|credential|token)\s*[:=]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
}

export class McpRuntimeManager {
  private readonly pool = new Map<string, PoolEntry>()
  private readonly scopes = new Map<string, ScopeView>()
  private readonly scopeWork = new Map<string, Promise<void>>()
  private readonly references = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private disposed = false

  constructor(private readonly options: McpRuntimeOptions) {}

  getRevision(): number { return this.revision }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  /** 会话 dispose 主动释放；pi 的 session_shutdown 并非所有 SDK 退出路径都会发送。 */
  retainScope(scope: McpRuntimeScope): () => void {
    const id = scopeId(scope)
    this.references.set(id, (this.references.get(id) ?? 0) + 1)
    for (const key of this.scopes.get(id)?.keys ?? []) clearTimeout(this.pool.get(key)?.idleTimer)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.references.get(id) ?? 1) - 1
      if (count === 0) this.references.delete(id)
      else this.references.set(id, count)
      this.scheduleIdle()
    }
  }

  private key(entry: CogentMcpEntry, scope: McpRuntimeScope): string {
    const project = entry.scope === 'project' || dependsOnProject(entry.config)
    return project ? `project:${scopeId(scope)}:${entry.name}` : `global:${entry.name}`
  }

  private publish(record: PoolEntry): void {
    if (this.disposed || this.pool.get(record.key) !== record) return
    record.status.updatedAt = new Date().toISOString()
    record.status.revision = ++this.revision
    if (!record.key.startsWith('probe:')) {
      const views = [...this.scopes.values()].filter((view) => view.keys.includes(record.key))
      for (const view of views) {
        const status = this.getStatuses(view.scope).find((status) => status.poolKey === record.key)
        if (status !== undefined) this.options.onStatus?.([status], view.scope)
      }
    }
    for (const listener of this.listeners) listener()
  }

  private status(record: PoolEntry): McpServerRuntimeStatus {
    return structuredClone({ ...record.status, tools: record.tools.map(({ serverName: _server, outputSchema: _schema, ...tool }) => tool) })
  }

  /** 同一作用域的并发发现共享一次工作；每次完成都以当前配置替换原视图。 */
  async ensureScope(scope: McpRuntimeScope = {}): Promise<void> {
    if (this.disposed) throw new Error('MCP runtime has been disposed')
    const id = scopeId(scope)
    const previous = this.scopeWork.get(id)
    if (previous !== undefined) { await previous; return }
    const work = this.reconcile(scope)
    this.scopeWork.set(id, work)
    try { await work } finally { if (this.scopeWork.get(id) === work) this.scopeWork.delete(id) }
  }

  private async reconcile(scope: McpRuntimeScope): Promise<void> {
    const loaded = this.options.config.resolve(scope.cwd, scope.projectId)
    const id = scopeId(scope)
    const oldKeys = this.scopes.get(id)?.keys ?? []
    const keys: string[] = []
    const ready: Promise<void>[] = []
    for (const entry of loaded.servers) {
      const key = this.key(entry, scope)
      // 信任必须在碰连接池之前求值，同目录的其他项目不能借用已连实例。
      const enabled = entry.config.enabled !== false
      if (!enabled || !entry.trusted) continue
      keys.push(key)
      const fingerprint = createHash('sha256').update(JSON.stringify({ config: connectionIdentity(entry.config), source: entry.source })).digest('hex')
      let record = this.pool.get(key)
      while (record !== undefined && record.fingerprint !== fingerprint) {
        const previous = record
        await this.close(previous)
        if (this.pool.get(key) === previous) this.pool.delete(key)
        // 其他作用域可能已在 await 期间建好替代连接，直接认领而非覆盖它。
        record = this.pool.get(key)
      }
      if (this.disposed) return
      if (record === undefined) {
        record = {
          key, entry, scope: { ...scope }, fingerprint, tools: [], resources: [], templates: [], prompts: [],
          closing: false, callQueue: Promise.resolve(), capabilityQueue: Promise.resolve(), secrets: [],
          status: {
            name: entry.name, poolKey: key, state: 'connecting',
            tools: [], resourcesCount: 0, promptsCount: 0, updatedAt: new Date().toISOString()
          }
        }
        this.pool.set(key, record)
        this.publish(record)
        record.ready = this.connect(record)
      }
      if (record.ready !== undefined) ready.push(record.ready)
      ready.push(record.capabilityQueue)
    }
    this.scopes.set(id, { scope: { ...scope }, entries: loaded.servers, keys })
    this.options.onStatus?.(this.getStatuses(scope), scope)
    for (const key of oldKeys) {
      if (keys.includes(key)) continue
      const used = [...this.scopes.values()].some((view) => view.keys.includes(key))
      const record = this.pool.get(key)
      if (!used && record !== undefined) { await this.close(record); this.pool.delete(key) }
    }
    await Promise.all(ready)
    this.scheduleIdle()
  }

  private async connect(record: PoolEntry): Promise<void> {
    const started = performance.now()
    try {
      const def = resolveMcpEnvironment(record.entry.config, { projectDir: record.scope.cwd })
      const sensitive: string[] = []
      const source = record.entry.config
      for (const token of transportFields(source).flatMap(templateTokens)) {
        // 环境占位符不一定使用 *_TOKEN 名；诊断脱敏必须覆盖所有展开值。
        sensitive.push(expandMcpValue(token, { projectDir: record.scope.cwd }))
      }
      if (def.type === 'stdio') {
        for (const [name, value] of Object.entries(def.env ?? {})) if (MCP_SENSITIVE_ENV.test(name)) sensitive.push(value)
        // 全局共享 server 的缺省工作目录固定，不能偷偷绑定首个使用它的项目。
        def.cwd ??= homedir()
      } else {
        sensitive.push(...Object.values(def.headers ?? {}))
        if (def.oauth?.clientSecret !== undefined) sensitive.push(def.oauth.clientSecret)
      }
      record.secrets = [...new Set(sensitive.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length)
      const transportOptions: McpTransportOptions = {
        authProvider: def.type === 'stdio' ? undefined : this.options.authProvider?.({ ...record.entry, config: def }, record.key.startsWith('global:') ? {} : record.scope),
        onStderr: (text) => {
          const safe = redact(text, record.secrets)
          record.status.stderrTail = `${record.status.stderrTail ?? ''}${safe}`.slice(-4000)
          this.log(record.entry.name, safe)
          this.publish(record)
        }
      }
      const transport = (this.options.transportFactory ?? createMcpTransport)(def, transportOptions)
      const project = record.key.startsWith('project:') && record.scope.cwd !== undefined
      const client = new McpClient({
        name: 'Cogent', version: '0.1.0', requestTimeoutMs: (def.timeout ?? 60) * 1000,
        capabilities: { ...(this.options.onElicitation === undefined ? {} : { elicitation: { form: {}, url: {} } }), ...(project ? { roots: { listChanged: false } } : {}) },
        roots: project ? [{ uri: pathToFileURL(actualPath(record.scope.cwd!)).href }] : []
      })
      record.client = client; record.transport = transport
      client.onClose(() => {
        if (record.closing || this.pool.get(record.key) !== record) return
        record.status.state = 'disconnected'; record.tools = []
        this.publish(record)
      })
      client.onError((error) => { record.status.error = redact(error.message, record.secrets); this.publish(record) })
      client.setRequestHandler('elicitation/create', async (params, context) => {
        const active = record.activeCall
        if (active?.sessionId === undefined || this.options.onElicitation === undefined) return { action: 'cancel' }
        const signal = active.signal === undefined ? context.signal : AbortSignal.any([context.signal, active.signal])
        return this.options.onElicitation(params, { server: record.entry.name, sessionId: active.sessionId, signal })
      })
      // 初始化期间也可收到 list_changed；先订阅并在连接完成后以缓存重读收敛。
      for (const [method, part] of [
        ['notifications/tools/list_changed', 'tools'],
        ['notifications/resources/list_changed', 'resources'],
        ['notifications/prompts/list_changed', 'prompts']
      ] as const) {
        client.onNotification(method, () => {
          if (record.status.state !== 'connected') return
          void this.serialize(record, {}, () => this.refreshCapabilities(record, part)).catch((error: unknown) => {
            record.status.error = redact(error instanceof Error ? error.message : String(error), record.secrets)
            this.publish(record)
          })
        })
      }
      client.onNotification('notifications/message', (params) => this.log(record.entry.name, redact(JSON.stringify(params), record.secrets)))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('MCP connection timed out')), this.options.startupTimeoutMs ?? 10_000) })
        ])
      } finally { clearTimeout(timer) }
      if (this.disposed || record.closing || this.pool.get(record.key) !== record) { await this.close(record); return }
      await this.refreshCapabilities(record)
      record.status.state = 'connected'
      record.status.latencyMs = Math.round(performance.now() - started)
      record.status.serverInfo = client.serverInfo
      record.status.protocolVersion = client.protocolVersion
      record.status.instructions = client.instructions === undefined ? undefined : redact(client.instructions, record.secrets)
      record.status.error = undefined
      this.publish(record)
    } catch (error) {
      if (this.pool.get(record.key) !== record || this.disposed) return
      const reason = error instanceof Error ? error : new Error(String(error))
      record.status.state = error instanceof McpAuthRequiredError || reason.name === 'McpOAuthAuthorizationRequiredError' ? 'needs-auth' : 'failed'
      record.status.error = redact(reason.message, record.secrets)
      await this.close(record, false)
      this.publish(record)
    }
  }

  private isCurrent(record: PoolEntry): boolean { return !this.disposed && !record.closing && this.pool.get(record.key) === record }

  private refreshCapabilities(record: PoolEntry, part?: 'tools' | 'resources' | 'prompts'): Promise<void> {
    const work = record.capabilityQueue.then(() => this.loadCapabilities(record, part))
    record.capabilityQueue = work.catch(() => undefined)
    return work
  }

  private async loadCapabilities(record: PoolEntry, part?: 'tools' | 'resources' | 'prompts'): Promise<void> {
    const client = record.client
    if (client === undefined || record.closing) return
    if ((part === undefined || part === 'tools') && client.serverCapabilities?.tools !== undefined) {
      const tools = await client.listTools()
      const names = tools.map((tool) => createMcpToolName(record.entry.name, tool.name))
      const known = new Set<string>()
      const projected = tools.map((tool: Tool): McpRuntimeTool => {
        const qualifiedName = createMcpToolName(record.entry.name, tool.name, (candidate) => names.indexOf(candidate) !== names.lastIndexOf(candidate) || known.has(candidate))
        known.add(qualifiedName)
        return {
          name: tool.name, qualifiedName, serverName: record.entry.name, description: tool.description,
          inputSchema: tool.inputSchema, annotations: tool.annotations, outputSchema: tool.outputSchema,
          effectiveExposure: exposureOf(record.entry.config, tool.name)
        }
      })
      if (this.isCurrent(record)) record.tools = projected
    }
    if ((part === undefined || part === 'resources') && client.serverCapabilities?.resources !== undefined) {
      const optional = async <T>(request: Promise<T[]>): Promise<T[]> => {
        try { return await request }
        catch (error) { if (error instanceof McpError && error.code === -32601) return []; throw error }
      }
      const [resources, templates] = await Promise.all([optional(client.listResources()), optional(client.listResourceTemplates())])
      if (this.isCurrent(record)) { record.resources = resources; record.templates = templates }
    }
    if ((part === undefined || part === 'prompts') && client.serverCapabilities?.prompts !== undefined) {
      const prompts: McpPromptInfo[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await client.request<{ prompts: Array<Omit<McpPromptInfo, 'server'>>; nextCursor?: string }>('prompts/list', cursor === undefined ? {} : { cursor })
        prompts.push(...page.prompts.map((prompt) => ({ ...prompt, server: record.entry.name })))
        cursor = page.nextCursor
        if (cursor !== undefined && seen.has(cursor)) throw new Error('MCP prompts pagination repeated a cursor')
        if (cursor !== undefined) seen.add(cursor)
      } while (cursor !== undefined)
      if (this.isCurrent(record)) record.prompts = prompts
    }
    record.status.resourcesCount = record.resources.length
    record.status.promptsCount = record.prompts.length
    this.publish(record)
  }

  private log(server: string, text: string): void {
    const directory = join(this.options.hostRoot, 'pi')
    const file = join(directory, 'mcp.log')
    try {
      mkdirSync(directory, { recursive: true })
      if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`)
      appendFileSync(file, `${new Date().toISOString()} [${server}] ${text}\n`)
    } catch (error) {
      // 日志落盘故障不终止工具，但在状态中给出可见诊断。
      const record = [...this.pool.values()].find((entry) => entry.entry.name === server)
      if (record !== undefined) record.status.error = `MCP 日志写入失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  private records(scope: McpRuntimeScope): PoolEntry[] {
    return (this.scopes.get(scopeId(scope))?.keys ?? []).flatMap((key) => {
      const record = this.pool.get(key)
      return record === undefined ? [] : [record]
    })
  }

  private policy(scope: McpRuntimeScope, name: string): CogentMcpEntry | undefined {
    return this.scopes.get(scopeId(scope))?.entries.find((entry) => entry.name === name)
  }

  getStatuses(scope: McpRuntimeScope = {}): McpServerRuntimeStatus[] {
    const view = this.scopes.get(scopeId(scope))
    if (view === undefined) return []
    return view.entries.map((entry) => {
      const key = this.key(entry, scope)
      const record = this.pool.get(key)
      const allowed = entry.config.enabled !== false && entry.trusted
      if (!allowed || record === undefined) return {
        name: entry.name, poolKey: key,
        state: entry.config.enabled === false ? 'disabled' : !entry.trusted ? 'untrusted' : 'disconnected',
        tools: [], resourcesCount: 0, promptsCount: 0, updatedAt: new Date().toISOString()
      }
      return {
        ...this.status(record),
        oauthAuthorized: this.oauthAuthorized(entry, scope),
        tools: record.tools.map(({ serverName: _server, outputSchema: _schema, serverDescription: _description, ...tool }) => ({ ...structuredClone(tool), effectiveExposure: exposureOf(entry.config, tool.name) }))
      }
    })
  }

  private oauthAuthorized(entry: CogentMcpEntry, scope: McpRuntimeScope): boolean {
    if (entry.config.type === 'stdio' || this.options.oauthAuthorized === undefined) return false
    try {
      const def = resolveMcpEnvironment(entry.config, { projectDir: scope.cwd })
      return this.options.oauthAuthorized(def, this.key(entry, scope).startsWith('global:') ? {} : scope)
    } catch {
      // 缺失环境变量等连接诊断由 connect 发布，列表读取不因状态投影失败。
      return false
    }
  }
  hasResources(scope: McpRuntimeScope = {}): boolean {
    return this.records(scope).some((record) => record.status.state === 'connected' && this.policy(scope, record.entry.name)?.config.exposure !== 'hidden' && record.client?.serverCapabilities?.resources !== undefined)
  }
  getTools(scope: McpRuntimeScope = {}): McpRuntimeTool[] {
    return this.records(scope).filter((record) => record.status.state === 'connected').flatMap((record) => {
      const entry = this.policy(scope, record.entry.name)
      if (entry === undefined || !entry.trusted || entry.config.enabled === false) return []
      return record.tools.map((tool) => ({ ...structuredClone(tool), effectiveExposure: exposureOf(entry.config, tool.name), serverDescription: entry.config.description }))
    })
  }
  getToolMeta(scope: McpRuntimeScope, qualifiedName: string): { serverName: string; originalToolName: string; annotations?: McpToolInfo['annotations'] } | undefined {
    const tool = this.getTools(scope).find((candidate) => candidate.qualifiedName === qualifiedName && candidate.effectiveExposure !== 'hidden')
    return tool === undefined ? undefined : { serverName: tool.serverName, originalToolName: tool.name, annotations: tool.annotations }
  }

  async list(scope: McpRuntimeScope = {}): Promise<McpListResult> {
    await this.ensureScope(scope)
    const list = this.options.config.list(scope.cwd, scope.projectId)
    const statuses = new Map(this.getStatuses(scope).map((status) => [status.name, status]))
    return { ...list, servers: list.servers.map((server) => ({ ...server, runtime: statuses.get(server.name) })) }
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.scopes.values()].map(async (view) => {
      await this.ensureScope(view.scope)
      // 首次ensure可能只是接住保存前的启动任务；完成后必须再读已提交的当前配置。
      await this.ensureScope(view.scope)
    }))
  }

  async reconnect(name: string, scope: McpRuntimeScope = {}): Promise<void> {
    const entry = this.options.config.resolve(scope.cwd, scope.projectId).servers.find((entry) => entry.name === name)
    if (entry !== undefined && entry.trusted && entry.config.enabled !== false) {
      const key = this.key(entry, scope)
      const record = this.pool.get(key)
      if (record !== undefined) {
        await this.close(record)
        // 另一作用域可能已先完成重连，只能删除自己刚关闭的连接代次。
        if (this.pool.get(key) === record) this.pool.delete(key)
      }
    }
    await this.scopeWork.get(scopeId(scope))
    await this.ensureScope(scope)
  }

  async probe(def: McpServerDef, scope: McpRuntimeScope = {}): Promise<McpServerRuntimeStatus> {
    const key = `probe:${randomUUID()}`
    const record: PoolEntry = {
      key, entry: { name: def.name, config: def, source: '', scope: 'global', origin: 'user', trusted: true }, scope,
      fingerprint: '', tools: [], resources: [], templates: [], prompts: [], closing: false,
      callQueue: Promise.resolve(), capabilityQueue: Promise.resolve(), secrets: [],
      status: { name: def.name, poolKey: key, state: 'connecting', tools: [], resourcesCount: 0, promptsCount: 0, updatedAt: new Date().toISOString() }
    }
    this.pool.set(key, record)
    try { await this.connect(record); return this.status(record) }
    finally { await this.close(record); this.pool.delete(key) }
  }

  private async connected(scope: McpRuntimeScope, server: string): Promise<PoolEntry> {
    await this.ensureScope(scope)
    const record = this.records(scope).find((candidate) => candidate.entry.name === server)
    if (record === undefined || record.status.state !== 'connected' || record.client === undefined) throw new Error(`MCP server "${server}" is not connected`)
    return record
  }

  private serialize<T>(record: PoolEntry, context: McpCallContext, action: () => Promise<T>): Promise<T> {
    const call = record.callQueue.then(async () => {
      context.signal?.throwIfAborted()
      record.activeCall = {}
      try { return await action() } finally { record.activeCall = undefined }
    })
    record.callQueue = call.then(() => undefined, () => undefined)
    const signal = context.signal
    if (signal === undefined) return call
    // 等候其他会话工具的调用也必须可中止，不能让它等到前一人的表单超时。
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener('abort', abort)
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      call.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
    })
  }

  private withCallContext<T>(record: PoolEntry, scope: McpRuntimeScope, context: McpCallContext, action: (client: McpClient) => Promise<T>): Promise<T> {
    return this.serialize(record, context, async () => {
      await this.ensureScope(scope)
      const current = this.records(scope).find((candidate) => candidate === record)
      if (current === undefined || current.closing || current.client === undefined) throw new Error('MCP connection changed while the call was queued')
      context.signal?.throwIfAborted()
      const callLifetime = new AbortController()
      const signal = context.signal === undefined ? callLifetime.signal : AbortSignal.any([context.signal, callLifetime.signal])
      record.activeCall = { ...context, signal }
      try { return await action(current.client) }
      catch (error) {
        if (error instanceof McpAuthRequiredError || (error instanceof Error && error.name === 'McpOAuthAuthorizationRequiredError')) {
          record.status.state = 'needs-auth'
          record.status.error = redact(error.message, record.secrets)
          await this.close(record, false)
          this.publish(record)
        }
        throw error
      }
      finally {
        // 反向请求不共享 tools/call 的协议 ID；调用本身结束也须取消其未完成表单。
        callLifetime.abort()
      }
    })
  }

  async callTool(scope: McpRuntimeScope, qualifiedName: string, args: Record<string, unknown>, context: McpCallContext = {}): Promise<CallToolResult> {
    await this.ensureScope(scope)
    const tool = this.getTools(scope).find((candidate) => candidate.qualifiedName === qualifiedName && candidate.effectiveExposure !== 'hidden')
    if (tool === undefined) throw new Error(`MCP tool "${qualifiedName}" is unavailable`)
    const record = await this.connected(scope, tool.serverName)
    // 协议 incoming elicitation 不带原 tools/call 的 ID。按连接串行，才能正确归属用户会话。
    return this.withCallContext(record, scope, context, async (client) => {
      if (!this.getTools(scope).some((candidate) => candidate.qualifiedName === qualifiedName && candidate.effectiveExposure !== 'hidden')) throw new Error('MCP tool was disabled while queued')
      return client.callTool(tool.name, args, { signal: context.signal, timeoutMs: (record.entry.config.timeout ?? 60) * 1000 })
    })
  }

  async resourcesList(scope: McpRuntimeScope = {}, server?: string): Promise<{ resources: McpResourceInfo[]; resourceTemplates: McpResourceTemplateInfo[] }> {
    await this.ensureScope(scope)
    const records = this.records(scope).filter((record) => record.status.state === 'connected' && this.policy(scope, record.entry.name)?.config.exposure !== 'hidden' && (server === undefined || record.entry.name === server))
    return {
      resources: records.flatMap((record) => record.resources.map((resource) => ({ ...resource, server: record.entry.name }))),
      resourceTemplates: records.flatMap((record) => record.templates.map((resource) => ({ ...resource, server: record.entry.name })))
    }
  }
  async resourcesRead(scope: McpRuntimeScope, server: string, uri: string, context: McpCallContext = {}): Promise<import('@earendil-works/pi-mcp').ReadResourceResult> {
    const record = await this.connected(scope, server)
    return this.withCallContext(record, scope, context, (client) => {
      if (this.policy(scope, server)?.config.exposure === 'hidden') throw new Error('MCP resources are hidden')
      return client.readResource(uri, { signal: context.signal })
    })
  }
  async promptsList(scope: McpRuntimeScope = {}): Promise<{ prompts: McpPromptInfo[] }> {
    await this.ensureScope(scope)
    return { prompts: this.records(scope).filter((record) => record.status.state === 'connected' && this.policy(scope, record.entry.name)?.config.exposure !== 'hidden').flatMap((record) => structuredClone(record.prompts)) }
  }
  async promptsGet(scope: McpRuntimeScope, server: string, name: string, args?: Record<string, string>, context: McpCallContext = {}): Promise<{ description?: string; messages: Array<{ role: 'user' | 'assistant'; content: import('@earendil-works/pi-mcp').ContentBlock }> }> {
    const record = await this.connected(scope, server)
    return this.withCallContext(record, scope, context, (client) => {
      if (this.policy(scope, server)?.config.exposure === 'hidden') throw new Error('MCP prompts are hidden')
      return client.request('prompts/get', { name, ...(args === undefined ? {} : { arguments: args }) }, { signal: context.signal })
    })
  }

  private scheduleIdle(): void {
    for (const record of this.pool.values()) {
      if (!record.key.startsWith('project:') || record.closing) continue
      const active = [...this.scopes.entries()].some(([id, view]) => view.keys.includes(record.key) && (this.references.get(id) ?? 0) > 0)
      if (active) { clearTimeout(record.idleTimer); record.idleTimer = undefined; continue }
      if (record.idleTimer !== undefined) continue
      record.idleTimer = setTimeout(() => {
        void this.close(record).finally(() => { if (this.pool.get(record.key) === record) this.pool.delete(record.key) })
      }, this.options.idleTimeoutMs ?? 15 * 60 * 1000)
      record.idleTimer.unref()
    }
  }

  private async close(record: PoolEntry, markDisconnected = true): Promise<void> {
    record.closing = true
    clearTimeout(record.idleTimer)
    const client = record.client; const transport = record.transport
    record.client = undefined; record.transport = undefined
    // transport.close 自带有界预算；client.close 也会调用它，两者的幂等合同允许并行收口。
    const closingTransport = transport === undefined ? undefined : closeMcpTransport(transport)
    // client.close 在首个 await 前已拒绝请求并解绑；它的底层关闭不能超越宿主预算。
    void client?.close().catch(() => undefined)
    await closingTransport
    record.tools = []; record.resources = []; record.templates = []; record.prompts = []
    if (markDisconnected) { record.status.state = 'disconnected'; this.publish(record) }
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.pool.values()].map((record) => this.close(record)))
    this.pool.clear(); this.scopes.clear(); this.listeners.clear(); this.references.clear()
  }
}
