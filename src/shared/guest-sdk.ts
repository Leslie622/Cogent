/**
 * webview guest 的 HostApi 小 SDK（D10）：preload（isolated world）内运行，
 * 页面只摸到 contextBridge 暴露的 request/onEvent 两个函数 —— 票据与
 * token 全程留在 preload 内存，不进页面全局（im2.0 window.native 泄漏
 * 进程级权限的反面教训）。
 *
 * 链路（D3 票据生命周期在页面侧的一半）：
 * ① 启动即经白名单 IPC 向 main 要一次性票据（30s，main 发起、Host 存证）
 * ② POST /auth/exchange 换长期 token（票据即焚）
 * ③ 之后 request 走 POST /rpc Bearer；事件走 WS ?token=（浏览器 WebSocket
 *    不能自定义头，与 zcode 同款双轨）
 *
 * 边界（3a 范围）：WS 断线不自动重连（demo 阶段 console 报错即可；重连与
 * 快照补偿留真实远程 UI 实用化时）；token 失效（Host 重启）不自动重取。
 * 纯逻辑零 electron 依赖 —— fetch/WebSocket 经依赖注入，单测无需 jsdom 网络。
 */
import type { ProtocolEvents, ProtocolMethods, RpcResponse, TokenScope } from '../protocol'

export interface GuestCredentials {
  ticket: string
  httpPort: number
  scope: TokenScope
}

export interface GuestSdkDeps {
  getCredentials(): Promise<GuestCredentials>
  fetchImpl: typeof fetch
  WebSocketImpl: typeof WebSocket
}

export interface GuestSdk {
  /** 等凭证/换 token/WS 就绪；失败（HTTP 门未开等）reject 一次性暴露给页面 */
  ready(): Promise<TokenScope>
  request<M extends keyof ProtocolMethods>(
    method: M,
    params: ProtocolMethods[M]['params']
  ): Promise<ProtocolMethods[M]['result']>
  /** 订阅事件帧（WS 下行）；返回取消订阅。handler 在 WS 消息到达时同步调用 */
  onEvent<E extends keyof ProtocolEvents>(
    method: E,
    handler: (params: ProtocolEvents[E]) => void
  ): () => void
}

export function createGuestSdk(deps: GuestSdkDeps): GuestSdk {
  const handlers = new Map<string, Set<(params: unknown) => void>>()
  let token: string | null = null
  let base: string | null = null

  const init = (async () => {
    const { ticket, httpPort } = await deps.getCredentials()
    base = `http://127.0.0.1:${httpPort}`
    const exchange = await deps.fetchImpl(`${base}/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket })
    })
    if (!exchange.ok) throw new Error(`票据兑换失败（HTTP ${exchange.status}）`)
    const granted = (await exchange.json()) as { token: string; scope: string }
    token = granted.token
    // 事件流：浏览器 WS 不能自定义 Authorization 头，token 走 query（D2 双轨）
    const ws = new deps.WebSocketImpl(`ws://127.0.0.1:${httpPort}/ws?token=${token}`)
    ws.onmessage = (message) => {
      // 下行两种帧：事件（method 无 id）分发；响应（id 有）不经过这里，忽略
      const frame = JSON.parse(String(message.data)) as { method?: string; id?: number; params?: unknown }
      if (frame.method === undefined || frame.id !== undefined || frame.params === undefined) return
      for (const handler of handlers.get(frame.method) ?? []) handler(frame.params)
    }
    ws.onclose = () => console.error('[cogent-host] 事件流断开（3a 不自动重连，刷新页面重取凭证）')
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('事件流 WS 连接失败'))
    })
    return granted.scope as TokenScope
  })()

  return {
    ready: () => init,
    request: async (method, params) => {
      await init // 幂等：首个请求等凭证就绪，后续直接过
      const response = await deps.fetchImpl(`${base}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
      })
      // 401/403/413 是传输层拒绝（帧不存在），直接抛给页面
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
      const frame = (await response.json()) as RpcResponse
      if (frame.error) throw new Error(frame.error.message)
      return frame.result as never
    },
    onEvent: (method, handler) => {
      const set = handlers.get(method) ?? new Set()
      set.add(handler as (params: unknown) => void)
      handlers.set(method, set)
      return () => set.delete(handler as (params: unknown) => void)
    }
  }
}
