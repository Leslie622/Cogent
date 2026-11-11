/**
 * Agent 服务代理 —— main 进程接入引擎的唯一入口。
 *
 * main 在这里的角色是"壳 + 代理"：只做进程生命周期管理与字节搬运，
 * 不理解任何业务语义（业务在 agent-service）。将来换传输方式（如本地 socket）
 * 只动这个文件。
 *
 * 决策：
 * - 引擎默认跑在 Electron 自带的 Node 上（process.execPath + ELECTRON_RUN_AS_NODE=1，
 *   等价纯 Node，版本随 Electron 发版可控），不依赖用户系统 PATH 里的 node ——
 *   用户可能没装、版本不受控。要独立版本时再构建期放官方 node.exe 到 resources
 *   并让它成为 COGENT_NODE_BIN 的默认值；COGENT_NODE_BIN 始终是覆盖口（开发调试、
 *   旧 Electron 项目复用引擎时指向任意 Node ≥ 22.19，见 docs/架构.md「集成」）；
 * - Node 版本守卫借握手完成：服务在 initialize 响应里上报 process.version，
 *   无需额外 spawn 一次 `node -v`；
 * - 引擎崩溃不拖垮壳：状态置 failed、在途请求全部拒绝，UI 呈现，重启策略后续加。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  PROTOCOL_VERSION,
  isRpcEvent,
  type ProtocolMethods,
  type RpcEvent,
  type RpcRequest
} from '../../../protocol'
import type { AppStatus } from '../../../shared/ipc'

/** 引擎 Node 版本下限 = pi 的 engines 要求 */
const MIN_NODE: readonly [number, number, number] = [22, 19, 0]
/**
 * 握手超时：给足 Windows 冷启动余量（2026-11-11 验收实录：偶发启动握手
 * 超时、手动重试即好 —— 冷启动时 Defender 实时扫描 service.js 大捆绑包
 * 可拖慢 Node 起进程数秒，5s 不够；二次启动文件已热所以必成。真正的
 * 引擎崩溃重启策略按本文件头注「后续加」，此处只放宽窗口不加重试）
 */
const HANDSHAKE_TIMEOUT_MS = 15_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export interface AgentServiceOptions {
  /** 服务入口（构建产物 out/main/service.js） */
  entryPath: string
  /**
   * 握手时注入引擎的凭据（宿主持久化存储 → 引擎内存表）。
   * optional：冒烟脚本/老宿主可不带。
   */
  handshakeCredentials?: Record<string, { apiKey: string }>
}

export class AgentServiceManager {
  private opts: AgentServiceOptions
  private child: ChildProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private status: AppStatus = { state: 'stopped', nodeVersion: null, error: null }
  private manualStop = false
  private closed = true
  /** 引擎事件出口：registerIpc 时注入（main 收到事件即转发给 renderer） */
  private eventSink: ((event: RpcEvent) => void) | null = null

  constructor(options: AgentServiceOptions) {
    this.opts = options
  }

  /** 注册引擎事件出口（ipc/engine.ts 在 IPC 挂载阶段调用） */
  setEventSink(sink: (event: RpcEvent) => void): void {
    this.eventSink = sink
  }

  /** 事件出口的触发点（onLine 帧路由调用）；未注册出口时事件丢弃并记日志 */
  private emitEvent(event: RpcEvent): void {
    if (!this.eventSink) {
      console.error('[main] engine event arrived before sink registered:', event.method)
      return
    }
    this.eventSink(event)
  }

  getStatus(): AppStatus {
    return this.status
  }

  /**
   * 启动引擎并完成握手。所有启动期失败（node 不在 PATH / 版本不足 / 进程秒退 /
   * 握手超时）都收敛为这一个 Promise 的 rejection，由调用方决定如何呈现。
   */
  async start(): Promise<void> {
    if (!this.closed) return // start 是一次性语义，进行中/已启动时静默幂等
    this.manualStop = false
    this.closed = false
    this.status = { state: 'starting', nodeVersion: null, error: null }

    // 信任边界：引擎是外部进程。spawn 失败、秒退、挂起都是常态错误。
    // 默认用 Electron 自带 Node：execPath 就是本应用的 electron.exe，配上
    // ELECTRON_RUN_AS_NODE=1 后行为与纯 Node 一致（无 Chromium、无窗口 API）。
    const nodeBin = process.env.COGENT_NODE_BIN || process.execPath
    const child = spawn(nodeBin, [this.opts.entryPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    child.once('error', (error) => this.close(error.message))
    child.once('exit', (code) => {
      this.child = null
      this.close(this.manualStop ? null : `引擎进程意外退出（code ${code ?? 'unknown'}）`)
    })
    // stdio 配置为 pipe，Node 类型重载已把流标记为非空，无需断言
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    createInterface({ input: child.stderr }).on('line', (line) => {
      console.error('[agent-service]', line)
    })

    const handshake = withTimeout(
      this.request('initialize', {
        client: 'cogent-main',
        protocolVersion: PROTOCOL_VERSION,
        ...(this.opts.handshakeCredentials ? { credentials: this.opts.handshakeCredentials } : {})
      }),
      HANDSHAKE_TIMEOUT_MS,
      '引擎握手'
    )
    // 握手失败（超时/进程秒退/发回错误帧）必须收尾：杀子进程 + 拒绝在途请求 +
    // 落 failed 态。不清理的话超时路径会留下孤儿进程且 status 永卡 'starting'
    // （另一条对照路径：版本守卫失败在下方 catch 里已做同样收尾）
    let info
    try {
      info = await handshake
    } catch (error) {
      // stop() 默认落 'stopped'（正常关停语义），这里是失败路径：显式改写 failed
      // + 错误信息（与下方版本守卫失败路径的收尾姿势一致）
      this.stop()
      this.status = { state: 'failed', nodeVersion: null, error: (error as Error).message }
      throw error
    }

    try {
      ensureNodeVersion(info.node, MIN_NODE)
    } catch (error) {
      this.stop()
      this.status = { state: 'failed', nodeVersion: info.node, error: (error as Error).message }
      throw error
    }

    this.status = { state: 'running', nodeVersion: info.node, error: null }
  }

  /**
   * 类型化请求：method 名与载荷由 ProtocolMethods 约束，编译期即校验。
   * 仅握手场景需要超时（引擎可能起不来）；业务请求一律不设超时 —— LLM 循环
   * 以分钟计，超时会把慢变快错。
   */
  request<M extends keyof ProtocolMethods>(
    method: M,
    params: ProtocolMethods[M]['params']
  ): Promise<ProtocolMethods[M]['result']> {
    const stdin = this.child?.stdin
    if (!stdin) {
      // 内部不变量：未启动就发请求是编程错误，fail-fast（docs/约定.md 防御边界政策）
      throw new Error(`agent service not running (state=${this.status.state})`)
    }
    const id = this.nextId++
    const frame: RpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      stdin.write(JSON.stringify(frame) + '\n')
    })
  }

  /** 停止引擎（窗口关闭/版本守卫失败时调用）；幂等。 */
  stop(): void {
    this.manualStop = true
    this.child?.kill()
    this.child = null
    this.close(null)
  }

  /** 关停收尾：拒绝全部在途请求、落状态。幂等。 */
  private close(error: string | null): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.reject(new Error(error ? `agent service closed: ${error}` : 'agent service closed'))
    }
    this.pending.clear()
    this.status = {
      state: this.manualStop ? 'stopped' : 'failed',
      nodeVersion: this.status.nodeVersion,
      error
    }
  }

  /** 帧路由：引擎 → main 的一行 JSON。响应配对 pending，事件交 onEvent。 */
  private onLine(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      // 信任边界：跨进程的另一端可能是旧构建/其他实现，畸形帧记日志即可，不中断
      console.error('[main] agent-service sent invalid JSON line')
      return
    }

    if (isRpcEvent(frame)) {
      this.emitEvent(frame)
      return
    }

    const id = (frame as { id?: unknown }).id
    if (typeof id === 'number' && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)
      const response = frame as { error?: { message: string }; result?: unknown }
      if (response.error) pending.reject(new Error(response.error.message))
      else pending.resolve(response.result)
      return
    }
    console.error('[main] agent-service sent response with unknown id, dropped')
  }
}

/** Node 版本守卫：解析 vX.Y.Z 并与下限逐段比较（>= 语义，恰好等于下限也放行）。 */
function ensureNodeVersion(actual: string, min: readonly [number, number, number]): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(actual)
  if (!match) throw new Error(`无法解析引擎 Node 版本: ${actual}`)
  const actualTuple = [Number(match[1]), Number(match[2]), Number(match[3])]
  const satisfied = isAtLeast(actualTuple, min)
  if (!satisfied) {
    throw new Error(
      `引擎 Node 版本过低：${actual}，要求 >= ${min.join('.')}（pi 的 engines 要求）。` +
        `可通过环境变量 COGENT_NODE_BIN 指定其他 Node。`
    )
  }
}

/** 逐段版本比较：找到第一处不同即分胜负；逐段相等 = 恰好等于下限，满足 >=。 */
function isAtLeast(actual: number[], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < min.length; i++) {
    if (actual[i] !== min[i]) return actual[i] > min[i]
  }
  return true
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}
