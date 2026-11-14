/**
 * HTTP 门（阶段 2a，全局架构 D2）：POST /rpc 收 JSON-RPC 帧文本，回响应帧。
 *
 * 架构位置：传输层薄壳 —— 只做"帧进帧出"，零业务逻辑。方法注册表在
 * host-main（handlers Map），本模块经 FrameHandler 回调复用同一份，
 * 保证 stdio 与 HTTP 两个门走完全相同的解析/守卫/分发路径（注册表单一）。
 *
 * 信任边界（约定.md §1.1「外部世界」行）：HTTP 请求体是不可信输入 ——
 * 畸形帧由 handleFrame 统一转错误帧（与 stdio 同一守卫），本层只加
 * 传输层自己的守卫：单帧体积上限（防本机恶意进程用大 body 占内存）。
 *
 * 监听地址写死 127.0.0.1（fail-closed，D2）：非 loopback 监听 = 远程模式，
 * 是 2c 的显式决策 + 鉴权前提，这里物理排除 —— 配置失误不可能把引擎
 * 暴露到网络上。鉴权（scoped token，D3）在 2b 落地，2a 骨架期依赖
 * loopback 语义（本机内其他进程可连，这是 curl 冒烟的口子）。
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { RpcResponse } from '../../protocol'

/**
 * 单帧处理入口 = host-main 的 handleFrame（dispatch 同款）。
 * 返回 null 表示"这不是请求帧"（事件帧/畸形帧，stdio 侧丢弃 + stderr 诊断），
 * HTTP 无法静默丢弃，由本层转 400。
 */
export type FrameHandler = (raw: string) => Promise<RpcResponse | null>

/** 单帧体积上限：协议里最大方法（会话消息/转录）远小于此值 */
const MAX_BODY_BYTES = 1_000_000

export interface HttpRpcServer {
  /** 实际监听端口（传入 0 = 随机分配时的真实值，冒烟脚本从 stderr 日志读） */
  port: number
  close(): Promise<void>
}

/**
 * 启动 HTTP 门。options.port 省略/为 0 = 随机端口（同时只跑一个消费者时
 * 零冲突；固定端口到 main 集成批次再决定是否需要）。
 */
export function startHttpRpc(
  handleFrame: FrameHandler,
  options?: { port?: number }
): Promise<HttpRpcServer> {
  const app = new Hono()
  app.post('/rpc', async (c) => {
    const declared = Number(c.req.header('content-length'))
    if (declared > MAX_BODY_BYTES) {
      return c.json({ error: `frame exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    }
    const response = await handleFrame(await c.req.text())
    // null = 非请求帧：stdio 侧是丢弃，HTTP 必须回话，用 400 区分传输层拒绝
    if (response === null) return c.json({ error: 'not a request frame' }, 400)
    // 恒 200：JSON-RPC 错误（parse error / method not found / 业务异常）是
    // 应用层语义，住在帧的 error 字段里 —— HTTP 状态码只表达传输层成败
    return c.json(response, 200)
  })

  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: options?.port ?? 0, hostname: '127.0.0.1' },
      (info) => {
        resolve({
          port: info.port,
          close: () => new Promise((res) => server.close(() => res()))
        })
      }
    )
  })
}
