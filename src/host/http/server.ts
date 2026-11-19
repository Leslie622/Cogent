/**
 * HTTP 门（2a 骨架 / 2b 鉴权 / 2c WS + 远程模式）：
 * - POST /rpc：JSON-RPC 帧文本进、响应帧出（curl/脚本）；
 * - POST /auth/exchange：一次性票据换长期 token；
 * - GET /ws（upgrade）：双向帧 —— 上行请求帧走同一 handleFrame，下行事件
 *   帧经 broadcastEvent 推送（消费者只保持一条 WS，D2「WS 为主」）。
 *
 * 架构位置：传输层薄壳 —— 方法注册表在 host-main（handlers Map），三个门
 * 共调同一 handleFrame；档位强制（scopeAllows）也是 /rpc 与 /ws 共用一份，
 * 保证守卫与分发路径唯一（换门不换规则）。
 *
 * WS 实现：ws 包官方 noServer 模式（server.on('upgrade') + handleUpgrade）。
 * zcode 用 @hono/node-ws，但其 peer 锁 @hono/node-server@^1（我们是 2.x）；
 * 本项目 WS 端点只有一个、不需要 Hono 路由集成，标准 upgrade 路径更直接。
 * 鉴权与 HTTP 同口径：verifyToken 同一函数；浏览器 WebSocket 不能自定义
 * Authorization 头（MDN WebSockets API），query token 是标准 workaround。
 *
 * 信任边界（约定.md §1.1「外部世界」行）：请求体与 token 都是不可信输入 ——
 * 畸形帧由 handleFrame 统一转错误帧；token 验签恒时比较（auth.ts）；本层
 * 只加传输层守卫：单帧体积上限。
 *
 * 监听地址默认 127.0.0.1（fail-closed）；远程模式 = 调用方显式传 hostname
 * （host-main 经 COGENT_HTTP_HOST env），恒鉴权仍在 —— zcode 非 loopback
 * throw 的前提是它有匿名档，Cogent 无匿名档，显式配置即显式决策。
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { RpcEvent, RpcResponse, TokenScope } from '../../protocol'
import { SCOPE_RANK, signToken, verifyToken, type CapabilityStore } from './auth'

/** ws 文本帧的 data 侧（node ws 默认不分片、非 binary，恒为 Buffer） */
const frameText = (data: RawData): string => (data as Buffer).toString('utf8')

/**
 * 单帧处理入口 = host-main 的 handleFrame（dispatch 同款）。
 * 返回 null 表示"这不是请求帧"（事件帧/畸形帧，stdio 侧丢弃 + stderr 诊断），
 * HTTP 无法静默丢弃，由本层转 400。
 */
export type FrameHandler = (raw: string) => Promise<RpcResponse | null>

/** 单帧体积上限：协议里最大方法（会话消息/转录）远小于此值 */
const MAX_BODY_BYTES = 1_000_000

/** WS 关闭排空窗口（zcode server-core 同款语义：先 close(1001) 再 terminate 兜底） */
const WS_DRAIN_MS = 250

/** 越档错误的 JSON-RPC code：server-error 区间（-32000~-32099）内自选 */
const SCOPE_FORBIDDEN_CODE = -32_003

/**
 * 方法档位表（D3 三档）：调用该方法所需的最低 scope。
 * 查不到的方法名不在此拦截 —— 放行后由 handleFrame 回 MethodNotFound 帧。
 */
const METHOD_MIN_SCOPE: Record<string, TokenScope> = {
  // 读类
  initialize: 'readonly',
  'session.list': 'readonly',
  'session.messages': 'readonly',
  'session.listArchived': 'readonly',
  'project.list': 'readonly',
  'credentials.list': 'readonly',
  'models.list': 'readonly',
  'inspect.entries': 'readonly',
  'inspect.entry': 'readonly',
  'mcp.list': 'readonly',
  'skills.list': 'readonly',
  'skills.read': 'readonly',
  // 写类（会话/项目变更、提交与裁决、凭据写、provider 同步）
  'session.create': 'write',
  'session.delete': 'write',
  'session.setPinned': 'write',
  'session.rename': 'write',
  'session.archive': 'write',
  'session.setPermission': 'write',
  'session.setPlanMode': 'write',
  'session.compact': 'write',
  'session.continue': 'write',
  'project.create': 'write',
  'project.rename': 'write',
  'project.update': 'write',
  'project.delete': 'write',
  'project.setPinned': 'write',
  'agent.submit': 'write',
  'agent.abort': 'write',
  'approval.respond': 'write',
  // 交互座 4c-2：回答挂起中的 ask_user —— 同 approval.respond 的"宿主侧
  // 人机裁决回流"语义面，同 write 档
  'question.respond': 'write',
  // 交互座 4c-3：裁决方案审批（批准 = 关计划开关）；同 write 档
  'plan.respond': 'write',
  'credentials.set': 'write',
  'credentials.remove': 'write',
  'providers.custom.sync': 'write',
  // MCP server 定义 = 未来会话可拉起的本地进程/外联端点，敏感面与自定义
  // provider 同级（stdio server 是进程执行面，但工具调用仍过审批链，write 档足够）
  'mcp.sync': 'write',
  // 项目级 override（enabled/exposure）只会收敛，不能扩权 —— 同 write 档
  'mcp.override': 'write',
  // 技能写路径：save/delete 直接落用户磁盘文件（SKILL.md + 状态 JSON），
  // 是提示词注入面（进系统提示）—— 与 mcp.sync 同 write 档；setEnabled
  // 只动状态文件，同档不细分
  'skills.save': 'write',
  'skills.delete': 'write',
  'skills.setEnabled': 'write',
  // 签发入口：只有 admin（或 stdio 血缘，不走此表）能再签票据 —— 防
  // readonly/write 持有者经任意传输门自签提权
  'capability.issue': 'admin'
}

/** 档位判定（/rpc 与 /ws 共用）：method 非字符串或不在表内 = 放行交 handleFrame */
function scopeAllows(scope: TokenScope, method: unknown): boolean {
  // 桌面路径/分片/预览/草稿只属于壳；admin 也不能从远程取得本机文件入口。
  if (typeof method === 'string' && method.startsWith('attachments.')) return false
  if (typeof method !== 'string' || !(method in METHOD_MIN_SCOPE)) return true
  return SCOPE_RANK[scope] >= SCOPE_RANK[METHOD_MIN_SCOPE[method]]
}

export interface HttpRpcOptions {
  /** 省略/0 = 随机端口；实际值经返回值与 stderr 日志上报 */
  port?: number
  /** 监听地址；缺省 127.0.0.1（fail-closed）。远程模式由调用方显式传入 */
  hostname?: string
  /** 长期 token 的 HMAC 材料（auth.ts createRootSecret；不出 Host 进程） */
  rootSecret: string
  /** 一次性票据 store（auth.ts createCapabilityStore） */
  store: CapabilityStore
}

export interface HttpRpcServer {
  /** 实际监听端口（传入 0 = 随机分配时的真实值，冒烟脚本从 stderr 日志读） */
  port: number
  /** 事件广播：把 RpcEvent 帧推给所有在线 WS 连接（属性式签名，允许解构直传 notify） */
  broadcastEvent: (frame: RpcEvent) => void
  close(): Promise<void>
}

/** 启动 HTTP 门。 */
export function startHttpRpc(handleFrame: FrameHandler, options: HttpRpcOptions): Promise<HttpRpcServer> {
  // Variables 泛型：鉴权中间件写入、/rpc handler 读取的请求级 scope
  const app = new Hono<{ Variables: { scope: TokenScope } }>()

  // CORS 全放行：消费者是 webview/浏览器页（origin 与 127.0.0.1 永远不同源，
  // 无 CORS 头浏览器直接拦 —— Pi-meme 用同源反代绕开，Cogent 页面直连就必须
  // 回头）。安全性不受影响：CORS 只是浏览器同源策略的形式，真边界是恒鉴权
  // token —— 恶意网页能发请求但无 token 一律 401（票据也拿不到）。
  app.use('*', cors())

  // /auth/exchange 的凭证就是票据本身，不走 Bearer（否则鸡生蛋）；WS 握手是
  // 原生 HTTP upgrade、不经 Hono fetch，鉴权在 upgrade 事件里同口径另挂
  app.use('*', async (c, next) => {
    if (c.req.path === '/auth/exchange') return next()
    const authorization = c.req.header('authorization')
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined
    const query = new URL(c.req.url).searchParams.get('token')?.trim()
    const scope = verifyToken(options.rootSecret, bearer || query)
    if (!scope) return c.json({ error: 'authentication required' }, 401)
    c.set('scope', scope)
    return next()
  })

  app.post('/auth/exchange', async (c) => {
    // 信任边界：body 是外部输入，在此做唯一一次形状校验
    const body = await c.req.json<unknown>().catch(() => null)
    const ticket = (body as { ticket?: unknown } | null)?.ticket
    const scope = options.store.consume(typeof ticket === 'string' ? ticket : undefined)
    if (!scope) return c.json({ error: 'invalid or expired ticket' }, 401)
    return c.json({ token: signToken(options.rootSecret, scope), scope }, 200)
  })

  app.post('/rpc', async (c) => {
    const declared = Number(c.req.header('content-length'))
    if (declared > MAX_BODY_BYTES) {
      return c.json({ error: `frame exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    }
    const raw = await c.req.text()
    let method: unknown
    try {
      method = (JSON.parse(raw) as { method?: unknown }).method
    } catch {
      method = undefined // 畸形 JSON 放行给 handleFrame，回 ParseError 帧
    }
    if (!scopeAllows(c.get('scope'), method)) {
      return c.json({ error: `method ${String(method)} requires ${METHOD_MIN_SCOPE[String(method)]} scope` }, 403)
    }
    const response = await handleFrame(raw)
    // null = 非请求帧：stdio 侧是丢弃，HTTP 必须回话，用 400 区分传输层拒绝
    if (response === null) return c.json({ error: 'not a request frame' }, 400)
    // 恒 200：JSON-RPC 错误（parse error / method not found / 业务异常）是
    // 应用层语义，住在帧的 error 字段里 —— HTTP 状态码只表达传输层成败
    return c.json(response, 200)
  })

  // ———— WS 门：ws 官方 noServer 模式，单端点不走 Hono 路由 ————
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()

  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: options.port ?? 0, hostname: options.hostname ?? '127.0.0.1' },
      (info) => {
        resolve({
          port: info.port,
          broadcastEvent: (frame) => {
            const line = JSON.stringify(frame)
            for (const client of clients) {
              if (client.readyState === WebSocket.OPEN) client.send(line)
            }
          },
          close: async () => {
            // HTTP server.close() 不会收敛已 upgrade 的 WS（zcode 同款坑）：
            // 先 close(1001) 给正常客户端排空窗口，再 terminate 兜底
            for (const client of clients) client.close(1001, 'server shutting down')
            await new Promise<void>((r) => setTimeout(r, WS_DRAIN_MS))
            for (const client of clients) client.terminate()
            await new Promise<void>((res) => server.close(() => res()))
          }
        })
      }
    )
    // ServerType 是 http/https 联合，on('upgrade') 重载解析不出参数类型 ——
    // 按 node:http 文档签名显式注参（upgrade 事件三参形状固定）
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      // 鉴权同口径（D2）：与 HTTP 中间件同一 verifyToken；query token 是
      // 浏览器 WS 的标准传递位（MDN：WebSocket 构造器无自定义头能力）
      const scope = verifyToken(options.rootSecret, url.searchParams.get('token')?.trim())
      if (!scope) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        clients.add(ws)
        ws.on('message', (data) => {
          const raw = frameText(data)
          let method: unknown
          let id: unknown = null
          try {
            const parsed = JSON.parse(raw) as { method?: unknown; id?: unknown }
            method = parsed.method
            id = parsed.id ?? null
          } catch {
            method = undefined // 畸形帧放行给 handleFrame，回 ParseError 帧
          }
          // 档位强制与 /rpc 同一份判定；WS 无 HTTP 状态码，越档回
          // JSON-RPC server-error 帧（-32003）
          if (!scopeAllows(scope, method)) {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: {
                  code: SCOPE_FORBIDDEN_CODE,
                  message: `method ${String(method)} requires ${METHOD_MIN_SCOPE[String(method)]} scope`
                }
              })
            )
            return
          }
          void handleFrame(raw).then((response) => {
            if (response) ws.send(JSON.stringify(response))
          })
        })
        // error 后 ws 必发 close，双挂 delete 幂等（防御边界外的清理动作）
        ws.on('close', () => clients.delete(ws))
        ws.on('error', () => clients.delete(ws))
      })
    })
  })
}
