/** MCP 原始内容在模型和界面间保真；仅支持的图片 MIME 可作为缩略图展示。 */
import { describe, expect, it } from 'vitest'
import { extractMcpResult } from '../../../src/host/runtime/message-projection'

describe('MCP 富内容投影', () => {
  it('保留持久化的结构化结果、嵌入图片和资源链接', () => {
    expect(extractMcpResult({ content: [{ type: 'text', text: '模型侧文本' }], details: {
      structuredContent: { count: 2 }, mcpContent: [
        { type: 'resource', resource: { uri: 'images://chart', mimeType: 'image/png', blob: 'aW1hZ2U=' } },
        { type: 'resource_link', name: '项目指南', uri: 'docs://guide' }
      ]
    } }, 'mcp__example__report')).toEqual({ structuredContent: { count: 2 }, images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }], resourceLinks: [{ name: '项目指南', uri: 'docs://guide' }] })
  })
  it('非MCP结果和不支持的媒体不生成图片展示字段', () => {
    expect(extractMcpResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] }, 'read')).toBeUndefined()
    expect(extractMcpResult({ content: [{ type: 'resource', resource: { uri: 'images://svg', mimeType: 'image/svg+xml', blob: 'svg' } }] }, 'mcp__example__report')).toBeUndefined()
  })
})
