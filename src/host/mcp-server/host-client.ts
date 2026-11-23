/**
 * 对外 MCP Server 的 Host 客户端：把 MCP 工具调用翻译成 HostApi /rpc 帧
 * （+ waitMs 场景的 /ws 事件等待）。Cogent 方言全部圈死在这一层 —— 工具层
 * （tools.ts）只见业务形状，外部 agent 只见 MCP 标准（docs/模块/对外MCP.md：
 * 本进程是翻译官，不是透传层）。
 *
 * 错误投影（Pi-meme hosts.ts:207-268 同款纪律，本地版）：网络/超时/越档
 * 各归一词、token 永不进错误消息 —— 外部 agent 拿到的是可行动的词，不是
 * 原始异常。
 */
import { WebSocket } from 'ws'
import { readAccess, REQUEST_TIMEOUT_MS, type McpAccess } from './config'

/** 工具层用的统一错误（tools.ts 转 isError 结果帧） */
export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const NO_ACCESS_HINT =
  '未找到有效凭据（mcp-access.json）。请在 Cogent 设置文件 (~/.cogent/settings.json) 中启用 externalMcp.enabled 并（重）启动应用后重试'

/** 单帧 /rpc：重读凭据 → POST → 投影错误。外部世界边界（网络/Host 都是常态失败源） */
export async function callHost<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
  const access = readAccess()
  if (access === null) throw new HostError('no-access', NO_ACCESS_HINT)
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${access.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])])
    })
  } catch (cause) {
    if (signal?.aborted) throw new HostError('cancelled', 'MCP 请求已取消')
    if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      throw new HostError('outcome-uncertain', '请求超时，结果未知：用 cogent_session_messages 查询后再决定是否重试，勿盲目重发')
    }
    // ECONNREFUSED 等 → Host 不在（应用没开/正在重启），不是本进程的故障
    throw new HostError('host-unreachable', '无法连接 Cogent Host：请确认桌面应用正在运行')
  }
  if (response.status === 401) {
    throw new HostError('token-invalid', '凭据已失效（Host 重启后旧 token 作废）：等待应用重写凭据文件后重试')
  }
  if (!response.ok) {
    throw new HostError('http-error', `Host HTTP ${response.status}`)
  }
  const frame = (await response.json()) as { result?: T; error?: { code: number; message: string } }
  if (frame.error !== undefined) {
    // 越档（-32003，server.ts SCOPE_FORBIDDEN_CODE）：凭据档位撑不起该方法
    if (frame.error.code === -32003) {
      throw new HostError('scope-forbidden', `${frame.error.message}；如需放开请在设置中开启 externalMcp.allowWrites 并重启应用`)
    }
    throw new HostError('rpc-error', `${method} 失败（${frame.error.code}）: ${frame.error.message}`)
  }
  return frame.result as T
}

/** run 终态事件 params 的断言子集（工具层只关心这两个字段族） */
export interface RunOutcome {
  state: 'completed' | 'failed' | 'timeout'
  /** run.completed：最终完整 assistant 回复 */
  message?: { role: string; content: string }
  messages?: Array<{ role: string; content: string }>
  /** run.failed 的失败原因 */
  failure?: string
  stopReason?: string
}

/**
 * 订阅 run 终态（submit 的 waitMs 用）。事件顺序设计：**先等 WS
 * 就绪、后发 submit** —— 事件不重放（WS 是推送不是回放），先提交再订阅的
 * 话快任务可能在订阅前就 completed，等待挂到超时。两段式生命周期：
 *
 *   const sub = subscribeRun(sessionId)
 *   await sub.ready()      // WS open（Host 不可达时这里抛 host-unreachable）
 *   await callHost('agent.submit', ...)
 *   const outcome = await sub.awaitOutcome(waitMs, signal)
 *   // （未等终态要放弃时调 sub.close()）
 *
 * 超时/中断/断连都返回 state:'timeout' 而不抛 —— 受理已发生，超时不是
 * 错误（「不判失败：受理是真的」）。
 */
export interface RunSubscription {
  ready(): Promise<void>
  awaitOutcome(waitMs: number, signal: AbortSignal | undefined): Promise<RunOutcome>
  close(): void
}

export function subscribeRun(sessionId: string): RunSubscription {
  const access = readAccess()
  if (access === null) throw new HostError('no-access', NO_ACCESS_HINT)
  const ws = new WebSocket(`ws://127.0.0.1:${access.port}/ws?token=${encodeURIComponent(access.token)}`)

  let settled: RunOutcome | undefined
  let resolveOutcome: ((outcome: RunOutcome) => void) | undefined
  const outcomePromise = new Promise<RunOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  const settle = (outcome: RunOutcome): void => {
    if (settled !== undefined) return
    settled = outcome
    resolveOutcome?.(outcome)
    try {
      ws.close()
    } catch {
      // close 竞态（已断）无需处理：等待已由 outcome 结清
    }
  }

  ws.on('message', (data: Buffer) => {
    let frame: { method?: string; params?: { sessionId?: string } & Record<string, unknown> }
    try {
      frame = JSON.parse(data.toString()) as { method?: string; params?: { sessionId?: string } & Record<string, unknown> }
    } catch {
      return // 非帧行（不该发生，但推送通道的畸形行不该炸等待）
    }
    if (frame.params?.sessionId !== sessionId) return
    if (frame.method === 'run.completed') {
      const params = frame.params as { message?: RunOutcome['message']; messages?: RunOutcome['messages']; stopReason?: string }
      settle({ state: 'completed', message: params.message, messages: params.messages, stopReason: params.stopReason })
    } else if (frame.method === 'run.failed') {
      // run.failed 的 message 按协议是 string（types.ts:1091）；推送通道按
      // 宽形收，此处收窄一次
      const params = frame.params as { message?: string }
      settle({ state: 'failed', failure: params.message ?? '' })
    }
  })
  // 断连/握手失败都归 timeout 语义（结果未知）；ready() 另用 once 挂同事件
  // 把握手失败投影成 host-unreachable 抛给调用方
  ws.on('error', () => settle({ state: 'timeout' }))
  ws.on('close', () => settle({ state: 'timeout' }))

  return {
    ready: () =>
      new Promise<void>((resolveReady, rejectReady) => {
        if (ws.readyState === WebSocket.OPEN) return resolveReady()
        ws.once('open', () => resolveReady())
        ws.once('error', (err: Error) => rejectReady(new HostError('host-unreachable', `WS 订阅失败：${err.message}`)))
      }),
    awaitOutcome: (waitMs, signal) => {
      if (settled !== undefined) return Promise.resolve(settled)
      const timer = setTimeout(() => settle({ state: 'timeout' }), waitMs)
      const onAbort = (): void => settle({ state: 'timeout' })
      signal?.addEventListener('abort', onAbort, { once: true })
      return outcomePromise.then((outcome) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        return outcome
      })
    },
    close: () => settle({ state: 'timeout' })
  }
}

/** 供 tools.ts 判断写组注册（启动快照语义，见 config.ts 头注） */
export function initialAccess(): McpAccess | null {
  return readAccess()
}
