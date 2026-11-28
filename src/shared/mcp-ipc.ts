/** MCP 壳侧特权渠道与窄载荷；OAuth 凭据由 main 静默托管，不经通用 engine 代理。 */
export const MCP_IPC = {
  elicitationRespond: 'mcp:elicitationRespond',
  detectExternalConfigs: 'mcp:detectExternalConfigs',
  openUrl: 'mcp:openUrl'
} as const

export interface McpExternalConfig {
  label: string
  path: string
  /** 只在用户明确选择该候选路径后读取，检测阶段不含正文。 */
  content?: string
  error?: string
}

export interface McpElicitationResponse {
  requestId: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export interface McpShellApi {
  elicitationRespond: (params: McpElicitationResponse) => Promise<{ ok: true }>
  detectExternalConfigs: (selectedPaths?: string[]) => Promise<McpExternalConfig[]>
  openUrl: (url: string) => Promise<void>
}
