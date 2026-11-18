/** 准备期取消回归：可控装配/公开pi分派回调驱动真实Host，验证预约与迟到结果归属。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { ModelRuntime, SessionManager as PiSessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import type { ProtocolEvents } from '../../../src/protocol'
import { InspectStore, JsonStorageDriver } from '../../../src/host/storage'
import { createPiSession, type PiSessionOptions } from '../../../src/host/kernel/pi-session-factory'
import { ApprovalRegistry } from '../../../src/host/runtime/approvals'
import { CredentialRegistry } from '../../../src/host/runtime/credentials'
import { McpConfigStore } from '../../../src/host/runtime/mcp-config'
import { ProjectRegistry } from '../../../src/host/runtime/project'
import { SessionManager } from '../../../src/host/runtime/session'
import { SkillStore } from '../../../src/host/runtime/skill-store'

vi.mock('../../../src/host/kernel/pi-session-factory', () => ({
  createPiSession: vi.fn(), PI_AGENT_DIR_NAME: 'pi', readPiTranscript: vi.fn()
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const answer = (content: string, stopReason: AssistantMessage['stopReason'] = 'length'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text: content }], stopReason,
  api: 'openai-completions', provider: 'custom/test', model: 'test', timestamp: 200, durationMs: 50,
  usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
})
type Terminal = { method: 'run.completed'; params: ProtocolEvents['run.completed'] }
  | { method: 'run.failed'; params: ProtocolEvents['run.failed'] }

let root: string
let manager: SessionManager
let sid: string
let options: PiSessionOptions
let state: { messages: AgentMessage[]; errorMessage?: string }
let terminal: Terminal[]
let started: number
let build: ReturnType<typeof deferred<void>>
let prompt: ReturnType<typeof vi.fn<AgentSession['prompt']>>
let compact: ReturnType<typeof vi.fn<AgentSession['compact']>>
let abort: ReturnType<typeof vi.fn<AgentSession['abort']>>
let abortCompaction: ReturnType<typeof vi.fn<AgentSession['abortCompaction']>>
let dispose: ReturnType<typeof vi.fn<AgentSession['dispose']>>
let setModel: ReturnType<typeof vi.fn<AgentSession['setModel']>>
let tree: PiSessionManager
let coreListeners: Set<Parameters<Agent['subscribe']>[0]>

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cogent-prepare-'))
  state = { messages: [] }
  terminal = []; started = 0
  build = deferred<void>()
  tree = PiSessionManager.inMemory(root)
  prompt = vi.fn<AgentSession['prompt']>((_text, opts) => {
    opts?.preflightResult?.('handled')
    return Promise.resolve()
  })
  compact = vi.fn<AgentSession['compact']>().mockResolvedValue({
    summary: 'summary', firstKeptEntryId: 'entry', tokensBefore: 100
  })
  abort = vi.fn<AgentSession['abort']>().mockResolvedValue(undefined)
  abortCompaction = vi.fn<AgentSession['abortCompaction']>()
  dispose = vi.fn<AgentSession['dispose']>()
  setModel = vi.fn<AgentSession['setModel']>().mockResolvedValue(undefined)
  coreListeners = new Set()
  const pi = { agent: { state, subscribe: (listener: Parameters<Agent['subscribe']>[0]) => {
    coreListeners.add(listener)
    return () => { coreListeners.delete(listener) }
  } }, systemPrompt: 'test', sessionManager: tree,
    refreshContext: () => { state.messages = tree.buildSessionContext().messages },
    prompt, compact, abort, abortCompaction, dispose, setModel }
  vi.mocked(createPiSession).mockImplementation(async (value) => {
    options = value
    await build.promise
    return { session: pi as unknown as AgentSession, piSessionManager: tree, createdNew: false }
  })
  const storage = new JsonStorageDriver(root)
  const runtime = await ModelRuntime.create({ credentials: {
    read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
    modify: () => Promise.resolve(undefined), delete: () => Promise.resolve(undefined)
  } })
  manager = new SessionManager(new CredentialRegistry(), storage, (method, params) => {
    if (method === 'run.started') started++
    if (method === 'run.completed') terminal.push({ method, params: params as ProtocolEvents['run.completed'] })
    if (method === 'run.failed') terminal.push({ method, params: params as ProtocolEvents['run.failed'] })
  }, new ProjectRegistry(storage), new ApprovalRegistry(root), new McpConfigStore(root),
  new SkillStore(root, join(root, 'agents')), new InspectStore(root), runtime, root)
  sid = manager.create({ cwd: root }).id
})
afterEach(async () => {
  build.resolve()
  await Promise.resolve()
  manager.disposeAll()
  rmSync(root, { recursive: true, force: true })
})
const tick = () => new Promise<void>((done) => setImmediate(done))
const seedPrefix = () => {
  tree.appendMessage({ role: 'user', content: '问题', timestamp: 100 })
  tree.appendMessage(answer('已有前缀'))
  state.messages = tree.buildSessionContext().messages
}

describe('Host 准备阶段停止与运行预约', () => {
  it('重命名落盘失败时不改内存标题，允许重试', () => {
    const original = { ...manager.list()[0] }
    const put = vi.spyOn(JsonStorageDriver.prototype, 'put').mockImplementationOnce(() => { throw new Error('磁盘只读') })
    try {
      expect(() => manager.rename(sid, '新标题')).toThrow('磁盘只读')
      expect(manager.list()[0]).toEqual(original)
      expect(manager.rename(sid, '新标题')).toEqual({ ...original, title: '新标题', titleManual: true })
      expect(createPiSession).not.toHaveBeenCalled()
    } finally {
      put.mockRestore()
    }
  })

  it('submit装配时停止：不调用prompt，已提交user进入树且唯一aborted终态', async () => {
    manager.submit(sid, '准备期问题')
    expect(manager.abort(sid)).toBe(true)
    expect(terminal).toEqual([])
    build.resolve(); await tick()
    expect(prompt).not.toHaveBeenCalled()
    expect(state.messages.filter((message) => message.role === 'user')).toEqual([
      expect.objectContaining({ content: '准备期问题' })
    ])
    expect(terminal).toEqual([{ method: 'run.failed', params: {
      sessionId: sid, reason: 'aborted', message: '已停止', messages: []
    } }])
  })

  it('continue首await前预约：同会话其它启动被拒，停止保留原截断前缀', async () => {
    seedPrefix()
    const continuation = manager.continueSession(sid)
    expect(started).toBe(1)
    expect(() => manager.submit(sid, '不可并发')).toThrow('会话正在回复中')
    await expect(manager.continueSession(sid)).rejects.toThrow('会话正在回复中')
    await expect(manager.compactSession(sid)).rejects.toThrow('会话正在回复中')
    expect(manager.abort(sid)).toBe(true)
    build.resolve(); await continuation
    expect(prompt).not.toHaveBeenCalled()
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ method: 'run.failed', params: {
      reason: 'aborted', messages: [{ content: '已有前缀' }]
    } })
  })

  it('manual compact装配时停止：不调用compact，操作以取消拒绝且预约释放', async () => {
    const operation = manager.compactSession(sid)
    const rejected = expect(operation).rejects.toThrow('压缩已中止')
    expect(manager.abort(sid)).toBe(true)
    build.resolve(); await rejected
    expect(compact).not.toHaveBeenCalled()
    expect(manager.abort(sid)).toBe(false)
    expect(terminal).toEqual([])
  })

  it('删除期间装配完成：回收迟到pi，不启动模型或发终态', async () => {
    manager.submit(sid, '会被删除')
    expect(manager.delete(sid)).toBe(true)
    build.resolve(); await tick()
    expect(dispose).toHaveBeenCalledOnce()
    expect(prompt).not.toHaveBeenCalled()
    expect(terminal).toEqual([])
  })

  it('handled不发settled：Host仍结束运行，不遗留永久busy', async () => {
    manager.submit(sid, '已处理指令')
    build.resolve(); await tick()
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ method: 'run.completed' })
    expect(manager.abort(sid)).toBe(false)
  })

  it('pi input准备时停止，started回调重新交接abort且不丢原输入', async () => {
    const prepared = deferred<void>()
    prompt.mockImplementationOnce(async (text, opts) => {
      await prepared.promise
      opts?.preflightResult?.('started')
      options.onEvent({ type: 'message_end', message: { role: 'user', content: text, timestamp: 100 } })
      options.onEvent({ type: 'agent_settled', aborted: true })
    })
    manager.submit(sid, '输入准备')
    build.resolve(); await tick()
    manager.abort(sid)
    expect(abort).toHaveBeenCalledTimes(1)
    prepared.resolve(); await tick()
    expect(abort).toHaveBeenCalledTimes(2)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ method: 'run.failed', params: { reason: 'aborted' } })
  })

  it('正常continue最终快照保留旧前缀并只累加一次用量', async () => {
    seedPrefix()
    prompt.mockImplementationOnce((_text, opts) => {
      opts?.preflightResult?.('started')
      const message = answer('新增尾部', 'stop')
      state.messages.push(message)
      options.onEvent({ type: 'message_update', message, assistantMessageEvent: {
        type: 'text_delta', contentIndex: 0, delta: '新增尾部', partial: message
      } })
      options.onEvent({ type: 'turn_end', message, toolResults: [] })
      options.onEvent({ type: 'agent_settled', aborted: false })
      return Promise.resolve()
    })
    build.resolve(); await manager.continueSession(sid)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ method: 'run.completed', params: {
      messages: [{ content: '已有前缀新增尾部', usage: { input: 24, output: 8 } }],
      message: { usage: { input: 24, output: 8 }, durationMs: 100 }
    } })
    expect(terminal[0].params.messages?.[0].usage?.contextEstimate?.total).toEqual(expect.any(Number))
  })

  it('setModel等待时停止：配置返回后保存user并停止，不继续prompt', async () => {
    const changed = deferred<void>()
    setModel.mockReturnValueOnce(changed.promise)
    manager.submit(sid, '切模型期间停止', 'claude-sonnet-4-5', undefined, 'anthropic')
    build.resolve(); await tick()
    expect(setModel).toHaveBeenCalledOnce()
    manager.abort(sid)
    changed.resolve(); await tick()
    expect(prompt).not.toHaveBeenCalled()
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ method: 'run.failed', params: { reason: 'aborted' } })
    expect(state.messages).toEqual([expect.objectContaining({ role: 'user', content: '切模型期间停止' })])
  })

  it('停止期间真实装配拒绝仍为error，不伪装aborted或保存成功', async () => {
    manager.submit(sid, '未能装配')
    manager.abort(sid)
    build.reject(new Error('初始化失败'))
    await tick()
    expect(terminal).toEqual([{ method: 'run.failed', params: {
      sessionId: sid, reason: 'error', message: '初始化失败'
    } }])
    expect(tree.getBranch().filter((entry) => entry.type === 'message')).toEqual([])
    expect(manager.abort(sid)).toBe(false)
  })

  it('无效continue也发唯一error并释放准备预约', async () => {
    const operation = manager.continueSession(sid)
    expect(started).toBe(1)
    const rejected = expect(operation).rejects.toThrow('末条回复不是输出截断')
    build.resolve(); await rejected
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ method: 'run.failed', params: { reason: 'error' } })
    expect(manager.abort(sid)).toBe(false)
    expect(() => manager.submit(sid, '可以再发')).not.toThrow()
    await tick()
    expect(terminal).toHaveLength(2)
  })

  it('handled返回前已停止：原始user只补一次并收为aborted', async () => {
    const input = deferred<void>()
    prompt.mockImplementationOnce(async (_text, opts) => {
      await input.promise
      opts?.preflightResult?.('handled')
    })
    manager.submit(sid, '被处理但已停止')
    build.resolve(); await tick()
    manager.abort(sid)
    input.resolve(); await tick()
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ method: 'run.failed', params: { reason: 'aborted' } })
    expect(tree.buildSessionContext().messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('pi已经交付user的handled分支不重复补原始输入', async () => {
    prompt.mockImplementationOnce((text, opts) => {
      const message = { role: 'user' as const, content: text, timestamp: 100 }
      tree.appendMessage(message)
      options.onEvent({ type: 'message_end', message })
      opts?.preflightResult?.('handled')
      return Promise.resolve()
    })
    manager.submit(sid, '已由pi交付')
    build.resolve(); await tick()
    expect(tree.buildSessionContext().messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(terminal).toHaveLength(1)
  })

  it('manual compact内部await期间停止，compaction_start按同一owner重放取消', async () => {
    const opening = deferred<void>()
    compact.mockImplementationOnce(async () => {
      await opening.promise
      options.onEvent({ type: 'compaction_start', reason: 'manual' })
      if (abortCompaction.mock.calls.length > 0) throw new Error('压缩已中止')
      return { summary: '不可到达', firstKeptEntryId: 'entry', tokensBefore: 100 }
    })
    const operation = manager.compactSession(sid)
    const rejected = expect(operation).rejects.toThrow('压缩已中止')
    build.resolve(); await tick()
    expect(compact).toHaveBeenCalledOnce()
    manager.abort(sid)
    expect(abortCompaction).not.toHaveBeenCalled()
    opening.resolve(); await rejected
    expect(abortCompaction).toHaveBeenCalledOnce()
    expect(manager.abort(sid)).toBe(false)
    expect(terminal).toEqual([])
  })

  it('disposeAll期间装配完成：迟到pi回收，不能发模型请求', async () => {
    manager.submit(sid, '退出期间')
    manager.disposeAll()
    build.resolve(); await tick()
    expect(dispose).toHaveBeenCalledOnce()
    expect(prompt).not.toHaveBeenCalled()
    expect(terminal).toEqual([])
  })

  it('continue已经生成新尾部再停止，完整快照仍有旧前缀且不重复usage', async () => {
    seedPrefix()
    prompt.mockImplementationOnce((_text, opts) => {
      opts?.preflightResult?.('started')
      manager.abort(sid)
      const message = answer('半截续文', 'aborted')
      state.messages.push(message)
      options.onEvent({ type: 'message_update', message, assistantMessageEvent: {
        type: 'text_delta', contentIndex: 0, delta: '半截续文', partial: message
      } })
      options.onEvent({ type: 'turn_end', message, toolResults: [] })
      options.onEvent({ type: 'agent_settled', aborted: true })
      return Promise.resolve()
    })
    build.resolve(); await manager.continueSession(sid)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ method: 'run.failed', params: {
      reason: 'aborted', messages: [{ content: '已有前缀半截续文', usage: { input: 24, output: 8 } }]
    } })
  })

  it('删除后旧input才恢复：独立core启动监听仍会取消，并在首次启动后撤销', async () => {
    const input = deferred<void>()
    prompt.mockImplementationOnce(async (_text, opts) => {
      await input.promise
      opts?.preflightResult?.('started')
      const signal = new AbortController().signal
      for (const listener of [...coreListeners]) await listener({ type: 'agent_start' }, signal)
      expect(coreListeners.size).toBe(0)
    })
    manager.submit(sid, '删除时还在input')
    build.resolve(); await tick()
    expect(coreListeners.size).toBe(1)
    manager.delete(sid)
    input.resolve(); await tick()
    expect(abort).toHaveBeenCalledOnce()
    expect(coreListeners.size).toBe(0)
    expect(terminal).toEqual([])
  })
})
