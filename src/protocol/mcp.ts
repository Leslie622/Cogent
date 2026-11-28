/** MCP 客户端契约：配置、运行时观测与受控交互；不依赖协议 SDK 或 Electron。 */
export type McpExposure = 'direct' | 'deferred' | 'codemode' | 'hidden'
export type McpTransportType = 'stdio' | 'http' | 'sse'
export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  callbackPort?: number
  callbackUrl?: string
  scope?: string
  clientName?: string
  clientRegistration?: 'auto' | 'dcr' | 'cimd'
  authServerMetadataUrl?: string
}
export type McpServerDef = { name: string } & (
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; sanitizeHostEnv?: boolean }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; oauth?: McpOAuthConfig }
) & {
  description?: string
  enabled?: boolean
  /** 缺省 deferred；codemode 在运行时显式归一为 deferred。 */
  exposure?: McpExposure
  toolExposure?: Record<string, McpExposure>
  timeout?: number
  extraFields?: Record<string, unknown>
}
export interface McpScope { cwd?: string; projectId?: string }
export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}
export interface McpToolInfo {
  name: string
  qualifiedName: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: McpToolAnnotations
  effectiveExposure: McpExposure
}
export type McpConnectionState = 'disabled' | 'untrusted' | 'connecting' | 'connected' | 'needs-auth' | 'disconnected' | 'failed'
export interface McpServerRuntimeStatus {
  name: string
  poolKey: string
  state: McpConnectionState
  /** 仅有已保存 OAuth Token 的远程服务为 true；静态 Header 不算 OAuth 授权。 */
  oauthAuthorized?: boolean
  latencyMs?: number
  serverInfo?: { name: string; version: string }
  instructions?: string
  protocolVersion?: string
  tools: McpToolInfo[]
  resourcesCount: number
  promptsCount: number
  error?: string
  stderrTail?: string
  updatedAt: string
  revision?: number
}
export interface McpServerSummary {
  name: string
  type: McpTransportType
  detail: string
  description?: string
  enabled: boolean
  exposure: McpExposure
  def: McpServerDef
  overrideApplied?: boolean
  override?: { enabled?: boolean; exposure?: McpExposure; toolExposure?: Record<string, McpExposure> }
  origin?: 'user' | 'project-file' | 'project-cogent'
  source?: string
  trusted?: boolean
  runtime?: McpServerRuntimeStatus
  toolExposure?: Record<string, McpExposure>
}
export interface McpPendingTrustFile {
  projectId?: string
  filePath: string
  sha256: string
  servers: Array<{ name: string; type: McpTransportType; command?: string; url?: string; envKeys: string[]; headerKeys: string[] }>
}
export interface McpListResult { servers: McpServerSummary[]; errors: string[]; pendingTrustFiles?: McpPendingTrustFile[] }
export interface McpOverrideParams { cwd: string; name: string; enabled?: boolean; exposure?: McpExposure; toolExposure?: Record<string, McpExposure> }
export interface McpOverrideResult { ok: true }
export interface McpSyncParams { servers: McpServerDef[] }
export interface McpSyncResult { synced: number }
export interface McpResourceInfo { server: string; uri: string; name: string; description?: string; mimeType?: string }
export interface McpResourceTemplateInfo { server: string; uriTemplate: string; name: string; description?: string; mimeType?: string }
export interface McpPromptInfo { server: string; name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }
export interface McpResourceRef { server: string; uri: string }
export interface McpPromptRef { server: string; name: string; arguments?: Record<string, string> }
export interface McpToolPresentation {
  structuredContent?: unknown
  images?: Array<{ data: string; mimeType: string }>
  resourceLinks?: Array<{ uri: string; name: string; description?: string }>
}
export type McpElicitationRequest = {
  requestId: string; sessionId: string; server: string; message: string
} & (
  | { mode: 'form'; requestedSchema: Record<string, unknown> }
  | { mode: 'url'; url: string; elicitationId: string }
)
export interface McpElicitationResponse { requestId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
export interface McpMethods {
  'mcp.list': { params: McpScope; result: McpListResult }
  'mcp.sync': { params: McpSyncParams; result: McpSyncResult }
  'mcp.override': { params: McpOverrideParams; result: McpOverrideResult }
  'mcp.reconnect': { params: McpScope & { name: string }; result: { ok: true } }
  'mcp.probe': { params: McpScope & { def: McpServerDef }; result: McpServerRuntimeStatus }
  'mcp.trust.decide': { params: { projectId: string; cwd: string; filePath: string; sha256: string; decision: 'trust' | 'reject' }; result: { ok: true } }
  'mcp.oauth.login': { params: McpScope & { name: string }; result: { loginId: string; authUrl: string } }
  'mcp.oauth.completeManual': { params: { loginId: string; redirectUrl: string }; result: { ok: true } }
  'mcp.oauth.cancel': { params: { loginId: string }; result: { ok: true } }
  'mcp.oauth.logout': { params: McpScope & { name: string }; result: { ok: true } }
  'mcp.resources.list': { params: McpScope & { server?: string }; result: { resources: McpResourceInfo[]; resourceTemplates: McpResourceTemplateInfo[] } }
  'mcp.resources.read': { params: McpScope & { server: string; uri: string }; result: { contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> } }
  'mcp.prompts.list': { params: McpScope; result: { prompts: McpPromptInfo[] } }
  'mcp.prompts.get': { params: McpScope & { server: string; name: string; arguments?: Record<string, string> }; result: { description?: string; messages: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown> }> } }
  'mcp.elicitation.respond': { params: McpElicitationResponse; result: { ok: true } }
  'mcp.secrets.sync': { params: { oauthStates: Record<string, unknown> }; result: { ok: true } }
  'mcp.oauth.persistResult': { params: { requestId: string; error?: string }; result: { ok: true } }
}
export interface McpEvents {
  'mcp.statusChanged': { servers: McpServerRuntimeStatus[]; cwd?: string; projectId?: string }
  'mcp.elicitation.request': McpElicitationRequest
  'mcp.elicitation.resolved': { requestId: string; sessionId: string }
  'mcp.oauth.openUrl': { loginId: string; url: string }
  'mcp.oauth.loginChanged': { loginId: string; name: string; state: 'authorized' | 'failed' | 'cancelled'; error?: string }
  'mcp.oauth.persistState': { requestId: string; key: string; state?: unknown }
}
