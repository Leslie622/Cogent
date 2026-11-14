/**
 * HTTP 门（阶段 2a 落骨架、2b 落鉴权 D3）：POST /rpc 收 JSON-RPC 帧文本回
 * 响应帧；POST /auth/exchange 一次性票据换长期 token。
 *
 * 架构位置：传输层薄壳 —— 方法注册表在 host-main（handlers Map），本模块经
 * FrameHandler 回调复用同一份，保证 stdio 与 HTTP 两个门走完全相同的
 * 解析/守卫/分发路径（注册表单一）。
 *
 * 鉴权（2b 起）：开门即鉴权（比 zcode「未配 token 就匿名」更紧一档 ——
 * COGENT_HTTP_RPC=1 的语义就是 scoped token 通道）。双轨取 token：
 * Authorization: Bearer 头（curl/脚本）或 ?token= query（浏览器 WebSocket
 * 不能自定义头，2c 的 WS 握手同口径复用，zcode 同款）；档位强制在 /rpc
 * handler 内做（中间件只管「是不是有效 token」，401/403 分层）。
 *
 * 信任边界（约定.md §1.1「外部世界」行）：请求体与 token 都是不可信输入 ——
 * 畸形帧由 handleFrame 统一转错误帧（与 stdio 同一守卫）；token 验签在
 * auth.ts（恒时比较）；本层只加传输层自己的守卫：单帧体积上限。
 *
 * 监听地址写死 127.0.0.1（fail-closed，D2）：非 loopback 监听 = 远程模式，
 * 是 2c 的显式决策，这里物理排除。
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { RpcResponse, TokenScope } from '../../protocol'
import { SCOPE_RANK, signToken, verifyToken, type CapabilityStore } from './auth'

/**
 * 单帧处理入口 = host-main 的 handleFrame（dispatch 同款）。
 * 返回 null 表示"这不是请求帧"（事件帧/畸形帧，stdio 侧丢弃 + stderr 诊断），
 * HTTP 无法静默丢弃，由本层转 400。
 */
export type FrameHandler = (raw: string) => Promise<RpcResponse | null>

/** 单帧体积上限：协议里最大方法（会话消息/转录）远小于此值 */
const MAX_BODY_BYTES = 1_000_000

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
  // 写类（会话/项目变更、提交与裁决、凭据写、provider 同步）
  'session.create': 'write',
  'session.delete': 'write',
  'session.setPinned': 'write',
  'session.archive': 'write',
  'session.setPermission': 'write',
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
  'credentials.set': 'write',
  'credentials.remove': 'write',
  'providers.custom.sync': 'write',
  // 签发入口：只有 admin（或 stdio 血缘，不过此表）能再签票据 —— 防
  // readonly/write 持有者经 HTTP 自签提权
  'capability.issue': 'admin'
}

export interface HttpRpcOptions {
  /** 省略/0 = 随机端口；实际值经返回值与 stderr 日志上报 */
  port?: number
  /** 长期 token 的 HMAC 材料（auth.ts createRootSecret；不出 Host 进程） */
  rootSecret: string
  /** 一次性票据 store（auth.ts createCapabilityStore） */
  store: CapabilityStore
}

export interface HttpRpcServer {
  /** 实际监听端口（传入 0 = 随机分配时的真实值，冒烟脚本从 stderr 日志读） */
  port: number
  close(): Promise<void>
}

/** 启动 HTTP 门。 */
export function startHttpRpc(handleFrame: FrameHandler, options: HttpRpcOptions): Promise<HttpRpcServer> {
  // Variables 泛型：鉴权中间件写入、/rpc handler 读取的请求级 scope
  const app = new Hono<{ Variables: { scope: TokenScope } }>()

  // /auth/exchange 的凭证就是票据本身，不走 Bearer（否则鸡生蛋）
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
    // 档位强制：中间件已保 scope 存在；方法名查表，越档 403（传输层拒绝，
    // 与帧内 -32601 等应用层错误分开）
    let method: unknown
    try {
      method = (JSON.parse(raw) as { method?: unknown }).method
    } catch {
      method = undefined // 畸形 JSON 放行给 handleFrame，回 ParseError 帧
    }
    if (typeof method === 'string' && method in METHOD_MIN_SCOPE) {
      const minScope = METHOD_MIN_SCOPE[method]
      if (SCOPE_RANK[c.get('scope')] < SCOPE_RANK[minScope]) {
        return c.json({ error: `method ${method} requires ${minScope} scope` }, 403)
      }
    }
    const response = await handleFrame(raw)
    // null = 非请求帧：stdio 侧是丢弃，HTTP 必须回话，用 400 区分传输层拒绝
    if (response === null) return c.json({ error: 'not a request frame' }, 400)
    // 恒 200：JSON-RPC 错误（parse error / method not found / 业务异常）是
    // 应用层语义，住在帧的 error 字段里 —— HTTP 状态码只表达传输层成败
    return c.json(response, 200)
  })

  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: options.port ?? 0, hostname: '127.0.0.1' },
      (info) => {
        resolve({
          port: info.port,
          close: () => new Promise((res) => server.close(() => res()))
        })
      }
    )
  })
}
