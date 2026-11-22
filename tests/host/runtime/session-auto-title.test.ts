/** 标题任务用可控 Promise 验证所有权与主回合隔离；磁盘与 Host 会话服务使用真实实现。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, Api } from '@earendil-works/pi-ai'
import { ModelRuntime, SessionManager as PiSessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import type { ProtocolEvents, SessionSummary } from '../../../src/protocol'
import { createPiSession, readPiTranscript } from '../../../src/host/kernel/pi-session-factory'
import { InspectStore, JsonStorageDriver } from '../../../src/host/storage'
import { ApprovalRegistry } from '../../../src/host/runtime/approvals'
import { CredentialRegistry } from '../../../src/host/runtime/credentials'
import { McpConfigStore } from '../../../src/host/runtime/mcp-config'
import { ProjectRegistry } from '../../../src/host/runtime/project'
import { SessionManager } from '../../../src/host/runtime/session'
import { SkillStore } from '../../../src/host/runtime/skill-store'

vi.mock('../../../src/host/kernel/pi-session-factory', () => ({
  createPiSession: vi.fn(), readPiTranscript: vi.fn(), PI_AGENT_DIR_NAME: 'pi'
}))
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>((done) => setImmediate(done))
const answer = (text = '问候交流'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'custom/a', model: 'same',
  stopReason: 'stop', timestamp: 0, usage: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 24,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
})
const model: Model<Api> = { id: 'same', name: 'same', provider: 'custom/a', api: 'openai-completions',
  baseUrl: 'http://localhost/v1', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
let root: string
let manager: SessionManager
let storage: JsonStorageDriver
let runtime: ModelRuntime
let sid: string
let summaries: SessionSummary[]
let terminals: Array<{ method: string; params: unknown }>
let requests: Array<{ result: ReturnType<typeof deferred<AssistantMessage>>; model: Model<Api>; signal: AbortSignal; input: string }>
let main: Map<string, ReturnType<typeof deferred<void>>>

function makeManager() {
  return new SessionManager(new CredentialRegistry(), storage, (method, params) => {
    if (method === 'session.summaryChanged') summaries.push((params as ProtocolEvents['session.summaryChanged']).summary)
    if (method === 'run.completed' || method === 'run.failed') terminals.push({ method, params })
  }, new ProjectRegistry(storage), new ApprovalRegistry(root), new McpConfigStore(root),
  new SkillStore(root, join(root, 'agents')), new InspectStore(root), runtime, root)
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cogent-auto-title-'))
  storage = new JsonStorageDriver(root)
  summaries = []; terminals = []; requests = []; main = new Map()
  vi.mocked(readPiTranscript).mockReset()
  runtime = await ModelRuntime.create({ credentials: {
    read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
    modify: () => Promise.resolve(undefined), delete: () => Promise.resolve(undefined)
  } })
  vi.spyOn(runtime, 'completeSimple').mockImplementation((selected, context, options) => {
    const result = deferred<AssistantMessage>()
    requests.push({ result, model: selected, signal: options!.signal!, input: context.messages[0].content as string })
    return result.promise
  })
  vi.mocked(createPiSession).mockImplementation((options) => {
    const tree = PiSessionManager.inMemory(root)
    const state: { messages: AgentMessage[]; model: Model<Api>; errorMessage?: string } = { messages: [], model }
    const gate = deferred<void>(); main.set(options.sessionId, gate)
    const pi = { model, thinkingLevel: 'off', systemPrompt: 'test', sessionManager: tree,
      agent: { state, subscribe: () => () => {} }, dispose: () => {}, abort: () => Promise.resolve(),
      setModel: (selected: Model<Api>) => { pi.model = selected; state.model = selected; return Promise.resolve() },
      prompt: async (text: string, opts?: Parameters<AgentSession['prompt']>[1]) => {
        opts?.preflightResult?.('started')
        const message = { role: 'user' as const, content: text, timestamp: 1 }
        options.onUserEntry?.(tree.appendMessage(message), root)
        state.messages.push(message)
        options.onEvent({ type: 'message_end', message })
        await gate.promise
        options.onEvent({ type: 'agent_settled', aborted: false })
      }
    }
    return Promise.resolve({ session: pi as unknown as AgentSession, piSessionManager: tree, createdNew: false })
  })
  manager = makeManager()
  manager.syncCustomProviders(['a', 'b'].map((name) => ({ id: `custom/${name}`, name,
    baseUrl: 'http://localhost/v1', models: ['same'] })), [])
  sid = manager.create({ cwd: root }).id
})
afterEach(async () => {
  manager.disposeAll()
  for (const gate of main.values()) gate.resolve()
  for (const request of requests) request.result.resolve(answer('迟到结果'))
  await tick()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('首条立即广播临时标题，主回合结束前标题可保存；摘要并发变更保留且不跳活动顺序', async () => {
  manager.submit(sid, '你好')
  expect(summaries.at(-1)?.title).toBe('你好')
  await tick()
  expect(requests).toHaveLength(1)
  expect(terminals).toEqual([])
  const updatedAt = manager.list()[0].updatedAt
  manager.setPinned(sid, true); manager.archive(sid, true); manager.setPermission(sid, 'auto')
  requests[0].result.resolve(answer())
  await tick()
  const saved = manager.listArchived()[0]
  expect(saved).toMatchObject({ title: '问候交流', permissionMode: 'auto', updatedAt })
  expect(typeof saved.pinnedAt).toBe('number'); expect(typeof saved.archivedAt).toBe('number')
  expect(storage.get('sessions', sid)).toMatchObject({ autoTitle: 'attempted', summary: saved })
  expect(manager.inspectEntries(sid).filter((entry) => entry.kind === 'title.finished')[0].overview)
    .toContainEqual({ label: '成本', value: '未知（端点未报告价格）' })
})

it.each(['你好', '新会话'])('生成中手动命名为 %s，即使同名也取消且不接收迟到结果', async (title) => {
  manager.submit(sid, '你好'); await tick()
  manager.rename(sid, title)
  expect(requests[0].signal.aborted).toBe(true)
  requests[0].result.resolve(answer('不该覆盖'))
  await tick()
  expect(manager.list()[0]).toMatchObject({ title, titleManual: true })
  expect(manager.inspectEntries(sid).filter((entry) => entry.kind === 'title.finished')).toHaveLength(1)
})

it.each(['stop', 'delete', 'dispose'] as const)('%s 使标题 owner 失效，迟到结果不复活会话或额外发布摘要', async (action) => {
  manager.submit(sid, '你好'); await tick()
  if (action === 'stop') expect(manager.abort(sid)).toBe(true)
  else if (action === 'delete') manager.delete(sid)
  else manager.disposeAll()
  const count = summaries.length
  requests[0].result.resolve(answer('不该发布')); await tick()
  expect(requests[0].signal.aborted).toBe(true)
  expect(summaries).toHaveLength(count)
  if (action !== 'stop') expect(manager.list()).toEqual([])
})

it('首句本身是“新会话”也只生成一次；第二轮期间迟到用量仍归第一轮', async () => {
  manager.submit(sid, '新会话'); await tick()
  main.get(sid)!.resolve(); await tick()
  manager.submit(sid, '第二轮'); await tick()
  requests[0].result.resolve(answer('首句主题')); await tick()
  expect(requests).toHaveLength(1)
  const result = manager.inspectEntries(sid).find((entry) => entry.kind === 'title.finished')!
  expect(result.run).toBe(1)
  expect(terminals.every((event) => !(event.params as { usage?: unknown }).usage)).toBe(true)
  expect(manager.list()[0].title).toBe('首句主题')
})

it('A/B 独立；受理时冻结的策略和 provider/id 双键不受设置变更影响', async () => {
  manager.titleSettings.set({ enabled: true, model: { provider: 'custom/b', id: 'same' } })
  manager.submit(sid, 'A 的首句')
  manager.titleSettings.set({ enabled: false })
  const second = manager.create({ cwd: root }).id
  manager.submit(second, 'B 的首句'); await tick()
  expect(requests).toHaveLength(1)
  expect(requests[0].model.provider).toBe('custom/b')
  requests[0].result.resolve(answer('A 的标题')); await tick()
  expect(manager.list().find((item) => item.id === second)?.title).toBe('B 的首句')
})

it('创建时显式命名为“新会话”也保护；旧会话无资格不补发', async () => {
  const named = manager.create({ title: '新会话', cwd: root }).id
  manager.submit(named, '不应覆盖'); await tick()
  expect(requests).toEqual([])
  const summary = manager.list().find((item) => item.id === sid)!
  storage.put('sessions', sid, { version: 2, summary })
  manager.disposeAll(); manager = makeManager()
  manager.submit(sid, '旧会话继续'); await tick()
  expect(requests).toEqual([])
  expect(manager.list().find((item) => item.id === named)?.title).toBe('新会话')
})

it('恢复的 ready 已有真实 user 时消费资格但不再请求，attempted 重启也不重发', async () => {
  vi.mocked(readPiTranscript).mockReturnValue([{ role: 'user', content: '已经落树的首句', timestamp: 1 }])
  manager.submit(sid, '后续输入'); await tick()
  expect(requests).toEqual([])
  main.get(sid)!.resolve(); await tick()
  manager.disposeAll(); manager = makeManager()
  manager.submit(sid, '重启续聊'); await tick()
  expect(requests).toEqual([])
})

it('消费资格写盘失败则不发辅助请求，主对话继续；最终标题写失败保留临时标题', async () => {
  const put = vi.spyOn(storage, 'put').mockImplementationOnce(() => { throw new Error('消费标记写失败') })
  manager.submit(sid, '你好'); await tick()
  expect(requests).toEqual([])
  main.get(sid)!.resolve(); await tick()
  expect(terminals[0].method).toBe('run.completed')
  put.mockRestore()
  const second = manager.create({ cwd: root }).id
  manager.submit(second, '第二个首句'); await tick()
  vi.spyOn(storage, 'put').mockImplementationOnce(() => { throw new Error('最终标题保存失败') })
  requests[0].result.resolve(answer()); await tick()
  expect(manager.list().find((item) => item.id === second)?.title).toBe('第二个首句')
  expect(manager.inspectEntries(second).find((entry) => entry.kind === 'title.finished')?.title).toContain('失败')
})

it('模型返回式失败保留临时标题，主回合终态不受影响且失败用量可查', async () => {
  manager.submit(sid, '你好'); await tick()
  requests[0].result.resolve({ ...answer('半截标题'), stopReason: 'length' }); await tick()
  expect(manager.list()[0].title).toBe('你好')
  main.get(sid)!.resolve(); await tick()
  expect(terminals[0].method).toBe('run.completed')
  expect(manager.inspectEntries(sid).find((entry) => entry.kind === 'title.finished')?.overview)
    .toContainEqual({ label: '总 tokens', value: '24' })
})

it.each(['file', 'directory'] as const)('只有 %s 无正文时用显示名称，不把路径或文件内容送给标题模型', async (kind) => {
  const path = join(root, '需求说明.txt')
  writeFileSync(path, '不应进入标题调用的文件内容')
  const ids = kind === 'file' ? [(await manager.attachments.importPath(path)).id] : []
  manager.submit(sid, '', undefined, undefined, undefined, ids, 'input-attachments',
    kind === 'directory' ? [{ kind: 'directory', name: '项目资料', path: root }] : [])
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  const input = (JSON.parse(requests[0].input) as { input: string }).input
  expect(input.trim()).toBe(kind === 'file' ? '需求说明.txt' : '项目资料')
  expect(input).not.toContain(root)
  expect(input).not.toContain('不应进入标题调用的文件内容')
})

it('不存在的标题模型不回落到其他供应商，也不影响主对话', async () => {
  manager.titleSettings.set({ enabled: true, model: { provider: 'missing', id: 'same' } })
  manager.submit(sid, '你好'); await tick()
  expect(requests).toEqual([])
  expect(manager.list()[0].title).toBe('你好')
  expect(manager.inspectEntries(sid).find((entry) => entry.kind === 'title.finished')?.overview)
    .toContainEqual({ label: '原因', value: '标题模型不可用：missing / same' })
  main.get(sid)!.resolve(); await tick()
  expect(terminals[0].method).toBe('run.completed')
})
