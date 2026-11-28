/**
 * MCP 传输适配：stdio/Streamable HTTP 复用 pi-mcp，Legacy SSE 在此补齐。
 * 解析只接受有限大小的 JSON-RPC 事件；endpoint 必须同源，避免把认证头发送给第三方。
 */
import { spawn } from 'node:child_process'
import {
  McpAuthRequiredError,
  McpConnectionClosedError,
  parseJsonRpcMessage,
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  type McpTransportSendOptions
} from '@earendil-works/pi-mcp'
import type { McpServerDef } from '../../protocol'

const MAX_EVENT_BYTES = 16 * 1024 * 1024

/** Windows 先回收整树再关管道，避免 cmd/npx 先退后丢失可定位的父 PID。 */
class OwnedStdioTransport extends StdioTransport {
  private closing?: Promise<void>

  override close(): Promise<void> {
    this.closing ??= this.closeTree()
    return this.closing
  }

  private async closeTree(): Promise<void> {
    const pid = this.pid
    if (process.platform === 'win32' && pid !== undefined) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        const timer = setTimeout(() => { killer.kill(); resolve() }, 2500)
        const settle = (): void => { clearTimeout(timer); resolve() }
        killer.once('error', settle)
        killer.once('close', settle)
      })
    }
    await super.close()
  }
}

export interface SseTransportOptions {
  url: string
  headers?: Record<string, string>
  authProvider?: AuthProvider
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Legacy HTTP+SSE：GET 接收帧，server 的 endpoint 事件指定同源 POST 地址。 */
export class SseTransport implements McpTransport {
  private readonly messages = new Set<McpTransportMessageListener>()
  private readonly errors = new Set<McpTransportErrorListener>()
  private readonly closes = new Set<McpTransportCloseListener>()
  private readonly controller = new AbortController()
  private endpoint?: URL
  private closed = false
  private started = false
  private stream?: Promise<void>
  private resolveEndpoint?: () => void
  private rejectEndpoint?: (error: Error) => void

  constructor(private readonly options: SseTransportOptions) {}

  onMessage(listener: McpTransportMessageListener): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errors.add(listener)
    return () => this.errors.delete(listener)
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }

  private async authorizedFetch(url: URL, init: RequestInit, dispatchSignal?: AbortSignal): Promise<Response> {
    const run = async (): Promise<{ response: Response; token?: string }> => {
      const token = await this.options.authProvider?.token()
      dispatchSignal?.throwIfAborted()
      const headers = new Headers(this.options.headers)
      new Headers(init.headers).forEach((value, name) => headers.set(name, value))
      if (token !== undefined) headers.set('Authorization', `Bearer ${token}`)
      const response = await (this.options.fetch ?? fetch)(url, { ...init, headers, redirect: 'error' })
      return { response, token }
    }
    let result = await run()
    if (result.response.status === 401 && this.options.authProvider?.onUnauthorized !== undefined) {
      await this.options.authProvider.onUnauthorized({
        response: result.response,
        serverUrl: new URL(this.options.url),
        fetch: this.options.fetch ?? fetch,
        token: result.token
      })
      await result.response.body?.cancel()
      result = await run()
    }
    if (result.response.status === 401) throw new McpAuthRequiredError(result.response)
    if (!result.response.ok) {
      await result.response.body?.cancel()
      throw new Error(`MCP SSE HTTP ${result.response.status}`)
    }
    return result.response
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('MCP SSE transport cannot be restarted')
    this.started = true
    const endpointReady = new Promise<void>((resolve, reject) => {
      this.resolveEndpoint = resolve
      this.rejectEndpoint = reject
    })
    // 在 fetch 前订阅拒绝，连接失败与超时都不会制造未处理 rejection。
    void endpointReady.catch(() => undefined)
    const timer = setTimeout(() => {
      this.fail(new Error('MCP SSE endpoint timed out'))
      this.controller.abort()
    }, this.options.timeoutMs ?? 10_000)
    try {
      const response = await this.authorizedFetch(new URL(this.options.url), {
        method: 'GET', headers: { Accept: 'text/event-stream' }, signal: this.controller.signal
      })
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || response.body === null) {
        await response.body?.cancel()
        throw new Error('MCP SSE requires a text/event-stream response')
      }
      this.stream = this.consume(response.body).catch((error: unknown) => {
        if (!this.closed) this.fail(error instanceof Error ? error : new Error(String(error)))
      }).finally(() => this.closeEvent())
      await endpointReady
    } catch (error) {
      this.controller.abort()
      this.closeEvent()
      throw error
    } finally {
      clearTimeout(timer)
      this.resolveEndpoint = undefined
      this.rejectEndpoint = undefined
    }
  }

  private fail(error: Error): void {
    this.rejectEndpoint?.(error)
    for (const listener of this.errors) listener(error)
  }

  private closeEvent(): void {
    if (this.closed) return
    this.closed = true
    this.rejectEndpoint?.(new McpConnectionClosedError())
    for (const listener of this.closes) listener()
  }

  private event(name: string, data: string): void {
    if (name === 'endpoint') {
      const endpoint = new URL(data, this.options.url)
      const origin = new URL(this.options.url)
      if (endpoint.origin !== origin.origin || endpoint.username !== '' || endpoint.password !== '') {
        throw new Error('MCP SSE endpoint must use the configured origin')
      }
      this.endpoint = endpoint
      this.resolveEndpoint?.()
    } else if (name === 'message' || name === '') {
      const message = parseJsonRpcMessage(JSON.parse(data))
      for (const listener of this.messages) listener(message)
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = ''
    let data: string[] = []
    let bytes = 0
    const line = (value: string): void => {
      if (value === '') {
        if (data.length > 0) this.event(eventName, data.join('\n'))
        eventName = ''; data = []; bytes = 0
        return
      }
      bytes += Buffer.byteLength(value)
      if (bytes > MAX_EVENT_BYTES) throw new Error('MCP SSE event exceeds size limit')
      if (value.startsWith(':')) return
      const colon = value.indexOf(':')
      const name = colon < 0 ? value : value.slice(0, colon)
      let content = colon < 0 ? '' : value.slice(colon + 1)
      if (content.startsWith(' ')) content = content.slice(1)
      if (name === 'event') eventName = content
      if (name === 'data') data.push(content)
    }
    try {
      while (!this.closed) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw new Error('MCP SSE line exceeds size limit')
        let newline: number
        while ((newline = buffer.search(/[\r\n]/)) >= 0) {
          // 分块边界可能拆开 CRLF；先保留末尾 CR，下一块再确定消费长度。
          if (buffer[newline] === '\r' && newline === buffer.length - 1) break
          const width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1
          line(buffer.slice(0, newline))
          buffer = buffer.slice(newline + width)
        }
      }
      buffer += decoder.decode()
      for (const value of buffer.split(/\r\n|\r|\n/).slice(0, -1)) line(value)
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  async send(message: JsonRpcMessage, options: McpTransportSendOptions = {}): Promise<void> {
    if (this.closed || this.endpoint === undefined) throw new McpConnectionClosedError()
    options.signal?.throwIfAborted()
    const response = await this.authorizedFetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: options.signal === undefined ? this.controller.signal : AbortSignal.any([this.controller.signal, options.signal])
    }, options.signal)
    await response.body?.cancel()
  }

  async close(): Promise<void> {
    this.controller.abort()
    this.closeEvent()
    await this.stream
  }
}

export interface McpTransportOptions {
  authProvider?: AuthProvider
  onStderr?: (text: string) => void
}

/** def 必须已通过受控变量解析；stdio 显式禁用再次继承宿主 env。 */
export function createMcpTransport(def: McpServerDef, options: McpTransportOptions = {}): McpTransport {
  if (def.type === 'stdio') {
    return new OwnedStdioTransport({
      command: def.command, args: def.args, cwd: def.cwd, env: def.env,
      inheritEnv: false, stderr: 'pipe', onStderr: options.onStderr, closeTimeoutMs: 2000
    })
  }
  if (def.type === 'sse') {
    return new SseTransport({ url: def.url, headers: def.headers, authProvider: options.authProvider })
  }
  return new StreamableHttpTransport({ url: def.url, headers: def.headers, authProvider: options.authProvider })
}

/** pi stdio 已管理进程组；再加宿主关闭预算，防异常管道拖住退出。 */
export async function closeMcpTransport(transport: McpTransport): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      transport.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (transport instanceof StdioTransport && transport.pid !== undefined) {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/PID', String(transport.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
            } else {
              try { process.kill(-transport.pid, 'SIGKILL') } catch { /* 已退出的进程组无需再次回收。 */ }
            }
          }
          resolve()
        }, 4000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
