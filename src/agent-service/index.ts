/**
 * Agent 服务 —— 独立 Node 进程入口，Cogent 的"引擎"。
 *
 * 为什么是独立进程（决策见 docs/架构.md）：
 * - pi 要求 Node >= 22.19 且 ESM-only，Electron 22 等旧宿主无法进程内集成；
 * - 工具执行（shell / 文件写入）需要崩溃隔离：引擎挂了不拖垮宿主；
 * - abort 可以硬杀到进程级。
 *
 * 纪律（目录即边界）：
 * - 只允许依赖 pi-* 与 ../protocol，禁止 import Electron / renderer 代码；
 * - 无头运行：stdin 进请求，stdout 出响应/事件，stderr 只出诊断日志；
 * - 它不知道"窗口"的存在，任何 Node 宿主都能拉起它。
 *
 * 防御边界（本项目防御政策的示范位）：stdin 是本进程唯一的不可信输入，
 * 校验只发生在 dispatch 入口（JSON 解析 + isRpcRequest + 参数显式收窄）；
 * handler 内部信任协议类型，不做二次防御。
 */
import { createInterface } from 'node:readline'
import {
  PROTOCOL_VERSION,
  ProtocolError,
  RpcErrorCode,
  isRpcEvent,
  isRpcRequest,
  toRpcError,
  type InitializeParams,
  type InitializeResult,
  type ProtocolEvents,
  type RpcEvent,
  type RpcResponse
} from '../protocol'

/** 事件发送：service → 宿主（notification 帧） */
function notify<E extends keyof ProtocolEvents>(method: E, params: ProtocolEvents[E]): void {
  const frame: RpcEvent = { jsonrpc: '2.0', method, params }
  process.stdout.write(JSON.stringify(frame) + '\n')
}

/** 响应发送 */
function reply(response: RpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n')
}

/** 握手：宿主确认链路可用，服务上报运行时信息（宿主据此做 Node 版本守卫）。 */
function handleInitialize(params: unknown): InitializeResult {
  // 信任边界：params 是外部输入，在此做唯一一次显式校验。
  const p = params as Partial<InitializeParams>
  if (typeof p.client !== 'string' || typeof p.protocolVersion !== 'number') {
    throw new ProtocolError(
      RpcErrorCode.InvalidParams,
      'initialize 需要 { client: string, protocolVersion: number }'
    )
  }
  return { service: 'cogent-agent', protocolVersion: PROTOCOL_VERSION, node: process.version }
}

/**
 * 方法注册表：method 名 → handler。
 * handler 内部信任协议类型（边界校验已在入口完成），业务异常直接 throw，
 * 由 dispatch 统一转成错误帧 —— 不要在 handler 里自行 try/catch。
 *
 * 实现顺序 TODO：
 * 1. session.list / session.create（storage 落地）
 * 2. agent.submit / agent.abort（pi Agent 接入 + 事件转译）
 * 3. approval.respond（工具审批拦截点）
 */
const handlers = new Map<string, (params: unknown) => unknown>([
  ['initialize', handleInitialize]
])

/** 单帧处理：请求 → 响应；事件/畸形帧按协议丢弃并记诊断日志。 */
async function dispatch(raw: string): Promise<void> {
  let frame: unknown
  try {
    frame = JSON.parse(raw)
  } catch {
    // 信任边界：宿主发来的行不是合法 JSON（旧版本客户端 / 实现错误）
    reply({ jsonrpc: '2.0', id: null, error: { code: RpcErrorCode.ParseError, message: 'invalid JSON frame' } })
    return
  }

  if (isRpcEvent(frame)) {
    // 当前协议里 宿主→服务 方向只有请求；收到事件帧说明对方实现越界。
    process.stderr.write(`[agent-service] dropped unexpected event frame: ${frame.method}\n`)
    return
  }
  if (!isRpcRequest(frame)) {
    process.stderr.write(`[agent-service] dropped malformed frame: ${raw.slice(0, 120)}\n`)
    return
  }

  const handler = handlers.get(frame.method)
  if (!handler) {
    reply({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: RpcErrorCode.MethodNotFound, message: `unknown method: ${frame.method}` }
    })
    return
  }

  try {
    reply({ jsonrpc: '2.0', id: frame.id, result: await handler(frame.params ?? {}) })
  } catch (error) {
    reply({ jsonrpc: '2.0', id: frame.id, error: toRpcError(error) })
  }
}

// ———— 主循环：一行一帧 ————

const stdin = createInterface({ input: process.stdin })
stdin.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed) void dispatch(trimmed)
})
// 宿主关闭管道（退出/被杀）时服务随行退出，不做任何延迟收尾。
stdin.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// 冒烟自检：无需宿主，直接管道喂数据即可验证协议链路，命令见 docs/开发.md。
void notify // 骨架期尚无事件源；保留导出位，pi 接入后由 runtime 调用
