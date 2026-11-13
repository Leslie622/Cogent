/**
 * 集成测试共享 harness（docs/计划/测试体系.md D4/D5）：tmp 四冒烟脚本
 * （tools / compaction / approval-upgrade / ps-utf8）的公共底盘 ——
 * mock SSE 帧助手 + 引擎子进程驱动（stdio JSON-RPC）+ check 断言壳。
 * 各场景流与 mock 分流逻辑留在各 test 文件（脚本本就自包含，D6：断言
 * 原样、载体换 Vitest，逻辑不动）。
 *
 * 引擎进程跑**构建产物** out/main/service.js（global-setup 守卫新鲜度）：
 * 测的是打包后的真协议链路，与单测（直读源码）分层互补。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'

// ———— 协议帧形状（引擎侧 truth，测试只读关心的字段） ————

/** 会话消息（session.messages / run.completed.messages 的断言子集） */
export interface ChatMessageLike {
  role: string
  content: string
  toolCalls?: Array<{ name: string; status: string; resultSummary?: string; diff?: string }>
  compaction?: { tokensBefore?: number; tokensAfter?: number }
  [key: string]: unknown
}

/** 事件帧 params 的断言子集（索引签名兜住未列字段） */
export interface SmokeEventParams {
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
  send<T = SmokeResult>(method: string, params?: unknown): Promise<{ result?: T; error?: { code: number; message: string } }>
  /** 等待指定事件（带谓词与水位），到点即返回该帧；超时抛错 */
  waitEvent(
    method: string,
    predicate?: (params: SmokeEventParams) => boolean,
    timeoutMs?: number
  ): Promise<EngineEventFrame>
  /** 断言窗口内零匹配事件（等满窗口再下结论） */
  assertNoEvent(method: string, predicate?: (params: SmokeEventParams) => boolean, windowMs?: number): Promise<void>
  kill(): void
}

/**
 * 拉起引擎子进程（stdio JSON-RPC）。USERPROFILE/HOME 与 COGENT_HOME 同步
 * 覆写：无绑定会话的 os.homedir() 兜底根也隔离进临时目录（tools-smoke
 * 沉淀的手法）。重启 = kill 后再 startEngine（新 handle、新 events、新 id 序）。
 */
export function startEngine(home: string): EngineHandle {
  // stdio 三元组字面量 → spawn 推断 ChildProcessByStdio<Writable, Readable, null>，
  // stdin/stdout 恒非空（engine.stderr 走 'inherit' 不用）
  const engine = spawn(process.execPath, [join(process.cwd(), 'out/main/service.js')], {
    env: { ...process.env, COGENT_HOME: home, USERPROFILE: home, HOME: home },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const events: EngineEventFrame[] = []
  const pendingResponses = new Map<number, { resolve: (frame: unknown) => void }>()
  let nextId = 1
  let buffer = ''
  engine.stdout.on('data', (data: Buffer) => {
    buffer += data.toString()
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      // 协议帧来源唯一（本机引擎 stdout 的 JSON），断言一次收窄成线格式：
      // method 有 / id 无 = 事件帧；id 有 = 响应帧（两个判别字段都可能缺席）
      const frame = JSON.parse(line) as { method?: string; id?: number; params?: SmokeEventParams }
      if (frame.method !== undefined && frame.id === undefined) {
        events.push({ method: frame.method, params: frame.params ?? {} })
      } else if (frame.id !== undefined) {
        pendingResponses.get(frame.id)?.resolve(frame)
        pendingResponses.delete(frame.id)
      }
    }
  })
  return {
    events,
    send: <T = SmokeResult>(method: string, params?: unknown) =>
      new Promise<{ result?: T; error?: { code: number; message: string } }>((resolve) => {
        const id = nextId++
        pendingResponses.set(id, {
          // 响应帧来源唯一（本机引擎 stdout 的 JSON），断言一次收窄
          resolve: (frame) => resolve(frame as { result?: T; error?: { code: number; message: string } })
        })
        engine.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      }),
    waitEvent: (method, predicate = () => true, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待事件超时: ${method}`)), timeoutMs)
        const poll = (): void => {
          const hit = events.find((e) => e.method === method && predicate(e.params) && !e.__consumed)
          if (hit !== undefined) {
            hit.__consumed = true
            clearTimeout(timer)
            resolve(hit)
            return
          }
          setTimeout(poll, 30)
        }
        poll()
      }),
    assertNoEvent: async (method, predicate = () => true, windowMs = 1200) => {
      await new Promise((r) => setTimeout(r, windowMs))
      const hit = events.find((e) => e.method === method && predicate(e.params))
      expect(hit, `不应出现的事件到达: ${method} ${JSON.stringify(hit?.params ?? {}).slice(0, 120)}`).toBeUndefined()
    },
    kill: () => {
      engine.kill()
    }
  }
}

/**
 * 握手三连：initialize → 凭据 → 自定义 provider。重启后的引擎是内存态白纸
 * （tools-smoke 踩坑沉淀），凭据/自定义 provider 必须每代重灌。
 */
export async function initEngine(
  engine: EngineHandle,
  opts: { client: string; port: number; providers: unknown[] }
): Promise<void> {
  const init = await engine.send<{ service: string }>('initialize', { client: opts.client, protocolVersion: 1 })
  if (init.result?.service !== 'cogent-agent') throw new Error('握手失败')
  await engine.send('credentials.set', { providerId: 'custom/mock', apiKey: 'sk-mock' })
  await engine.send('providers.custom.sync', {
    providers: opts.providers,
    overrides: []
  })
}

// ———— 断言壳：冒烟的 check(label, ok, detail) 原样语义 ————

/**
 * label 进 expect 的 message：失败输出直接对上原冒烟编号（开发.md 配方
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
  rmSync(dir, { recursive: true, force: true })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
