/** read_attachment 只做本地提取：不解析的类型如实报错，任何路径都不再调用其他工具。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { AttachmentService } from '../../../src/host/runtime/attachments'
import { AttachmentConfig } from '../../../src/host/runtime/attachment-config'
import { attachmentToolDeclaration, createReadAttachmentTool } from '../../../src/host/runtime/read-attachment'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })
/** 1×1 透明 PNG：导入时服务会校验图片头，图片类型的夹具必须是真图。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
async function setup(name: string, mime = 'text/plain', bytes: Buffer = Buffer.from('abc')) {
  const root = mkdtempSync(join(tmpdir(), 'cogent-read-test-')); roots.push(root)
  const service = new AttachmentService(root)
  const id = service.begin(name, bytes.length, mime); await service.chunk(id, bytes); const ref = await service.finish(id); service.claim([ref.id], 's')
  // 旧版经 ctx.executeTool 嵌套调用 MCP 工具；现在任何路径都不得再碰它。
  const executeTool = vi.fn()
  const ctx = { tools: [], executeTool } as unknown as ExtensionToolContext
  const options = { service, sessionId: 's', hostRoot: root, parse: vi.fn().mockResolvedValue({ text: '本地文档文字', source: '测试解析器', warnings: [] as string[] }) }
  const call = (params: { cursor?: number; sheet?: string; range?: string } = {}, signal?: AbortSignal) =>
    createReadAttachmentTool(options).execute('read-1', { id: ref.id, ...params }, signal, undefined, ctx)
  return { root, ref, options, executeTool, call }
}
const textOf = (outcome: Awaited<ReturnType<ReturnType<typeof createReadAttachmentTool>['execute']>>): string => {
  const block = outcome.content[0]
  return block.type === 'text' ? block.text : ''
}

describe('read_attachment', () => {
  it('文档按需本地解析，导入不触发解析，任何路径都不调用其他工具', async () => {
    const { call, options, executeTool } = await setup('a.txt')
    expect(options.parse).not.toHaveBeenCalled()
    const outcome = await call({ cursor: 2 })
    expect(options.parse).toHaveBeenCalledOnce()
    expect(options.parse.mock.calls[0][0]).toMatchObject({ name: 'a.txt', cursor: 2 })
    expect(textOf(outcome)).toContain('本地文档文字')
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('图片、音视频如实报错并只说本工具的边界，不解析也不调用其他工具', async () => {
    for (const [name, mime, bytes] of [['a.png', 'image/png', PNG], ['clip.mp4', 'video/mp4', Buffer.from('abc')], ['note.wav', 'audio/wav', Buffer.from('abc')]] as const) {
      const { call, options, executeTool } = await setup(name, mime, bytes)
      const failure = await call().then(() => undefined, (error: unknown) => error as Error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure?.message).toContain('read_attachment 只提取文字')
      expect(failure?.message).toContain(`${mime}（${name}）`)
      // 不点任何工具或品类的名字，用哪个工具由模型自己选。
      expect(failure?.message).not.toMatch(/MCP|识图|视觉|视频分析/)
      expect(options.parse).not.toHaveBeenCalled()
      expect(executeTool).not.toHaveBeenCalled()
    }
  })

  it('盘上留有旧媒体绑定也不再委托，绑定文件原样', async () => {
    const { root, call, executeTool } = await setup('clip.mp4', 'video/mp4')
    const file = join(root, 'attachments', 'v1', 'media.json')
    new AttachmentConfig(root).saveMedia({ video: { server: 'vision', tool: 'analyse', pathArgument: 'path', questionArgument: 'question', formats: ['.mp4'], maxBytes: 100 } })
    const before = readFileSync(file, 'utf8')
    await expect(call()).rejects.toThrow('只提取文字')
    expect(executeTool).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('扫描页保留解析器的警告并继续分页，不再委托', async () => {
    const { call, options, executeTool } = await setup('scan.pdf', 'application/pdf')
    options.parse.mockResolvedValueOnce({ text: '第 1 / 3 页\n', source: '本地 PDF.js 文字提取', requiresVisual: true, total: 3, nextCursor: 1,
      warnings: ['仅提取页面文字；未分析图片、图表和排版。', '本页未提取到文字，可能是空白页或扫描件。'] })
    const payload = JSON.parse(textOf(await call())) as { warnings: string[]; nextCursor?: number; total?: number; source: string }
    expect(payload).toMatchObject({ nextCursor: 1, total: 3, source: '本地 PDF.js 文字提取' })
    expect(payload.warnings).toContain('本页未提取到文字，可能是空白页或扫描件。')
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('长内容保留完整 artifact，模型只收到有界内容', async () => {
    const { root, call, options } = await setup('big.txt')
    options.parse.mockResolvedValueOnce({ text: '中'.repeat(30_000), source: '测试解析器', warnings: [], total: 30_000 })
    const text = textOf(await call())
    expect(text.length).toBeLessThan(26_000)
    expect(text).toContain('完整内容保存在')
    expect(readdirSync(join(root, 'attachments', 'v1', 'analysis'))).toHaveLength(1)
  })

  it('附件不属于当前会话时拒绝读取', async () => {
    const { call, options } = await setup('a.txt')
    options.sessionId = 'another'
    await expect(call()).rejects.toThrow('不属于')
  })

  it('工具声明只保留本地提取用得到的参数', () => {
    expect(Object.keys(attachmentToolDeclaration().parameters.properties)).toEqual(['id', 'cursor', 'sheet', 'range'])
  })
})
