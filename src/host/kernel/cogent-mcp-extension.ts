/**
 * pi 会话桥：只注册工具与提示段，连接归 Host McpRuntimeManager。
 * pi 不提供 unregisterTool；删除/隐藏时按官方 MCP 扩展同样重新注册为 hidden。
 * 每次执行都重新检查运行时权限，因此旧定义不能绕过禁用或项目信任撤销。
 * 系统提示的 mcp_servers 段列出 deferred 工具的名字（buildMcpCatalog），让模型看得见目录。
 */
import { Type } from 'typebox'
import { mcpNamespace, normalizeMcpInputSchema, toLlmContent } from '@earendil-works/pi-mcp'
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { JsonValue } from '@earendil-works/pi-ai'
import type { McpRuntimeManager, McpRuntimeScope, McpRuntimeTool } from '../runtime/mcp-runtime'

export interface CogentMcpExtensionOptions extends McpRuntimeScope {
  runtime: McpRuntimeManager
  sessionId: string
}

/**
 * MCP 工具目录：系统提示 mcp_servers 段的内容源（docs/计划/附件读取与MCP解耦实现.md §5.2）。
 * 只让 deferred 工具对模型可见，不替它选工具。服务描述和工具描述来自外部服务，而 pi 用
 * <段名>…</段名> 包每个提示段，所以拼进目录前并成单行并转义 & < >，防止闭合标签或换行改写提示结构。
 * 预算内列名字和描述首行，超出降为只列名字，再超出退回服务名加数量（同技能清单的三档）。
 */
export const MCP_CATALOG_BUDGET = 4000
const CATALOG_HEADER = 'Available MCP servers. Their tools are not declared upfront: call tool_search with the server or tool name to load its schema.'

interface CatalogRow { heading: string; summary: string; names: string[]; described: string[] }

/** 先截断再转义，免得把转义实体切成两半。目录行是文本不是属性，转义 & < > 足以挡住闭合标签。 */
function catalogText(text: string | undefined, max: number): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
/** 目录里列服务端给的工具名；名字不合字符集时改列清洗后的限定名。列出的名字同样并成单行。 */
function catalogToolName(tool: McpRuntimeTool): string {
  return catalogText(/^[A-Za-z0-9_-]+$/.test(tool.name) ? tool.name : tool.qualifiedName, 80)
}

/** 末档兜底：服务再多也逐条从末尾去掉并写明省略数量，不撑破预算。 */
function fitBudget(lines: string[]): string {
  const kept = [...lines]
  const render = (omitted: number): string => [CATALOG_HEADER, ...kept, ...(omitted > 0 ? [`  … ${omitted} more entries omitted`] : [])].join('\n')
  let omitted = 0
  while (kept.length > 0 && render(omitted).length > MCP_CATALOG_BUDGET) { kept.pop(); omitted++ }
  return render(omitted)
}

export function buildMcpCatalog(deferred: readonly McpRuntimeTool[], instructionsOf: (server: string) => string | undefined): string | null {
  if (deferred.length === 0) return null
  const groups = new Map<string, McpRuntimeTool[]>()
  for (const tool of deferred) groups.set(tool.serverName, [...(groups.get(tool.serverName) ?? []), tool])
  const rows: CatalogRow[] = [...groups].map(([server, tools]) => {
    const summary = catalogText(tools.find((tool) => tool.serverDescription !== undefined)?.serverDescription ?? instructionsOf(server), 250)
    const names = tools.map(catalogToolName)
    const described = tools.map((tool) => {
      const description = catalogText(tool.description, 120)
      return description === '' ? `  - ${catalogToolName(tool)}` : `  - ${catalogToolName(tool)}: ${description}`
    })
    return { heading: `- ${catalogText(server, 80)}`, summary, names, described }
  })
  const head = (row: CatalogRow): string => row.summary === '' ? row.heading : `${row.heading} — ${row.summary}`
  const counted = rows.map((row) => `${row.heading}: ${row.names.length} tools${row.summary === '' ? '' : ` — ${row.summary}`}`)
  const namesOnly = rows.map((row) => `${head(row)} (${row.names.length}): ${row.names.join(', ')}`)
  const described = rows.flatMap((row) => [head(row), ...row.described])
  for (const lines of [described, namesOnly]) {
    const section = [CATALOG_HEADER, ...lines].join('\n')
    if (section.length <= MCP_CATALOG_BUDGET) return section
  }
  return fitBudget(counted)
}

/** 结果结构与 pi 官方 MCP 一致：模型得到文本/图片，脚本得到完整 MCP result。 */
function toolDefinition(options: CogentMcpExtensionOptions, tool: McpRuntimeTool): ToolDefinition {
  return {
    name: tool.qualifiedName,
    label: `${tool.serverName}/${tool.name}`,
    description: tool.description?.trim() || `MCP tool ${tool.name} from server ${tool.serverName}`,
    parameters: normalizeMcpInputSchema(tool.inputSchema),
    exposure: tool.effectiveExposure === 'codemode' ? 'deferred' : tool.effectiveExposure,
    defaultActive: tool.effectiveExposure === 'direct',
    namespace: { name: mcpNamespace(tool.serverName), aliases: [tool.serverName], ...(tool.serverDescription === undefined ? {} : { description: tool.serverDescription }) },
    annotations: tool.annotations,
    outputSchema: Type.Object({
      content: Type.Array(Type.Unknown()), structuredContent: Type.Optional(Type.Unknown()), isError: Type.Optional(Type.Boolean())
    }),
    async execute(_toolCallId, args, signal) {
      const result = await options.runtime.callTool(options, tool.qualifiedName, args as Record<string, unknown>, { signal, sessionId: options.sessionId })
      const { _meta: _metadata, ...scriptResult } = result
      const content = toLlmContent(result)
      if (result.isError === true && !content.some((block) => block.type === 'text' && block.text.trim() !== '')) {
        content.push({ type: 'text', text: `MCP tool ${tool.serverName}/${tool.name} returned an error` })
      }
      return {
        content, structuredContent: JSON.parse(JSON.stringify(scriptResult)) as JsonValue,
        details: {
          server: tool.serverName, tool: tool.name, structuredContent: result.structuredContent,
          // 文字已在content与structuredContent各有消费；详情只保留可视富内容，避免再复制大正文。
          mcpContent: result.content.filter((block) => block.type === 'image' || block.type === 'resource_link' ||
            (block.type === 'resource' && 'blob' in block.resource && block.resource.mimeType?.startsWith('image/'))),
          mcpMeta: { serverName: tool.serverName, originalToolName: tool.name, ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }) }
        },
        ...(result.isError === true ? { isError: true } : {})
      }
    }
  }
}

export function createCogentMcpExtension(options: CogentMcpExtensionOptions): ExtensionFactory {
  return (pi) => {
    const definitions = new Map<string, { definition: ToolDefinition; signature: string }>()
    const resourceNames = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
    let resourcesRegistered = false

    const sync = (): void => {
      const tools = options.runtime.getTools(options)
      const visible = new Set(tools.filter((tool) => tool.effectiveExposure !== 'hidden').map((tool) => tool.qualifiedName))
      const previousActive = pi.getActiveTools()
      const activate: string[] = []
      for (const tool of tools) {
        if (tool.effectiveExposure === 'hidden') continue
        const signature = JSON.stringify(tool)
        if (definitions.get(tool.qualifiedName)?.signature !== signature) {
          const definition = toolDefinition(options, tool)
          definitions.set(tool.qualifiedName, { definition, signature })
          pi.registerTool(definition)
        }
        if (tool.effectiveExposure === 'direct' || previousActive.includes(tool.qualifiedName)) activate.push(tool.qualifiedName)
      }
      for (const [name, current] of definitions) {
        if (visible.has(name) || current.signature === 'hidden') continue
        pi.registerTool({ ...current.definition, exposure: 'hidden', defaultActive: false })
        definitions.set(name, { ...current, signature: 'hidden' })
      }
      const resourcesAvailable = options.runtime.hasResources(options)
      if (!resourcesRegistered && resourcesAvailable) {
        const listSchema = Type.Object({ server: Type.Optional(Type.String()) })
        pi.registerTool({
          name: resourceNames[0], label: 'MCP 资源', description: 'List resources offered by connected MCP servers.', parameters: listSchema,
          async execute(_id, args) {
            const result = await options.runtime.resourcesList(options, args.server)
            return { content: [{ type: 'text', text: JSON.stringify({ resources: result.resources }) }], details: { server: args.server, resourceCount: result.resources.length } }
          }
        })
        pi.registerTool({
          name: resourceNames[1], label: 'MCP 资源模板', description: 'List URI templates offered by connected MCP servers.', parameters: listSchema,
          async execute(_id, args) {
            const result = await options.runtime.resourcesList(options, args.server)
            return { content: [{ type: 'text', text: JSON.stringify({ resourceTemplates: result.resourceTemplates }) }], details: { server: args.server, templateCount: result.resourceTemplates.length } }
          }
        })
        pi.registerTool({
          name: resourceNames[2], label: '读取 MCP 资源', description: 'Read an MCP resource using its server and URI.',
          parameters: Type.Object({ server: Type.String(), uri: Type.String() }),
          async execute(_id, args, signal) {
            const result = await options.runtime.resourcesRead(options, args.server, args.uri, { signal, sessionId: options.sessionId })
            return { content: toLlmContent({ content: result.contents.map((resource) => ({ type: 'resource' as const, resource })) }), details: { server: args.server, uri: args.uri, contentCount: result.contents.length } }
          }
        })
        resourcesRegistered = true
      }
      if (resourcesAvailable) activate.push(...resourceNames)
      const needsSearch = tools.some((tool) => tool.effectiveExposure === 'deferred' || tool.effectiveExposure === 'codemode')
      if (needsSearch) activate.push('tool_search')
      const keep = previousActive.filter((name) => {
        if (name.startsWith('mcp__')) return visible.has(name)
        if (resourceNames.includes(name)) return resourcesAvailable
        if (name === 'tool_search') return needsSearch
        return true
      })
      pi.setActiveTools([...new Set([...keep, ...activate])])
    }

    pi.on('session_start', async () => { await options.runtime.ensureScope(options); sync() })
    pi.on('before_agent_start', async (event) => {
      await options.runtime.ensureScope(options)
      sync()
      const deferred = options.runtime.getTools(options).filter((tool) => tool.effectiveExposure === 'deferred' || tool.effectiveExposure === 'codemode')
      const statuses = options.runtime.getStatuses(options)
      const catalog = buildMcpCatalog(deferred, (server) => statuses.find((status) => status.name === server)?.instructions)
      if (catalog === null) delete event.systemPromptOptions.sections.mcp_servers
      else event.systemPromptOptions.sections.mcp_servers = catalog
    })
    pi.on('tool_call', async (event) => {
      if (event.toolName !== 'tool_search' && !event.toolName.startsWith('mcp__') && !resourceNames.includes(event.toolName)) return
      await options.runtime.ensureScope(options)
      sync()
    })
  }
}
