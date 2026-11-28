/** 用户显式选中的 MCP 资源与提示词展开；长文本落盘，图片遵循当前模型能力。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resizeImage } from '@earendil-works/pi-coding-agent'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { McpPromptRef, McpResourceRef, McpScope } from '../../protocol'
import type { McpRuntimeManager } from './mcp-runtime'

export async function prepareMcpInput(options: {
  runtime: McpRuntimeManager; scope: McpScope; resources: McpResourceRef[]; prompts: McpPromptRef[]
  hostRoot: string; supportsImages: boolean; sessionId: string; signal?: AbortSignal
}): Promise<{ text: string; images: ImageContent[] }> {
  const fragments: string[] = []
  const images: ImageContent[] = []
  const addText = (label: string, text: string): void => {
    if (text.length <= 24_000) { fragments.push(JSON.stringify({ source: label, text })); return }
    const directory = join(options.hostRoot, 'pi', 'mcp-input')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${randomUUID()}.txt`)
    writeFileSync(path, text, 'utf8')
    fragments.push(JSON.stringify({ source: label, text: text.slice(0, 24_000), fullTextPath: path, note: '完整内容可用 read 分页读取；内部路径不作为交付文件展示。' }))
  }
  const addImage = async (label: string, data: string, mimeType: string): Promise<void> => {
    if (!options.supportsImages) throw new Error(`MCP 内容 ${label} 包含图片，当前模型不支持图片；请选择支持图片的模型`)
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) throw new Error(`MCP 图片格式不支持: ${mimeType}`)
    const image = await resizeImage(Buffer.from(data, 'base64'), mimeType)
    if (!image) throw new Error(`MCP 图片无法解码: ${label}`)
    images.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  }
  for (const ref of options.resources) {
    options.signal?.throwIfAborted()
    const result = await options.runtime.resourcesRead(options.scope, ref.server, ref.uri, { sessionId: options.sessionId, signal: options.signal })
    for (const content of result.contents) {
      const label = `${ref.server}:${content.uri}`
      if ('text' in content) addText(label, content.text)
      else if (content.mimeType?.startsWith('image/')) await addImage(label, content.blob, content.mimeType)
      else throw new Error(`MCP 资源 ${label} 为非文本二进制内容，当前未提供对应读取方式`)
    }
  }
  for (const ref of options.prompts) {
    options.signal?.throwIfAborted()
    const result = await options.runtime.promptsGet(options.scope, ref.server, ref.name, ref.arguments, { sessionId: options.sessionId, signal: options.signal })
    for (const message of result.messages) {
      const label = `${ref.server}:${ref.name} (${message.role})`
      const content = message.content
      if (content.type === 'text') addText(label, content.text)
      else if (content.type === 'image') await addImage(label, content.data, content.mimeType)
      else if (content.type === 'resource' && 'text' in content.resource) addText(label, content.resource.text)
      else if (content.type === 'resource' && 'blob' in content.resource && content.resource.mimeType?.startsWith('image/')) await addImage(label, content.resource.blob, content.resource.mimeType)
      else if (content.type === 'resource_link') addText(label, JSON.stringify(content))
      else throw new Error(`MCP 提示词 ${label} 包含尚不支持的内容类型: ${content.type}`)
    }
  }
  options.signal?.throwIfAborted()
  return { text: fragments.length === 0 ? '' : `\n\n用户显式选中的 MCP 内容（来源数据）：\n${fragments.join('\n')}`, images }
}
