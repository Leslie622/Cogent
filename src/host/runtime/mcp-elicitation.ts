/** MCP 服务端交互挂起表：按调用会话绑定，验证答案并在取消、超时或退出时收口。 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ProtocolError, RpcErrorCode, type McpElicitationRequest, type McpElicitationResponse } from '../../protocol'

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
type Context = { server: string; sessionId?: string; signal?: AbortSignal }
type Pending = { request: McpElicitationRequest; finish: (answer: Answer) => void }
const base = z.object({ message: z.string().max(32_000), mode: z.enum(['form', 'url']).optional() })
const form = base.extend({ mode: z.literal('form').optional(), requestedSchema: z.record(z.string(), z.unknown()) })
const url = base.extend({ mode: z.literal('url'), url: z.url(), elicitationId: z.string().min(1) })

/** 浏览器只能打开 HTTPS 或回环 HTTP，与 OAuth 的壳侧检查相同。 */
export function isMcpBrowserUrl(value: string): boolean {
  try {
    const address = new URL(value)
    return !address.username && !address.password && (address.protocol === 'https:' ||
      (address.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)))
  } catch { return false }
}

function answerSchema(schema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  const parsed = z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.record(z.string(), z.unknown())),
    required: z.array(z.string()).optional()
  }).parse(schema)
  const fields: Array<[string, z.ZodType]> = []
  for (const [name, field] of Object.entries(parsed.properties)) {
    let validator: z.ZodType
    if (field.type === 'string') {
      let value = z.string()
      if (typeof field.minLength === 'number') value = value.min(field.minLength)
      if (typeof field.maxLength === 'number') value = value.max(field.maxLength)
      if (field.format === 'email') value = value.email()
      if (field.format === 'uri') value = value.url()
      validator = value
    } else if (field.type === 'number' || field.type === 'integer') {
      let value = z.number().finite()
      if (field.type === 'integer') value = value.int()
      if (typeof field.minimum === 'number') value = value.min(field.minimum)
      if (typeof field.maximum === 'number') value = value.max(field.maximum)
      validator = value
    } else if (field.type === 'boolean') validator = z.boolean()
    else throw new Error(`不支持的 MCP 表单字段类型: ${name}`)
    if (Array.isArray(field.enum)) {
      const choices = field.enum
      validator = validator.refine((value) => choices.includes(value), '不在允许的选项中')
    }
    fields.push([name, parsed.required?.includes(name) ? validator : validator.optional()])
  }
  return z.object(Object.fromEntries(fields)).strict()
}

export class McpElicitationService {
  private pending = new Map<string, Pending>()
  constructor(private readonly notify: (request: McpElicitationRequest) => void,
    private readonly resolved: (value: { requestId: string; sessionId: string }) => void,
    private readonly timeoutMs = 300_000) {}

  request(params: unknown, context: Context): Promise<Answer> {
    if (!context.sessionId || context.signal?.aborted) return Promise.resolve({ action: 'cancel' })
    const candidate = url.safeParse(params)
    const parsed = candidate.success ? candidate.data : form.parse(params)
    if (parsed.mode === 'url' && !isMcpBrowserUrl(parsed.url)) throw new Error('MCP 交互 URL 不允许打开')
    if (parsed.mode !== 'url') answerSchema(parsed.requestedSchema)
    const common = { requestId: randomUUID(), sessionId: context.sessionId, server: context.server, message: parsed.message }
    const request: McpElicitationRequest = parsed.mode === 'url'
      ? { ...common, mode: 'url', url: parsed.url, elicitationId: parsed.elicitationId }
      : { ...common, mode: 'form', requestedSchema: parsed.requestedSchema }
    return new Promise((resolve) => {
      const cancel = (): void => finish({ action: 'cancel' })
      const timer = setTimeout(cancel, this.timeoutMs)
      timer.unref()
      const finish = (answer: Answer): void => {
        if (!this.pending.delete(request.requestId)) return
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', cancel)
        this.resolved({ requestId: request.requestId, sessionId: request.sessionId })
        resolve(answer)
      }
      this.pending.set(request.requestId, { request, finish })
      context.signal?.addEventListener('abort', cancel, { once: true })
      try { this.notify(request) } catch (error) { finish({ action: 'cancel' }); throw error }
    })
  }

  respond(value: McpElicitationResponse): { ok: true } {
    const pending = this.pending.get(value.requestId)
    if (!pending) throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 交互请求不存在或已完成')
    if (value.action === 'accept' && pending.request.mode === 'form') {
      const answer = answerSchema(pending.request.requestedSchema).safeParse(value.content)
      if (!answer.success) throw new ProtocolError(RpcErrorCode.InvalidParams, 'MCP 表单答案不符合字段要求')
      pending.finish({ action: 'accept', content: answer.data })
    } else pending.finish({ action: value.action })
    return { ok: true }
  }
  list(sessionId: string): McpElicitationRequest[] {
    return [...this.pending.values()].filter((value) => value.request.sessionId === sessionId).map((value) => value.request)
  }
  cancelSession(sessionId: string): void {
    for (const pending of this.pending.values()) if (pending.request.sessionId === sessionId) pending.finish({ action: 'cancel' })
  }
  dispose(): void { for (const pending of this.pending.values()) pending.finish({ action: 'cancel' }) }
}
