/**
 * 集成测试共享 harness（docs/模块/测试.md）：四冒烟脚本
 * （tools / compaction / approval-upgrade / ps-utf8）的公共底盘 ——
 * mock SSE 帧助手 + 引擎子进程驱动（stdio JSON-RPC）+ check 断言壳。
 * 各场景流与 mock 分流逻辑留在各 test 文件（脚本本就自包含，D6：断言
 * 原样、载体换 Vitest，逻辑不动）。
 *
 * 引擎进程跑**构建产物** out/main/host.js（global-setup 守卫新鲜度）：
 * 测的是打包后的真协议链路，与单测（直读源码）分层互补。
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { expect } from 'vitest'
import { bundledNodeBin, resolveEngineNodeBin } from '../../src/electron/main/host/runtime'
import type { FileContext, FileReference } from '../../src/shared/files'
import type { MessageSource } from '../../src/shared/session-search'

// ———— 协议帧形状（引擎侧 truth，测试只读关心的字段） ————

/** 会话消息（session.messages / run.completed.messages 的断言子集） */
export interface ChatMessageLike {
  turnId?: string
  sources?: MessageSource[]
  fileContext?: FileContext
  role: string
  content: string
  toolCalls?: Array<{ name: string; status: string; resultSummary?: string; diff?: string; fileRefs?: FileReference[] }>
  compaction?: { tokensBefore?: number; tokensAfter?: number }
  [key: string]: unknown
}

/** 事件帧 params 的断言子集（索引签名兜住未列字段） */
export interface SmokeEventParams {
  fileRefs?: FileReference[]
  sessionId?: string
  callId?: string
  requestId?: string
  toolName?: string
  kind?: string
  summary?: string
  text?: string
  reason?: string
  error?: string
  isError?: boolean
  diff?: string
  stopReason?: string
  tokensBefore?: number
  tokensAfter?: number
  summarizedUntil?: number
  messages?: ChatMessageLike[]
  message?: ChatMessageLike
  entries?: Array<{ toolCallId: string; originalChars: number; prunedChars: number }>
  summaryUsage?: { input?: number; totalTokens?: number }
  [key: string]: unknown
}

/** 引擎事件帧（method 有、id 无） */
export interface EngineEventFrame {
  method: string
  params: SmokeEventParams
  /** waitEvent 水位标记（压缩与 run 事件交错，防秒配上一轮） */
  __consumed?: boolean
}

/** send() 的通用结果形状（各方法关心的字段子集） */
export interface SmokeResult {
  id?: string
  service?: string
  ok?: boolean
  tokensBefore?: number
  tokensAfter?: number
  messages?: ChatMessageLike[]
  [key: string]: unknown
}

// ———— SSE 帧助手（OpenAI chat.completions 流式形状） ————

export const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

export const chunk = (
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  extra: Record<string, unknown> = {}
): object => ({
  id: 'mock',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'mock',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...extra
})

// ———— 引擎驱动 ————

export interface EngineHandle {
  /** 事件流（重启 = 新 handle 新数组；__consumed 是 waitEvent 水位） */
  events: EngineEventFrame[]
  /** stderr 按行收集（诊断透传之外的可查询副本，如 HTTP 门监听行） */
  stderrLines: string[]
  send<T = SmokeResult>(method: string, params?: unknown, timeoutMs?: number): Promise<RpcResponse<T>>
  /** 等待指定事件（带谓词与水位），到点即返回该帧；超时抛错 */
  waitEvent(
    method: string,
    predicate?: (params: SmokeEventParams) => boolean,
    timeoutMs?: number
  ): Promise<EngineEventFrame>
  /** 断言窗口内零匹配事件（等满窗口再下结论） */
  assertNoEvent(method: string, predicate?: (params: SmokeEventParams) => boolean, windowMs?: number): Promise<void>
  stop(): Promise<void>
}

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } }

interface PendingResponse {
  resolve: (frame: unknown) => void
  reject: (error: Error) => void
}

interface EventWaiter {
  match: () => void
  reject: (error: Error) => void
}

/**
 * 拉起引擎子进程（stdio JSON-RPC）。USERPROFILE/HOME 与 COGENT_HOME 同步
 * 覆写：无绑定会话的 os.homedir() 兜底根也隔离进临时目录。
 * extraEnv：测试专用注入（如 COGENT_HTTP_RPC），置于隔离根覆写之前 ——
 * 隔离根不可被注入覆盖。
 */
export function startEngine(home: string, extraEnv: Record<string, string> = {}): EngineHandle {
  return connectEngine(spawn(testEngineNode(), [join(process.cwd(), 'out/main/host.js')], {
    env: {
      ...process.env,
      COGENT_HTTP_RPC: '0',
      COGENT_HTTP_HOST: '127.0.0.1',
      COGENT_HTTP_PORT: '0',
      ...extraEnv,
      COGENT_HOME: home,
      USERPROFILE: home,
      HOME: home,
      // 集成场景按需共享 pi 下载的 fd/rg，凭据和会话不经过这个目录。
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? join(tmpdir(), 'cogent-test-pi-domain')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  }))
}

export function testEngineNode(): string {
  // 引擎 Node 对齐生产三级链（electron/main/host/runtime.ts）：COGENT_NODE_BIN →
  // 自带 runtime node（≥22.19，pi engines 门槛）→ process.execPath 兜底。
  // 不能恒用 execPath：开发机系统 node 可能低于 22.19（实测 22.14 无 zlib
  // zstd，pi 嵌套 undici 8.x 模块初始化即 TypeError，引擎起不来）
  const bundled = bundledNodeBin(join(process.cwd(), 'resources'), process.platform, process.arch)
  return resolveEngineNodeBin(
    process.env,
    bundled !== null && existsSync(bundled) ? bundled : null,
    process.execPath
  )
}

/** 标准流以行分帧，独立于 Windows 和 Unix 的子进程退出信号。 */
export function connectEngine(engine: ChildProcessByStdio<Writable, Readable, Readable>): EngineHandle {
  const events: EngineEventFrame[] = []
  const stderrLines: string[] = []
  const pendingResponses = new Map<number, PendingResponse>()
  const eventWaiters = new Set<EventWaiter>()
  let stopped: Promise<void> | undefined
  let failure: Error | undefined
  const fail = (reason: string, cause?: unknown): void => {
    if (failure !== undefined) return
    const diagnostics = stderrLines.slice(-8).join('\n')
    failure = new Error(diagnostics ? `${reason}\n${diagnostics}` : reason, { cause })
    for (const pending of pendingResponses.values()) pending.reject(failure)
    for (const waiter of eventWaiters) waiter.reject(failure)
  }
  const closed = new Promise<void>((resolve) => {
    engine.once('close', (code, signal) => {
      fail(`Host 子进程已关闭（${signal ?? code}）`)
      resolve()
    })
  })
  engine.on('error', (error) => fail(`Host 子进程错误: ${error.message}`, error))
  engine.stdin.on('error', (error) => fail(`Host stdin 错误: ${error.message}`, error))
  engine.stdout.on('error', (error) => fail(`Host stdout 错误: ${error.message}`, error))
  engine.stderr.on('error', (error) => fail(`Host stderr 错误: ${error.message}`, error))

  const recordStderr = (line: string): void => {
    if (!line) return
    stderrLines.push(line)
    process.stderr.write(`[engine] ${line}\n`)
  }
  let stderrBuffer = ''
  engine.stderr.setEncoding('utf8').on('data', (data: string) => {
    stderrBuffer += data
    let nl: number
    while ((nl = stderrBuffer.indexOf('\n')) >= 0) {
      const line = stderrBuffer.slice(0, nl).trimEnd()
      stderrBuffer = stderrBuffer.slice(nl + 1)
      recordStderr(line)
    }
  })
  engine.stderr.on('end', () => recordStderr(stderrBuffer.trimEnd()))
  let nextId = 1
  let buffer = ''
  engine.stdout.setEncoding('utf8').on('data', (data: string) => {
    if (failure !== undefined) return
    buffer += data
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      // 协议帧来源唯一（本机引擎 stdout 的 JSON），断言一次收窄成线格式：
      // method 有 / id 无 = 事件帧；id 有 = 响应帧（两个判别字段都可能缺席）
      let frame: { method?: string; id?: number; params?: SmokeEventParams }
      try {
        const parsed: unknown = JSON.parse(line)
        if (parsed === null || typeof parsed !== 'object') throw new Error('JSON-RPC 帧应为对象')
        frame = parsed
      } catch (error) {
        fail(`Host stdout 帧无效: ${line.slice(0, 200)}`, error)
        return
      }
      if (frame.method !== undefined && frame.id === undefined) {
        events.push({ method: frame.method, params: frame.params ?? {} })
        for (const waiter of eventWaiters) waiter.match()
      } else if (frame.id !== undefined) {
        pendingResponses.get(frame.id)?.resolve(frame)
      }
    }
  })
  return {
    events,
    stderrLines,
    send: <T = SmokeResult>(method: string, params?: unknown, timeoutMs = 30_000) =>
      new Promise<RpcResponse<T>>((resolve, reject) => {
        if (failure !== undefined) { reject(failure); return }
        if (stopped !== undefined) { reject(new Error('Host 正在关闭')); return }
        const id = nextId++
        const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
        const cleanup = (): void => {
          clearTimeout(timer)
          pendingResponses.delete(id)
        }
        const onError = (error: Error): void => { cleanup(); reject(error) }
        const timer = setTimeout(() => onError(new Error(`等待 RPC 超时: ${method}（id=${id}）`)), timeoutMs)
        pendingResponses.set(id, {
          resolve: (frame) => { cleanup(); resolve(frame as RpcResponse<T>) },
          reject: onError
        })
        engine.stdin.write(line, (error) => {
          if (error) onError(new Error(`发送 RPC 失败: ${method}`, { cause: error }))
        })
      }),
    waitEvent: (method, predicate = () => true, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const cleanup = (): void => { clearTimeout(timer); eventWaiters.delete(waiter) }
        const waiter: EventWaiter = {
          match: () => {
            try {
              const hit = events.find((e) => !e.__consumed && e.method === method && predicate(e.params))
              if (hit === undefined) return
              hit.__consumed = true
              cleanup()
              resolve(hit)
            } catch (error) {
              cleanup()
              reject(error instanceof Error ? error : new Error('事件匹配失败', { cause: error }))
            }
          },
          reject: (error) => { cleanup(); reject(error) }
        }
        const timer = setTimeout(() => {
          const lastFailure = events.findLast((e) => e.method === 'run.failed')
          waiter.reject(
            new Error(
              `等待事件超时: ${method}（尾部事件: ${events.slice(-8).map((e) => e.method).join(' → ') || '无'}` +
                (lastFailure !== undefined ? `；最近 run.failed: ${JSON.stringify(lastFailure.params).slice(0, 160)}` : '') +
                '）'
            )
          )
        }, timeoutMs)
        if (failure !== undefined) { waiter.reject(failure); return }
        eventWaiters.add(waiter)
        waiter.match()
      }),
    assertNoEvent: async (method, predicate = () => true, windowMs = 1200) => {
      await new Promise((r) => setTimeout(r, windowMs))
      const hit = events.find((e) => e.method === method && predicate(e.params))
      expect(hit, `不应出现的事件到达: ${method} ${JSON.stringify(hit?.params ?? {}).slice(0, 120)}`).toBeUndefined()
    },
    stop: () => stopped ??= (async () => {
      if (engine.exitCode !== null || engine.signalCode !== null) { await closed; return }
      // 等标准流关闭再删目录或用同一数据根启动下一个 Host。
      const force = setTimeout(() => engine.kill('SIGKILL'), 3_000)
      engine.stdin.end()
      try { await closed } finally { clearTimeout(force) }
    })()
  }
}

/**
 * 握手三连：initialize → 凭据 → 自定义 provider。重启后的引擎是内存态白纸
 * （tools-smoke 踩坑沉淀），凭据/自定义 provider 必须每代重灌。
 */
export async function initEngine(
  engine: EngineHandle,
  opts: { client: string; providers: unknown[] }
): Promise<{ service: string; httpPort?: number }> {
  const init = await engine.send<{ service: string; httpPort?: number }>('initialize', { client: opts.client, protocolVersion: 1 })
  if (init.result?.service !== 'cogent-agent') throw new Error('握手失败')
  // 场景流只编排主 Agent 请求；独立标题另有专册验证默认开启，不能消耗工具脚本的首帧。
  const titles = await engine.send('session.titleSettings.set', { enabled: false })
  if (titles.error !== undefined) throw new Error(titles.error.message)
  const credentials = await engine.send('credentials.set', { providerId: 'custom/mock', apiKey: 'sk-mock' })
  if (credentials.error !== undefined) throw new Error(credentials.error.message)
  const providers = await engine.send('providers.custom.sync', {
    providers: opts.providers,
    overrides: []
  })
  if (providers.error !== undefined) throw new Error(providers.error.message)
  return init.result
}

/** 让系统为实际监听的 socket 分配端口，避免预占后释放的竞争窗口。 */
export async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试 HTTP 服务没有 TCP 监听地址')
  return address.port
}

/** 测试结束后连同尚未消费完的模拟 SSE/HTTP 连接一起关闭。 */
export async function closeLoopback(server: Server | undefined): Promise<void> {
  if (server?.listening !== true) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}

// ———— 断言壳：冒烟的 check(label, ok, detail) 原样语义 ————

/**
 * label 进 expect 的 message：失败输出直接对上既有冒烟编号（配方
 * 时代的编号沿用），detail 原样附尾。
 */
export function check(label: string, ok: unknown, detail = ''): void {
  expect(ok, detail === '' ? label : `${label} —— ${detail}`).toBe(true)
}

// ———— 临时目录 ————

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeDir(dir: string): void {
  // Windows 句柄延迟释放重试（2026-11-16 实测：engine.kill() 后立刻删 ws 目录
  // 稳定 EBUSY —— TerminateProcess 返回≠句柄回收完成，杀毒/索引服务也可能
  // 瞬时握住 Temp 目录；10:13 起复现，与具体改动无关）。外部世界边界（约定.md
  // 1.1），重试退避是标准防御；重试耗尽仍失败才让错误浮出
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 10 || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
