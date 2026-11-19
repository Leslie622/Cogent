/** 媒体委托必须走官方嵌套工具执行，并如实传播失败与能力限制。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { AttachmentService } from '../../../src/host/runtime/attachments'
import { createReadAttachmentTool } from '../../../src/host/runtime/read-attachment'
import type { MediaBindings } from '../../../src/shared/attachments'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })
async function setup(name = 'clip.mp4', bindings: MediaBindings = { video: {
  server: 'vision', tool: 'analyse', pathArgument: 'path', questionArgument: 'question', formats: ['.mp4'], maxBytes: 100
} }) {
  const root = mkdtempSync(join(tmpdir(), 'cogent-read-test-')); roots.push(root)
  const service = new AttachmentService(root)
  const id = service.begin(name, 3, ''); await service.chunk(id, Buffer.from('abc')); const ref = await service.finish(id); service.claim([ref.id], 's')
  const executeTool = vi.fn().mockResolvedValue({ isError: false, result: { content: [{ type: 'text', text: '画面中有一辆车，00:02 开始移动' }] } })
  const ctx = { tools: [{ name: 'mcp__vision__analyse', parameters: { type: 'object', properties: { path: { type: 'string' }, question: { type: 'string' } } } }], executeTool } as unknown as ExtensionToolContext
  const options = { service, sessionId: 's', hostRoot: root, bindings,
    mcp: { servers: [{ name: 'vision', source: 'test', scope: 'global' as const, config: { command: 'test', enabled: true, exposure: 'direct' as const } }], errors: [] },
    parse: vi.fn().mockResolvedValue({ text: '本地文档文字', source: '测试解析器', warnings: [] }) }
  const call = (params = {}, signal?: AbortSignal) => createReadAttachmentTool(options).execute('read-1', { id: ref.id, ...params }, signal, undefined, ctx)
  return { ref, options, executeTool, ctx, call }
}
describe('read_attachment', () => {
  it('传真实路径、问题和同一取消信号，返回文字与音轨边界', async () => {
    const { call, executeTool, ref, options } = await setup(); const signal = new AbortController().signal
    const outcome = await call({ question: '什么时候开始移动' }, signal)
    expect(executeTool).toHaveBeenCalledWith('mcp__vision__analyse', { path: options.service.path(ref.id), question: '什么时候开始移动' }, { signal })
    expect(outcome.content[0].type === 'text' && outcome.content[0].text).toContain('音轨未分析')
  })
  it('普通文档按需解析，导入与上传不触发工具', async () => {
    const { call, options, executeTool } = await setup('a.txt', {})
    expect(options.parse).not.toHaveBeenCalled(); expect(executeTool).not.toHaveBeenCalled()
    await call(); expect(options.parse).toHaveBeenCalledOnce(); expect(executeTool).not.toHaveBeenCalled()
  })
  it('未配置、无会话归属、工具缺失、schema 不匹配分别报错', async () => {
    const { call, options, executeTool } = await setup()
    options.bindings = {}; await expect(call()).rejects.toThrow('尚未配置')
    options.sessionId = 'another'; await expect(call()).rejects.toThrow('不属于')
    const other = await setup(); (other.ctx.tools as unknown[]).splice(0); await expect(other.call()).rejects.toThrow('不可用')
    const third = await setup(); (third.ctx.tools[0].parameters as { properties: object }).properties = {}; await expect(third.call()).rejects.toThrow('schema')
    expect(executeTool).not.toHaveBeenCalled()
  })
  it('服务拒绝/取消错误不能变成功摘要，纯图片结果也不能冒充文本分析', async () => {
    const { call, executeTool } = await setup()
    executeTool.mockResolvedValueOnce({ isError: true, result: { content: [{ type: 'text', text: '用户拒绝' }] } })
    await expect(call()).rejects.toThrow('用户拒绝')
    executeTool.mockResolvedValueOnce({ isError: false, result: { content: [{ type: 'image', data: 'xxx', mimeType: 'image/png' }] } })
    await expect(call()).rejects.toThrow('没有返回文本')
  })
  it('超限、格式不符、仅 URL 参数及未映射页码不会调用服务', async () => {
    const { options, ctx, call, executeTool } = await setup()
    options.bindings.video!.maxBytes = 1; await expect(call()).rejects.toThrow('容量')
    options.bindings.video!.maxBytes = 100; options.bindings.video!.formats = ['.mov']; await expect(call()).rejects.toThrow('格式')
    options.bindings.video!.formats = ['.mp4']
    const props = (ctx.tools[0].parameters as { properties: Record<string, { type: string; format?: string }> }).properties
    props.path.format = 'uri'; await expect(call()).rejects.toThrow('URL')
    delete props.path.format; await expect(call({ pages: '1' })).rejects.toThrow('页码参数')
    expect(executeTool).not.toHaveBeenCalled()
  })
  it('长分析保留完整 artifact，模型只收到有界内容', async () => {
    const { call, executeTool } = await setup()
    executeTool.mockResolvedValueOnce({ isError: false, result: { content: [{ type: 'text', text: '中'.repeat(30_000) }] } })
    const outcome = await call(); const content = outcome.content[0]
    expect(content.type).toBe('text')
    if (content.type === 'text') { expect(content.text.length).toBeLessThan(26_000); expect(content.text).toContain('完整分析保存在') }
  })
})
