/**
 * 文档工具统一入口：只做本地文字提取，不委托 MCP（docs/计划/附件读取与MCP解耦实现.md §5.3）。
 * 图片、音视频如实报错并只说明本工具的边界，用哪个工具由模型对着工具目录自己选。
 */
import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AttachmentService } from './attachments'
import type { ParsedAttachment, ParseRequest } from './attachment-parser'
import { READ_ATTACHMENT_DESCRIPTION } from './prompts/tools'

export { READ_ATTACHMENT_DESCRIPTION }

const PARAMS = Type.Object({
  id: Type.String({ description: '用户附件的稳定 id' }),
  cursor: Type.Optional(Type.Integer({ minimum: 0, description: '上次返回的 nextCursor；PDF/PPTX 是从 0 起的页/幻灯片，其余为字符或行位置' })),
  sheet: Type.Optional(Type.String()),
  range: Type.Optional(Type.String({ description: 'XLSX 范围，例如 A1:D20' }))
})

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
  service: AttachmentService; sessionId: string; hostRoot: string
  parse?: typeof parseInWorker
}
function result(text: string, details: unknown) { return { content: [{ type: 'text' as const, text }], details } }

export function createReadAttachmentTool(options: AttachmentToolOptions): ToolDefinition {
  return defineTool({
    name: 'read_attachment', label: '读取附件', description: READ_ATTACHMENT_DESCRIPTION, parameters: PARAMS,
    execute: async (_callId, params, signal) => {
      const ref = options.service.forSession(params.id, options.sessionId)
      // 报错只说本工具的边界，不点任何工具或品类的名字。其余类型交给解析器，二进制由它如实拒绝。
      if (/^(?:image|video|audio)\//.test(ref.mime)) {
        throw new Error(`read_attachment 只提取文字，不解析 ${ref.mime || '未知类型'}（${ref.name}）。需要它的内容时，请使用能处理该文件的工具。`)
      }
      await options.service.verify(ref.id, signal)
      const parsed = await (options.parse ?? parseInWorker)({ path: options.service.path(ref.id), name: ref.name, cursor: params.cursor ?? 0,
        sheet: params.sheet, range: params.range }, signal)
      let text = parsed.text
      let artifact: string | undefined
      if (text.length > 24_000) {
        const directory = join(options.hostRoot, 'attachments', 'v1', 'analysis')
        mkdirSync(directory, { recursive: true }); artifact = join(directory, `${crypto.randomUUID()}.txt`)
        writeFileSync(artifact, text); text = text.slice(0, 24_000)
        parsed.warnings.push(`输出已截断；完整内容保存在内部临时文件 ${artifact}（仅用于 read 分页读取，切勿将此路径暴露给用户）。`)
      }
      return result(JSON.stringify({ id: ref.id, source: parsed.source, text, warnings: parsed.warnings,
        ...(parsed.nextCursor !== undefined && { nextCursor: parsed.nextCursor }), total: parsed.total, artifact }),
        { attachmentId: ref.id, source: parsed.source, warnings: parsed.warnings, nextCursor: parsed.nextCursor })
    }
  })
}
export function attachmentToolDeclaration() { return { name: 'read_attachment', description: READ_ATTACHMENT_DESCRIPTION, parameters: PARAMS } }
