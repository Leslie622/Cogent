/**
 * 准备期停止的源码级集成：真实 SessionManager → 产品 pi 工厂 → 已装 pi → loopback SSE。
 * 只在公开扩展注册边界加入可控钩子，HTTP/转录/终态均走产品实现，不复制运行循环。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelRuntime, type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Credential } from '@earendil-works/pi-ai'
import type { ProtocolEvents } from '../../protocol'
import { InspectStore, JsonStorageDriver } from '../storage'
import { ApprovalRegistry } from '../runtime/approvals'
import { CredentialRegistry } from '../runtime/credentials'
import { McpConfigStore } from '../runtime/mcp-config'
import { ProjectRegistry } from '../runtime/project'
import { SessionManager } from '../runtime/session'
import { SkillStore } from '../runtime/skill-store'
import { readPiTranscript } from './pi-session-factory'

const hooks = vi.hoisted(() => ({
  input: (): Promise<{ action: 'continue' | 'handled' } | undefined> => Promise.resolve(undefined),
  beforeStart: (): Promise<void> => Promise.resolve(),
  build: (): Promise<void> => Promise.resolve(),
  compactAbort: (): Promise<void> => Promise.resolve(),
  sessions: [] as AgentSession[],
  prompts: [] as Promise<void>[]
}))

vi.mock('../runtime/hook-seat', async (importOriginal) => {
  const original = await importOriginal<typeof import('../runtime/hook-seat')>()
  return {
    ...original,
    createCogentHooks: (options: Parameters<typeof original.createCogentHooks>[0]) => {
      const extension = original.createCogentHooks(options)
      const factory = typeof extension === 'function' ? extension : extension.factory
      return {
        ...(typeof extension === 'function' ? { name: 'preparation-test-hooks' } : extension),
        factory: (api: ExtensionAPI) => {
          const initialized = factory(api)
          api.on('input', () => hooks.input())
          api.on('before_agent_start', () => hooks.beforeStart())
          return initialized
        }
      }
    }
  }
})

vi.mock('./pi-session-factory', async (importOriginal) => {
  const original = await importOriginal<typeof import('./pi-session-factory')>()
  return {
    ...original,
    createPiSession: async (options: Parameters<typeof original.createPiSession>[0]) => {
      await hooks.build()
      const result = await original.createPiSession(options)
      hooks.sessions.push(result.session)
      const prompt = result.session.prompt.bind(result.session)
      result.session.prompt = (...args) => {
        const pending = prompt(...args)
        hooks.prompts.push(pending)
        return pending
      }
      const compact = result.session.compact.bind(result.session)
      const abort = result.session.abort.bind(result.session)
      let inCompaction = false
      result.session.compact = async (...args) => {
        inCompaction = true
        try { return await compact(...args) } finally { inCompaction = false }
      }
      result.session.abort = async () => {
        if (inCompaction) await hooks.compactAbort()
        await abort()
      }
      return result
    }
  }
})

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((done) => { release = done })
  return { promise, release }
}

const PROVIDER = 'custom/preparation-stop'
const MODEL = 'preparation-model'
type Terminal =
  | { method: 'run.completed'; params: ProtocolEvents['run.completed'] }
  | { method: 'run.failed'; params: ProtocolEvents['run.failed'] }

let root: string
let server: Server
let manager: SessionManager
let sessionId: string
let requests: string[]
let terminals: Terminal[]
let answer: { text: string; finish: 'stop' | 'length' }
let releases: Array<() => void>

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cogent-preparation-http-'))
  requests = []
  terminals = []
  releases = []
  hooks.sessions = []
  hooks.prompts = []
  hooks.input = () => Promise.resolve(undefined)
  hooks.beforeStart = () => Promise.resolve()
  hooks.build = () => Promise.resolve()
  hooks.compactAbort = () => Promise.resolve()
  answer = { text: '完整回答', finish: 'stop' }
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (part: Buffer) => { body += part.toString() })
    request.on('end', () => {
      requests.push(body)
      const frame = (delta: object, finish: string | null) => ({
        id: 'preparation-test', object: 'chat.completion.chunk', created: 0, model: MODEL,
        choices: [{ index: 0, delta, finish_reason: finish }]
      })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(frame({ role: 'assistant', content: answer.text }, null))}\n\n`)
      // length必须实报用满模型输出上限；极低用量的length会被pi当可恢复异常先撤销。
      const outputTokens = answer.finish === 'length' ? 4_096 : 2
      response.write(`data: ${JSON.stringify({ ...frame({}, answer.finish), usage: {
        prompt_tokens: 10, completion_tokens: outputTokens, total_tokens: 10 + outputTokens
      } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const storedCredentials = new Map<string, Credential>([[PROVIDER, { type: 'api_key', key: 'preparation-test-key' }]])
  const runtime = await ModelRuntime.create({
    modelsPath: null, modelsStorePath: join(root, 'models-cache.json'), refreshOnCreate: false,
    credentials: {
      read: (id) => Promise.resolve(storedCredentials.get(id)),
      list: () => Promise.resolve([...storedCredentials].map(([providerId, credential]) => ({ providerId, type: credential.type }))),
      modify: async (id, update) => {
        const value = await update(storedCredentials.get(id))
        if (value === undefined) storedCredentials.delete(id)
        else storedCredentials.set(id, value)
        return value
      },
      delete: (id) => { storedCredentials.delete(id); return Promise.resolve() }
    }
  })
  const credentials = new CredentialRegistry()
  credentials.set(PROVIDER, 'preparation-test-key')
  const storage = new JsonStorageDriver(root)
  manager = new SessionManager(credentials, storage, (method, params) => {
    if (method === 'run.completed') terminals.push({ method, params: params as ProtocolEvents['run.completed'] })
    if (method === 'run.failed') terminals.push({ method, params: params as ProtocolEvents['run.failed'] })
  }, new ProjectRegistry(storage), new ApprovalRegistry(root), new McpConfigStore(root),
  new SkillStore(root, join(root, 'agents')), new InspectStore(root), runtime, root)
  manager.syncCustomProviders([{ id: PROVIDER, name: '准备期测试', baseUrl: endpoint, models: [],
    modelDefs: [{ id: MODEL, reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 4_096 }]
  }], [])
  sessionId = manager.create({ cwd: root }).id
})

afterEach(async () => {
  for (const release of releases) release()
  await Promise.allSettled(hooks.prompts)
  manager.disposeAll()
  for (const session of hooks.sessions) session.dispose()
  server.closeAllConnections()
  await new Promise<void>((done) => { server.close(() => done()) })
  // 删除目标必须是本测试在系统临时根下创建的单个目录。
  expect(dirname(root)).toBe(resolve(tmpdir()))
  expect(root.split(/[\\/]/).at(-1)).toMatch(/^cogent-preparation-http-/)
  rmSync(root, { recursive: true, force: true })
})

function blockNext(phase: 'input' | 'beforeStart' | 'build' | 'compactAbort') {
  const entered = deferred()
  const resume = deferred()
  releases.push(resume.release)
  hooks[phase] = async () => {
    hooks[phase] = () => Promise.resolve(undefined)
    entered.release()
    await resume.promise
    return undefined
  }
  return { entered: entered.promise, release: resume.release }
}

async function waitTerminals(count: number) {
  await vi.waitFor(() => expect(terminals).toHaveLength(count), { timeout: 10_000, interval: 10 })
}

function submit(text = '准备期停止的问题') {
  manager.submit(sessionId, text, MODEL, 'off', PROVIDER)
}

describe('真实 pi 准备期取消与终态内容', () => {
  it.each(['input', 'beforeStart'] as const)('%s 等待中停止，恢复后零HTTP且user恰一份', async (phase) => {
    const gate = blockNext(phase)
    submit()
    await gate.entered
    expect(requests).toHaveLength(0)
    expect(manager.abort(sessionId)).toBe(true)
    gate.release()
    await waitTerminals(1)
    expect(terminals[0]).toMatchObject({ method: 'run.failed', params: { reason: 'aborted' } })
    expect(requests).toHaveLength(0)
    expect(manager.messages(sessionId).filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['准备期停止的问题'])
    expect(readPiTranscript(root, root, sessionId)?.filter((message) => message.role === 'user')).toHaveLength(1)
    submit('停止后的下一问')
    await waitTerminals(2)
    expect(requests).toHaveLength(1)
    expect(terminals[1].method).toBe('run.completed')
  })

  it('pi尚未装配时停止，装配返回后只持久化user，不调用模型', async () => {
    const gate = blockNext('build')
    submit()
    await gate.entered
    expect(manager.abort(sessionId)).toBe(true)
    expect(() => submit('不能抢入')).toThrow('会话正在回复中')
    gate.release()
    await waitTerminals(1)
    expect(terminals[0]).toMatchObject({ method: 'run.failed', params: { reason: 'aborted' } })
    expect(requests).toHaveLength(0)
    expect(readPiTranscript(root, root, sessionId)?.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(manager.messages(sessionId).filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['准备期停止的问题'])
  })

  it('input被handled时不会永久占用运行位，也不捏造模型回答', async () => {
    hooks.input = () => Promise.resolve({ action: 'handled' })
    submit()
    await waitTerminals(1)
    expect(requests).toHaveLength(0)
    expect(terminals[0].method).toBe('run.completed')
    expect(manager.abort(sessionId)).toBe(false)
    expect(manager.messages(sessionId).filter((message) => message.role === 'assistant')).toEqual([])
  })

  it('手动续写在pi preflight早停，已有截断前缀和usage不丢', async () => {
    answer = { text: '原始前缀', finish: 'length' }
    submit('需要续写的问题')
    await waitTerminals(1)
    expect(terminals[0]).toMatchObject({ method: 'run.completed', params: { stopReason: 'length' } })
    const prefix = terminals[0].params.messages!.map((message) => message.content).join('')
    expect(prefix).toBe('原始前缀'.repeat(4))
    const oldRequestCount = requests.length
    const gate = blockNext('input')
    const continuing = manager.continueSession(sessionId)
    await gate.entered
    expect(manager.abort(sessionId)).toBe(true)
    gate.release()
    await continuing
    await waitTerminals(2)
    expect(requests).toHaveLength(oldRequestCount)
    expect(terminals[1]).toMatchObject({ method: 'run.failed', params: { reason: 'aborted' } })
    expect(terminals[1].params.messages!.map((message) => message.content).join('')).toBe(prefix)
  })

  it('正常手动续写的终态快照包含原前缀和新增尾部，usage只算各自一次', async () => {
    answer = { text: '前缀', finish: 'length' }
    submit('需要续写的问题')
    await waitTerminals(1)
    expect(terminals[0]).toMatchObject({ method: 'run.completed', params: { stopReason: 'length' } })
    const prefix = terminals[0].params.messages!.map((message) => message.content).join('')
    const priorOutput = terminals[0].params.messages!.reduce((sum, message) => sum + message.usage!.output, 0)
    expect(hooks.sessions[0].agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'length' })
    answer = { text: '新增尾部', finish: 'stop' }
    await manager.continueSession(sessionId)
    await waitTerminals(2)
    expect(terminals[1].method).toBe('run.completed')
    expect(terminals[1].params.messages!.map((message) => message.content).join('')).toBe(`${prefix}新增尾部`)
    expect(terminals[1].params.messages!.reduce((sum, message) => sum + message.usage!.output, 0)).toBe(priorOutput + 2)
  })

  it('手动压缩装配期间停止，不启动摘要HTTP且预约释放', async () => {
    const gate = blockNext('build')
    const compacting = manager.compactSession(sessionId)
    const rejected = expect(compacting).rejects.toThrow('压缩已中止')
    await gate.entered
    expect(manager.abort(sessionId)).toBe(true)
    gate.release()
    await rejected
    expect(requests).toHaveLength(0)
    expect(terminals).toEqual([])
    expect(manager.abort(sessionId)).toBe(false)
    submit('取消压缩后提问')
    await waitTerminals(1)
    expect(terminals[0].method).toBe('run.completed')
  })

  it('手动压缩内部await-abort窗口停止，由compaction_start交接且零新增HTTP', async () => {
    submit('第一轮足够压缩的上下文')
    await waitTerminals(1)
    submit('第二轮足够压缩的上下文')
    await waitTerminals(2)
    const pi = hooks.sessions[0]
    pi.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 128 } })
    const transcript = manager.messages(sessionId)
    const priorRequests = requests.length
    let sawCompaction = false
    let aborted = false
    pi.subscribe((event) => {
      if (event.type === 'compaction_start') sawCompaction = true
      if (event.type === 'compaction_end') aborted = event.aborted
    })
    const gate = blockNext('compactAbort')
    const compacting = manager.compactSession(sessionId)
    const rejected = expect(compacting).rejects.toThrow('Compaction cancelled')
    await gate.entered
    expect(manager.abort(sessionId)).toBe(true)
    gate.release()
    await rejected
    expect(sawCompaction).toBe(true)
    expect(aborted).toBe(true)
    expect(requests).toHaveLength(priorRequests)
    expect(terminals).toHaveLength(2)
    expect(manager.messages(sessionId)).toEqual(transcript)
    expect(manager.abort(sessionId)).toBe(false)
  })

  it.each([false, true])('input准备期间删除（已有转录=%s），旧preflight不发HTTP或复活文件', async (withHistory) => {
    if (withHistory) {
      submit('之前已保存的一轮')
      await waitTerminals(1)
      await Promise.allSettled(hooks.prompts)
    }
    const priorRequests = requests.length
    const priorTerminals = terminals.length
    const gate = blockNext('input')
    submit('删除前尚未提交给模型的问题')
    await gate.entered
    const piFile = hooks.sessions[0].sessionManager.getSessionFile()!
    expect(existsSync(piFile)).toBe(withHistory)
    expect(manager.delete(sessionId)).toBe(true)
    gate.release()
    await Promise.allSettled(hooks.prompts)
    expect(requests).toHaveLength(priorRequests)
    expect(terminals).toHaveLength(priorTerminals)
    expect(manager.abort(sessionId)).toBe(false)
    expect(existsSync(piFile)).toBe(false)
  })
})
