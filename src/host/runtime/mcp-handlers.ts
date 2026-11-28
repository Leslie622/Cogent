/** MCP 请求边界：形状、项目身份及信任在此核验，运行时只消费已收窄的参数。 */
import { realpathSync } from 'node:fs'
import { z } from 'zod'
import { ProtocolError, RpcErrorCode, type McpScope } from '../../protocol'
import { validateMcpDefinitions, type McpConfigStore } from './mcp-config'
import type { McpTrustStore } from './mcp-trust'
import type { McpRuntimeManager } from './mcp-runtime'
import type { McpSecretBridge } from './mcp-secrets'
import type { McpOAuthController } from './mcp-oauth'
import type { McpElicitationService } from './mcp-elicitation'
import type { ProjectRegistry } from './project'
import { dependsOnProject, resolveMcpEnvironment } from './mcp-env'

const text = z.string().trim().min(1)
const exposure = z.enum(['direct', 'deferred', 'codemode', 'hidden'])
const stringMap = z.record(z.string(), z.string())
const toolExposure = z.record(z.string(), exposure)
const oauth = z.object({ clientId: z.string().optional(), clientSecret: z.string().optional(), callbackPort: z.number().int().min(1).max(65535).optional(), callbackUrl: z.string().optional(), scope: z.string().optional(), clientName: z.string().optional(), clientRegistration: z.enum(['auto', 'dcr', 'cimd']).optional(), authServerMetadataUrl: z.string().optional() })
const shared = { name: text, description: z.string().optional(), enabled: z.boolean().optional(), exposure: exposure.optional(), toolExposure: toolExposure.optional(), timeout: z.number().finite().positive().optional(), extraFields: z.record(z.string(), z.unknown()).optional() }
const def = z.discriminatedUnion('type', [
  z.object({ ...shared, type: z.literal('stdio'), command: text, args: z.array(z.string()).optional(), cwd: z.string().optional(), env: stringMap.optional(), sanitizeHostEnv: z.boolean().optional() }),
  z.object({ ...shared, type: z.enum(['http', 'sse']), url: text, headers: stringMap.optional(), oauth: oauth.optional() })
])
const scope = z.object({ cwd: text.optional(), projectId: text.optional() })
const named = scope.extend({ name: text })
const secretSnapshot = z.object({ oauthStates: z.record(z.string(), z.unknown()) })
export function parseMcpSecretSnapshot(value: unknown): z.infer<typeof secretSnapshot> {
  return parse(secretSnapshot, value)
}
export function parseMcpReferences(value: unknown) {
  return parse(z.object({
    mcpResources: z.array(z.object({ server: text, uri: text })).max(50).optional(),
    mcpPrompts: z.array(z.object({ server: text, name: text, arguments: stringMap.optional() })).max(20).optional()
  }), value)
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ProtocolError(RpcErrorCode.InvalidParams, parsed.error.message)
  return parsed.data
}
function pathIdentity(path: string): string {
  const result = realpathSync.native(path)
  return process.platform === 'win32' ? result.toLowerCase() : result
}
export function validateMcpScope(value: McpScope, projects: ProjectRegistry): McpScope {
  if (value.projectId === undefined) return value
  const project = projects.get(value.projectId)
  if (!project) throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 项目不存在')
  const cwd = value.cwd ?? project.cwds[0]
  if (pathIdentity(cwd) !== pathIdentity(project.cwds[0])) throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 工作目录与项目主根不一致')
  return { ...value, cwd }
}

export function mcpHandlers(deps: { config: McpConfigStore; runtime: McpRuntimeManager; trust: McpTrustStore; projects: ProjectRegistry; oauth: McpOAuthController; secrets: McpSecretBridge; elicitation: McpElicitationService }): Array<[string, (params: unknown) => unknown]> {
  // 配置提交及刷新串行，避免较早的异步刷新覆盖较新的设置。
  let writes: Promise<unknown> = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = writes.then(operation)
    writes = current.then(() => undefined, () => undefined)
    return current
  }
  const readScope = (value: unknown): McpScope => validateMcpScope(parse(scope, value), deps.projects)
  const readNamed = (value: unknown): McpScope & { name: string } => {
    const parsed = parse(named, value)
    return { ...parsed, ...validateMcpScope(parsed, deps.projects) }
  }
  const authDef = (value: McpScope & { name: string }) => {
    const entry = deps.config.resolve(value.cwd, value.projectId).servers.find((entry) => entry.name === value.name)
    if (!entry || !entry.trusted || entry.config.enabled === false) throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 服务器不存在、未受信或已禁用')
    if (entry.config.type === 'stdio') throw new ProtocolError(RpcErrorCode.InvalidParams, 'stdio MCP 不使用远程 OAuth')
    return { entry, def: resolveMcpEnvironment(entry.config, { projectDir: value.cwd }) }
  }
  return [
    ['mcp.list', (value) => deps.runtime.list(readScope(value))],
    ['mcp.sync', (value) => mutate(async () => {
      const parsed = parse(z.object({ servers: z.array(def) }), value)
      validateMcpDefinitions(parsed.servers)
      const synced = deps.config.sync(parsed.servers)
      await deps.runtime.refresh()
      return { synced }
    })],
    ['mcp.override', (value) => mutate(async () => {
      const parsed = parse(named.extend({ cwd: text, enabled: z.boolean().optional(), exposure: exposure.optional(), toolExposure: toolExposure.optional() }), value)
      validateMcpScope(parsed, deps.projects)
      const { cwd, name, enabled, exposure: exposed, toolExposure: tools } = parsed
      deps.config.override(cwd, name, { ...(enabled !== undefined && { enabled }), ...(exposed !== undefined && { exposure: exposed }), ...(tools !== undefined && { toolExposure: tools }) })
      await deps.runtime.refresh()
      return { ok: true }
    })],
    ['mcp.trust.decide', (value) => mutate(async () => {
      const parsed = parse(scope.extend({ cwd: text, projectId: text, filePath: text, sha256: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['trust', 'reject']) }), value)
      validateMcpScope(parsed, deps.projects)
      deps.trust.decide(parsed)
      await deps.runtime.refresh()
      return { ok: true }
    })],
    ['mcp.reconnect', async (value) => { const parsed = readNamed(value); await deps.runtime.reconnect(parsed.name, parsed); return { ok: true } }],
    ['mcp.probe', (value) => {
      const parsed = parse(scope.extend({ def }), value)
      const currentScope = validateMcpScope(parsed, deps.projects)
      const entry = deps.config.resolve(currentScope.cwd, currentScope.projectId).servers.find((entry) => entry.name === parsed.def.name)
      if (entry && !entry.trusted) throw new ProtocolError(RpcErrorCode.InvalidParams, '请先审阅并信任此项目 MCP 定义')
      return deps.runtime.probe(parsed.def, currentScope)
    }],
    ['mcp.oauth.login', (value) => { const parsed = readNamed(value); const { entry, def } = authDef(parsed); return deps.oauth.login(def, entry.scope === 'global' && !dependsOnProject(entry.config) ? {} : parsed) }],
    ['mcp.oauth.completeManual', async (value) => { const parsed = parse(z.object({ loginId: text, redirectUrl: text }), value); await deps.oauth.completeManual(parsed.loginId, parsed.redirectUrl); return { ok: true } }],
    ['mcp.oauth.cancel', async (value) => { const parsed = parse(z.object({ loginId: text }), value); await deps.oauth.cancel(parsed.loginId); return { ok: true } }],
    ['mcp.oauth.logout', async (value) => { const parsed = readNamed(value); const { entry, def } = authDef(parsed); await deps.oauth.logout(def, entry.scope === 'global' && !dependsOnProject(entry.config) ? {} : parsed); return { ok: true } }],
    ['mcp.resources.list', (value) => { const parsed = parse(scope.extend({ server: text.optional() }), value); return deps.runtime.resourcesList(validateMcpScope(parsed, deps.projects), parsed.server) }],
    ['mcp.resources.read', (value) => { const parsed = parse(scope.extend({ server: text, uri: text }), value); return deps.runtime.resourcesRead(validateMcpScope(parsed, deps.projects), parsed.server, parsed.uri) }],
    ['mcp.prompts.list', (value) => deps.runtime.promptsList(readScope(value))],
    ['mcp.prompts.get', (value) => { const parsed = parse(scope.extend({ server: text, name: text, arguments: stringMap.optional() }), value); return deps.runtime.promptsGet(validateMcpScope(parsed, deps.projects), parsed.server, parsed.name, parsed.arguments) }],
    ['mcp.elicitation.respond', (value) => deps.elicitation.respond(parse(z.object({ requestId: text, action: z.enum(['accept', 'decline', 'cancel']), content: z.record(z.string(), z.unknown()).optional() }), value))],
    ['mcp.secrets.sync', async (value) => { const parsed = parseMcpSecretSnapshot(value); deps.secrets.sync(parsed); await deps.runtime.refresh(); return { ok: true } }],
    ['mcp.oauth.persistResult', (value) => { deps.secrets.completePersistence(parse(z.object({ requestId: text, error: z.string().optional() }), value)); return { ok: true } }]
  ]
}
