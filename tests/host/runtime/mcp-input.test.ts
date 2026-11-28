/** MCP 输入按会话展开，原始用户文本独立保真；图片与取消遵循当前回合合同。 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager as PiSessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareMcpInput } from '../../../src/host/runtime/mcp-input'
import type { McpRuntimeManager } from '../../../src/host/runtime/mcp-runtime'
import { findPiTranscriptFile, piSessionDir, readPiTranscript } from '../../../src/host/kernel/transcript'
import { toChatMessages } from '../../../src/host/runtime/message-projection'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cogent-mcp-input-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
function fixture() {
  const resourcesRead = vi.fn<McpRuntimeManager['resourcesRead']>().mockResolvedValue({ contents: [{ uri: 'fixture://guide', text: '资源正文', mimeType: 'text/plain' }] })
  const promptsGet = vi.fn<McpRuntimeManager['promptsGet']>().mockResolvedValue({ messages: [{ role: 'user', content: { type: 'text', text: '提示词正文' } }] })
  const runtime = { resourcesRead, promptsGet } as unknown as McpRuntimeManager
  const options = { runtime, scope: { cwd: root, projectId: 'project' }, hostRoot: root, sessionId: 'session', supportsImages: false,
    resources: [{ server: 'docs', uri: 'fixture://guide' }], prompts: [{ server: 'docs', name: 'review', arguments: { file: 'source.ts' } }] }
  return { options, resourcesRead, promptsGet }
}

it('资源与提示词带同一会话上下文和取消信号，展开正文包含明确来源', async () => {
  const { options, resourcesRead, promptsGet } = fixture()
  const controller = new AbortController()
  const prepared = await prepareMcpInput({ ...options, signal: controller.signal })
  expect(prepared.text).toContain('资源正文')
  expect(prepared.text).toContain('提示词正文')
  expect(prepared.text).toContain('docs:fixture://guide')
  expect(resourcesRead).toHaveBeenCalledWith(options.scope, 'docs', 'fixture://guide', { sessionId: 'session', signal: controller.signal })
  expect(promptsGet).toHaveBeenCalledWith(options.scope, 'docs', 'review', { file: 'source.ts' }, { sessionId: 'session', signal: controller.signal })
})

it('文本模型拒绝资源或提示词图片，绝不发送base64占位冒充识图', async () => {
  const { options, resourcesRead, promptsGet } = fixture()
  const data = Buffer.from('synthetic-image').toString('base64')
  resourcesRead.mockResolvedValueOnce({ contents: [{ uri: 'fixture://guide', mimeType: 'image/png', blob: data }] })
  await expect(prepareMcpInput(options)).rejects.toThrow('当前模型不支持图片')
  expect(promptsGet).not.toHaveBeenCalled()
  promptsGet.mockResolvedValueOnce({ messages: [{ role: 'assistant', content: { type: 'image', mimeType: 'image/png', data } }] })
  await expect(prepareMcpInput({ ...options, resources: [] })).rejects.toThrow('当前模型不支持图片')
})

it('大文本落盘完整，模型上下文有界；已取消的准备不读取服务器', async () => {
  const { options, resourcesRead, promptsGet } = fixture()
  const fullText = `原始全文\n${'正文'.repeat(15_000)}`
  resourcesRead.mockResolvedValueOnce({ contents: [{ uri: 'fixture://guide', text: fullText }] })
  const prepared = await prepareMcpInput({ ...options, prompts: [] })
  const fragment = JSON.parse(prepared.text.slice(prepared.text.indexOf('{'))) as { text: string; fullTextPath: string }
  expect(fragment.text).toHaveLength(24_000)
  expect(readFileSync(fragment.fullTextPath, 'utf8')).toBe(fullText)
  const controller = new AbortController()
  controller.abort(new Error('用户取消准备'))
  await expect(prepareMcpInput({ ...options, signal: controller.signal })).rejects.toThrow('用户取消准备')
  expect(resourcesRead).toHaveBeenCalledOnce()
  expect(promptsGet).not.toHaveBeenCalled()
})

it('重新读取真实pi转录时只展示原始输入，不把MCP展开内容显示成用户发言', () => {
  const id = 'mcp-history'
  const raw = '请审阅 /mcp:docs:review 和 @docs:guide'
  const expanded = `${raw}\n\n展开的服务器数据，不是用户原话`
  const session = PiSessionManager.create(root, piSessionDir(root, join(root, 'pi')), { id })
  const userEntryId = session.appendMessage({ role: 'user', content: expanded, timestamp: 1000 })
  session.appendCustomEntry('cogent.mcp-input.v1', {
    version: 1, userEntryId, text: raw, resources: [{ server: 'docs', uri: 'fixture://guide' }], prompts: [{ server: 'docs', name: 'review', arguments: { file: 'source.ts' } }]
  })
  const path = findPiTranscriptFile(root, root, id)!
  const before = readFileSync(path, 'utf8')
  const history = readPiTranscript(root, root, id)!
  expect(history[0].mcpInput?.text).toBe(raw)
  expect(toChatMessages(history)[0].content).toBe(raw)
  expect(before).toContain('展开的服务器数据')
  expect(readFileSync(path, 'utf8')).toBe(before)
})
