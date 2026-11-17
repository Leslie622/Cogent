/**
 * Host 终态转译回归：用可控 pi 装配边界驱动真实 SessionManager，验证已封存正文、
 * agent_settled 的 run 级原因以及 Host 自动续写 owner；不复制转译实现。
 * pi 内部如何产生 aborted 由上游边界回归负责，本件只断言 Host 消费其公开事件合同。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { ModelRuntime, type AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { ProtocolEvents } from '../../protocol'
import { InspectStore, JsonStorageDriver } from '../storage'
import { createPiSession, type PiSessionOptions } from '../kernel/pi-session-factory'
import { ApprovalRegistry } from './approvals'
import { CredentialRegistry } from './credentials'
import { McpConfigStore } from './mcp-config'
import { ProjectRegistry } from './project'
import { SessionManager } from './session'
import { SkillStore } from './skill-store'

vi.mock('../kernel/pi-session-factory', () => ({
  createPiSession: vi.fn(),
  PI_AGENT_DIR_NAME: 'pi',
  readPiTranscript: vi.fn()
}))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const assistant = (content: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text: content }], stopReason,
  api: 'openai-completions', provider: 'custom/test', model: 'test', timestamp: 1_000,
  usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
})

type Terminal =
  | { method: 'run.completed'; params: ProtocolEvents['run.completed'] }
  | { method: 'run.failed'; params: ProtocolEvents['run.failed'] }

let root: string
let manager: SessionManager
let sessionId: string
let options: PiSessionOptions
let state: { messages: AgentMessage[]; errorMessage?: string }
let terminals: Terminal[]
let entered: ReturnType<typeof deferred>
let release: ReturnType<typeof deferred>
let prompt: ReturnType<typeof vi.fn<AgentSession['prompt']>>
let abort: ReturnType<typeof vi.fn<AgentSession['abort']>>

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cogent-terminal-'))
  terminals = []
  state = { messages: [] }
  entered = deferred()
  release = deferred()
  prompt = vi.fn<AgentSession['prompt']>(async () => { entered.resolve(); await release.promise })
  abort = vi.fn<AgentSession['abort']>().mockResolvedValue(undefined)
  const pi = { agent: { state, subscribe: vi.fn(() => () => {}) }, systemPrompt: 'test', prompt, abort, dispose: vi.fn() }
  vi.mocked(createPiSession).mockImplementation((value) => {
    options = value
    return Promise.resolve({ session: pi as unknown as AgentSession, createdNew: false,
      piSessionManager: undefined as unknown as Awaited<ReturnType<typeof createPiSession>>['piSessionManager'] })
  })
  const storage = new JsonStorageDriver(root)
  const runtime = await ModelRuntime.create({ credentials: {
    read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
    modify: () => Promise.resolve(undefined), delete: () => Promise.resolve(undefined)
  } })
  manager = new SessionManager(new CredentialRegistry(), storage, (method, params) => {
    if (method === 'run.completed') terminals.push({ method, params: params as ProtocolEvents['run.completed'] })
    if (method === 'run.failed') terminals.push({ method, params: params as ProtocolEvents['run.failed'] })
  }, new ProjectRegistry(storage), new ApprovalRegistry(root), new McpConfigStore(root),
  new SkillStore(root, join(root, 'agents')), new InspectStore(root), runtime, root)
  sessionId = manager.create({ cwd: root }).id
})

afterEach(() => {
  release.resolve()
  manager.disposeAll()
  rmSync(root, { recursive: true, force: true })
})

async function start() {
  manager.submit(sessionId, '开始')
  await entered.promise
}

function emit(event: AgentSessionEvent) { options.onEvent(event) }

function seal(content: string, stopReason: AssistantMessage['stopReason'] = 'stop') {
  const message = assistant(content, stopReason)
  state.messages = [message]
  emit({ type: 'message_update', message, assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: content, partial: message
  } })
  emit({ type: 'turn_end', message, toolResults: [] })
}

async function settle(aborted: boolean) {
  emit({ type: 'agent_settled', aborted })
  release.resolve()
  await new Promise<void>((done) => setImmediate(done))
}

describe('Host run 终态原因与分段快照', () => {
  it('普通完成只有一次 completed，正文与 usage 沿终态落账', async () => {
    await start()
    seal('完整回答')
    await settle(false)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ method: 'run.completed', params: {
      messages: [{ content: '完整回答', usage: { input: 12, output: 4 } }]
    } })
  })

  it('流中止明确给出 aborted，已封存半截正文恰一份', async () => {
    await start()
    expect(manager.abort(sessionId)).toBe(true)
    expect(abort).toHaveBeenCalledOnce()
    seal('半截回答', 'aborted')
    state.errorMessage = 'Request was aborted'
    await settle(true)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ method: 'run.failed', params: {
      reason: 'aborted', messages: [{ content: '半截回答', usage: { input: 12 } }]
    } })
    expect(terminals[0].params.messages).toHaveLength(1)
  })

  it('成功回答后的收口钩子中止不依赖 errorMessage 或单轮 stopReason', async () => {
    await start()
    seal('已经答完')
    manager.abort(sessionId)
    await settle(true)
    expect(state.errorMessage).toBeUndefined()
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ method: 'run.failed', params: {
      reason: 'aborted', messages: [{ content: '已经答完' }]
    } })
  })

  it('真正失败给出 error，保留已封存正文而不伪装停止', async () => {
    await start()
    seal('出错前正文', 'error')
    state.errorMessage = '网络已断开'
    await settle(false)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ method: 'run.failed', params: {
      reason: 'error', message: '网络已断开', messages: [{ content: '出错前正文' }]
    } })
  })

  it('无正文的中止明确给权威空快照', async () => {
    await start()
    state.errorMessage = 'Request was aborted'
    await settle(true)
    expect(terminals).toEqual([{ method: 'run.failed', params: {
      sessionId, reason: 'aborted', message: 'Request was aborted', messages: []
    } }])
  })

  it('length 收口期间中止后不再启动 AUTO_CONTINUE', async () => {
    await start()
    seal('长度已满', 'length')
    manager.abort(sessionId)
    await settle(true)
    expect(prompt).toHaveBeenCalledOnce()
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ method: 'run.failed', params: { reason: 'aborted' } })
  })

  it('正常完成已收口后 abort 返回 false，不改变既有终态', async () => {
    await start()
    seal('完整回答')
    await settle(false)
    expect(manager.abort(sessionId)).toBe(false)
    expect(abort).not.toHaveBeenCalled()
    expect(terminals).toHaveLength(1)
    expect(terminals[0].method).toBe('run.completed')
  })

  it('prompt 前置拒绝明确发 error，缺省完整快照而不捏造空正文', async () => {
    prompt.mockRejectedValueOnce(new Error('鉴权被拒绝'))
    manager.submit(sessionId, '开始')
    await vi.waitFor(() => expect(terminals).toHaveLength(1))
    expect(terminals[0]).toEqual({ method: 'run.failed', params: {
      sessionId, reason: 'error', message: '鉴权被拒绝'
    } })
    expect(manager.abort(sessionId)).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)('旧 prompt %s 不会续写或清除下一 run 的账本', async (completion) => {
    await start()
    seal('旧长度尾段', 'length')
    emit({ type: 'agent_settled', aborted: true })
    const nextEntered = deferred()
    const nextRelease = deferred()
    prompt.mockImplementationOnce(async () => { nextEntered.resolve(); await nextRelease.promise })
    manager.submit(sessionId, '下一次运行')
    await nextEntered.promise
    try {
      if (completion === 'resolve') release.resolve()
      else release.reject(new Error('旧请求晚到拒绝'))
      await new Promise<void>((done) => setImmediate(done))
      expect(prompt).toHaveBeenCalledTimes(2)
      expect(terminals).toHaveLength(1)
      expect(() => manager.submit(sessionId, '不可并发')).toThrow('会话正在回复中')
      seal('新回答')
      emit({ type: 'agent_settled', aborted: false })
      expect(terminals).toHaveLength(2)
      expect(terminals[1]).toMatchObject({ method: 'run.completed', params: {
        messages: [{ content: '新回答' }]
      } })
    } finally {
      nextRelease.resolve()
      await new Promise<void>((done) => setImmediate(done))
    }
  })
})
