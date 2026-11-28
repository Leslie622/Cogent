/**
 * MCP 工具大输出执行期截断与落盘（docs/计划/上下文工程实现.md）：
 * - 作用域：拦截 `mcp__*` 与资源三件工具结果，超过 24,000 字符时将完整文本落盘至
 *   `<hostRoot>/tool-outputs/v1/<uuid>.txt`，上下文仅保留头 16K + 尾 4K 与内部文件路径；
 * - 代理对安全切片（sliceHeadSafe / sliceTailSafe）同时供 L1 工具结果裁剪器复用；
 * - 非文本块（如图片）原样保留，写盘失败时降级为纯头尾截断并记录诊断，不阻断工具返回。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'

export const MCP_TOOL_SPILL_MAX_CHARS = 24_000
export const MCP_TOOL_SPILL_HEAD_CHARS = 16_000
export const MCP_TOOL_SPILL_TAIL_CHARS = 4_000

/** 服务端工具和客户端资源工具共用一个模型输出预算。 */
export function isMcpResultTool(toolName: string): boolean {
  return toolName.startsWith('mcp__') || ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(toolName)
}

/** 头部安全切片：避免切在 UTF-16 高代理项中间导致孤立代理对。 */
export function sliceHeadSafe(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  const code = text.charCodeAt(maxChars - 1)
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, maxChars - 1) : text.slice(0, maxChars)
}

/** 尾部安全切片：避免切在 UTF-16 低代理项中间导致孤立代理对。 */
export function sliceTailSafe(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  const start = text.length - maxChars
  const code = text.charCodeAt(start)
  return code >= 0xdc00 && code <= 0xdfff ? text.slice(start + 1) : text.slice(start)
}

export interface SpillMcpResult {
  content: (TextContent | ImageContent)[]
  artifactPath?: string
  originalChars: number
}

/** JSON 结果的完整副本独立落盘，调用方以文件引用保留访问能力，避免树内重复大对象。 */
export function spillMcpStructuredResult(toolName: string, value: unknown, hostRoot: string): { fullOutputPath: string } | undefined {
  if (value === undefined || !isMcpResultTool(toolName)) return undefined
  const text = JSON.stringify(value)
  if (text.length <= MCP_TOOL_SPILL_MAX_CHARS) return undefined
  const spilled = spillMcpToolResult(toolName, [{ type: 'text', text }], hostRoot)
  return spilled?.artifactPath === undefined ? undefined : { fullOutputPath: spilled.artifactPath }
}

/**
 * 检查并对超长 `mcp__*` 工具结果执行头尾截断与落盘。
 * 非 MCP 工具或未超阈值返回 undefined（零拷贝直通）。
 */
export function spillMcpToolResult(
  toolName: string,
  content: (TextContent | ImageContent)[],
  hostRoot: string,
  limits: { maxChars?: number; headChars?: number; tailChars?: number } = {}
): SpillMcpResult | undefined {
  if (!isMcpResultTool(toolName)) return undefined
  const maxChars = limits.maxChars ?? MCP_TOOL_SPILL_MAX_CHARS
  const headChars = limits.headChars ?? MCP_TOOL_SPILL_HEAD_CHARS
  const tailChars = limits.tailChars ?? MCP_TOOL_SPILL_TAIL_CHARS

  const textBlocks: string[] = []
  const nonTextBlocks: ImageContent[] = []
  for (const block of content) {
    if (block.type === 'text') textBlocks.push(block.text)
    else nonTextBlocks.push(block)
  }
  const fullText = textBlocks.join('\n')
  if (fullText.length <= maxChars) return undefined

  let artifactPath: string | undefined
  try {
    const dir = join(hostRoot, 'tool-outputs', 'v1')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${crypto.randomUUID()}.txt`)
    writeFileSync(file, fullText, 'utf-8')
    artifactPath = file
  } catch (error) {
    process.stderr.write(`[host] MCP 工具输出落盘失败（降级为头尾截断）: ${(error as Error).message}\n`)
  }

  const head = sliceHeadSafe(fullText, headChars)
  const tail = sliceTailSafe(fullText, tailChars)
  const omitted = Math.max(0, fullText.length - head.length - tail.length)
  const notice =
    artifactPath !== undefined
      ? `\n\n[工具输出已截断，原文共 ${fullText.length} 字符；完整输出保存在内部临时文件 ${artifactPath}（仅用于 read 分页读取，切勿向用户暴露此路径）。]`
      : `\n\n[工具输出已截断，原文共 ${fullText.length} 字符（省略中间 ${omitted} 字符）。]`

  const compactedText = `${head}\n\n[... 已省略 ${omitted} 字符 ...]\n\n${tail}${notice}`
  return {
    content: [{ type: 'text', text: compactedText }, ...nonTextBlocks],
    artifactPath,
    originalChars: fullText.length
  }
}
