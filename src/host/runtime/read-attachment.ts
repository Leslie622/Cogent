/** 文档工具统一入口；媒体委托经 pi 官方 executeTool，保留审批、取消和观测。 */
import { Type } from 'typebox'
import { defineTool, type ExtensionToolContext, type LoadedMcpConfig, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { mcpNamespace } from '@earendil-works/pi-mcp'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AttachmentService } from './attachments'
import { hasLocalAttachmentReader, mediaBindingIssue, type MediaBindings, type MediaCapability } from '../../shared/attachments'
import type { ParsedAttachment, ParseRequest } from './attachment-parser'

const PARAMS = Type.Object({
  id: Type.String({ description: '用户附件的稳定 id' }),
  cursor: Type.Optional(Type.Integer({ minimum: 0, description: '上次返回的 nextCursor；PDF/PPTX 是从 0 起的页/幻灯片，其余为字符或行位置' })),
  sheet: Type.Optional(Type.String()), range: Type.Optional(Type.String({ description: 'XLSX 范围，例如 A1:D20' })),
  question: Type.Optional(Type.String({ description: '需要分析的内容' })),
  visual: Type.Optional(Type.Boolean({ description: 'PDF/Office 页面图像、扫描件、图表等视觉需求' })),
  pages: Type.Optional(Type.String({ description: '媒体分析页码，例如 1-3，传给配置的页码参数' }))
})
export const READ_ATTACHMENT_DESCRIPTION = '按需读取用户附件：本地提取 PDF 文字、DOCX 标题段落表格、XLSX 工作表/公式缓存、PPTX 文字备注表格及文本。图片/视频/扫描或页面视觉问题委托配置的 MCP。结果标明范围、局限与 nextCursor；未解析不能声称看过。'

let activeParsers = 0
const parserQueue: Array<{ start: () => void; cancel: () => void; signal?: AbortSignal }> = []
async function acquireParser(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (activeParsers < 2) { activeParsers++; return }
  await new Promise<void>((resolve, reject) => {
    const pending = { start: resolve, cancel: () => {
      parserQueue.splice(parserQueue.indexOf(pending), 1)
      reject(new Error('附件读取在排队时已取消'))
    }, signal }
    parserQueue.push(pending); signal?.addEventListener('abort', pending.cancel, { once: true })
  })
}
function releaseParser(): void {
  const next = parserQueue.shift()
  if (next === undefined) activeParsers--
  else { next.signal?.removeEventListener('abort', next.cancel); next.start() }
}

export async function parseInWorker(request: ParseRequest, signal?: AbortSignal): Promise<ParsedAttachment> {
  await acquireParser(signal)
  try {
    signal?.throwIfAborted()
    return await new Promise<ParsedAttachment>((resolve, reject) => {
      // Host 入口拥有构建目录，不能按打包后可能位于 chunks/ 的本模块定位。
      const worker = new Worker(process.env.COGENT_ATTACHMENT_WORKER ?? join(import.meta.dirname, '..', 'attachment-worker.js'), {
        workerData: request, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 }, stdout: true, stderr: true
      })
      // PDF/Office 库的诊断绝不能混进 Host stdout 的 JSON-RPC 帧。
      worker.stdout.on('data', (data: Buffer) => process.stderr.write(data))
      worker.stderr.on('data', (data: Buffer) => process.stderr.write(data))
      const finish = (error?: Error, result?: ParsedAttachment): void => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
        worker.removeAllListeners(); void worker.terminate()
        if (error !== undefined) reject(error)
        else resolve(result!)
      }
      const abort = (): void => finish(new Error('附件读取已取消'))
      const timer = setTimeout(() => finish(new Error('附件解析超过 30 秒，已终止；可缩小文件或改用文档分析工具')), 30_000)
      signal?.addEventListener('abort', abort, { once: true })
      worker.once('error', (error: Error) => finish(error))
      worker.once('exit', (code) => finish(new Error(`附件解析进程退出（${code}）`)))
      worker.once('message', (value: { result?: ParsedAttachment; error?: string }) => {
        if (value.error !== undefined) finish(new Error(value.error))
        else finish(undefined, value.result)
      })
    })
  } finally { releaseParser() }
}
export interface AttachmentToolOptions {
  service: AttachmentService; sessionId: string; hostRoot: string; bindings: MediaBindings; mcp: LoadedMcpConfig
  parse?: typeof parseInWorker
}
function result(text: string, details: unknown) { return { content: [{ type: 'text' as const, text }], details } }

async function delegate(options: AttachmentToolOptions, capability: MediaCapability, id: string, question: string,
  pages: string | undefined, signal: AbortSignal | undefined, ctx: ExtensionToolContext): Promise<ParsedAttachment> {
  const binding = options.bindings[capability]
  if (binding === undefined) throw new Error(`未解析：尚未配置 ${capability} 分析工具。请在设置 → MCP 服务器配置，或作为文件保留。`)
  const server = options.mcp.servers.find((entry) => entry.name === binding.server)
  if (server === undefined || server.config.enabled === false) throw new Error(`未解析：本会话快照中服务器 ${binding.server} 未安装或未启用；配置后请新建聊天。`)
  if ('url' in server.config) throw new Error('未解析：远程 HTTP MCP 无法读取本机附件路径，输入方式不兼容；当前未配置服务器上传。')
  const ref = options.service.forSession(id, options.sessionId)
  const issue = mediaBindingIssue(ref, binding)
  if (issue !== undefined) throw new Error(`未解析：${issue}，请更换工具或附加较小片段。`)
  const name = `${mcpNamespace(binding.server)}__${binding.tool}`
  const tool = ctx.tools.find((tool) => tool.name === name)
  if (tool === undefined) throw new Error(`未解析：本会话中工具 ${name} 不可用（尚未连接、未注册或隐藏），请检查 MCP 日志后重试。`)
  const schema = tool.parameters as { properties?: Record<string, { type?: string; format?: string }> }
  for (const key of [binding.pathArgument, binding.questionArgument, ...(binding.pagesArgument === undefined ? [] : [binding.pagesArgument])]) {
    if (schema.properties?.[key]?.type !== 'string') throw new Error(`未解析：MCP 参数 ${key} 不是字符串字段，参数映射与工具 schema 不匹配。`)
  }
  if (schema.properties?.[binding.pathArgument]?.format === 'uri') throw new Error('未解析：工具要求 URL，不能接收本机路径。')
  if (pages !== undefined && binding.pagesArgument === undefined) throw new Error('未解析：该文档工具没有配置页码参数，不能保证只分析指定页面。')
  const args = { [binding.pathArgument]: options.service.path(id), [binding.questionArgument]: question,
    ...(pages !== undefined && binding.pagesArgument !== undefined && { [binding.pagesArgument]: pages }) }
  const outcome = await ctx.executeTool(name, args, { signal })
  const text = outcome.result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  if (outcome.isError) throw new Error(`媒体分析失败：${text || '工具拒绝或执行失败'}`)
  if (text.trim() === '') throw new Error('未解析：分析工具没有返回文本；仅图片结果不能作为文本主模型的分析内容。')
  return { text, source: `MCP ${name}`, warnings: [
    '分析覆盖范围以服务返回内容为准；未报告的覆盖范围未知。',
    ...(capability === 'video' && binding.audio !== true ? ['音轨未分析（服务未声明音频分析能力）。'] : [])
  ] }
}
export function createReadAttachmentTool(options: AttachmentToolOptions): ToolDefinition {
  return defineTool({
    name: 'read_attachment', label: '读取附件', description: READ_ATTACHMENT_DESCRIPTION, parameters: PARAMS,
    execute: async (_callId, params, signal, _onUpdate, ctx) => {
      const ref = options.service.forSession(params.id, options.sessionId)
      await options.service.verify(ref.id, signal)
      const capability = ref.mime.startsWith('image/') ? 'image' : ref.mime.startsWith('video/') ? 'video' : 'document'
      const visual = capability !== 'document' || params.visual === true || !hasLocalAttachmentReader(ref)
      let parsed = visual ? await delegate(options, capability, ref.id, params.question ?? '请分析这个附件的内容', params.pages, signal, ctx) :
        await (options.parse ?? parseInWorker)({ path: options.service.path(ref.id), name: ref.name, cursor: params.cursor ?? 0,
          sheet: params.sheet, range: params.range }, signal)
      if (parsed.requiresVisual === true && options.bindings.document !== undefined) {
        parsed = await delegate(options, 'document', ref.id, params.question ?? '本页没有可提取文字，请分析页面内容',
          String((params.cursor ?? 0) + 1), signal, ctx)
      }
      let text = parsed.text
      let artifact: string | undefined
      if (text.length > 24_000) {
        const directory = join(options.hostRoot, 'attachments', 'v1', 'analysis')
        mkdirSync(directory, { recursive: true }); artifact = join(directory, `${crypto.randomUUID()}.txt`)
        writeFileSync(artifact, text); text = text.slice(0, 24_000)
        parsed.warnings.push(`输出已截断；完整分析保存在 ${artifact}，可用 read 工具分页读取。`)
      }
      return result(JSON.stringify({ id: ref.id, source: parsed.source, text, warnings: parsed.warnings,
        ...(parsed.nextCursor !== undefined && { nextCursor: parsed.nextCursor }), total: parsed.total, artifact }),
      { attachmentId: ref.id, source: parsed.source, warnings: parsed.warnings, nextCursor: parsed.nextCursor })
    }
  })
}
export function attachmentToolDeclaration() { return { name: 'read_attachment', description: READ_ATTACHMENT_DESCRIPTION, parameters: PARAMS } }
