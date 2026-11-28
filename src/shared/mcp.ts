/** Renderer 的 MCP wire 类型单源出口；私有凭据与交互响应仍走壳侧独立接口。 */
export type * from '../protocol/mcp'
import type { McpMethods, McpEvents } from '../protocol/mcp'

export type RendererMcpMethods = Omit<McpMethods, 'mcp.secrets.sync' | 'mcp.oauth.persistResult' | 'mcp.elicitation.respond'>
export type RendererMcpEvent = {
  [K in Exclude<keyof McpEvents, 'mcp.oauth.openUrl' | 'mcp.oauth.persistState'>]: { method: K; params: McpEvents[K] }
}[Exclude<keyof McpEvents, 'mcp.oauth.openUrl' | 'mcp.oauth.persistState'>]
