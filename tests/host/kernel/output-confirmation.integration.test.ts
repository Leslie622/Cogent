/** 真实 pi 最终工具链：扩展拦截/最终判错/磁盘提交失败均不得发布候选声明。 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelRuntime, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { JsonStorageDriver, InspectStore } from '../../../src/host/storage'
import { SessionManager } from '../../../src/host/runtime/session'
import { CredentialRegistry } from '../../../src/host/runtime/credentials'
import { ProjectRegistry } from '../../../src/host/runtime/project'
import { ApprovalRegistry } from '../../../src/host/runtime/approvals'
import { McpConfigStore } from '../../../src/host/runtime/mcp-config'
import { SkillStore } from '../../../src/host/runtime/skill-store'

const control = vi.hoisted(() => ({ reject: false, block: false }))
vi.mock('../../../src/host/runtime/hook-seat', async (originalImport) => {
  const original = await originalImport<typeof import('../../../src/host/runtime/hook-seat')>()
  return { ...original, createCogentHooks: (opts: Parameters<typeof original.createCogentHooks>[0]) => {
    const extension = original.createCogentHooks(opts)
    const factory = typeof extension === 'function' ? extension : extension.factory
    return { name: 'output-confirmation-test', factory: (pi: ExtensionAPI) => {
      const result = factory(pi)
      pi.on('tool_call', (event) => event.toolName === 'report_outputs' && control.block ? { block: true, reason: '扩展阻止' } : undefined)
      pi.on('tool_result', (event) => event.toolName === 'report_outputs' && control.reject ? { isError: true } : undefined)
      return result
    } }
  } }
})

let root: string
let manager: SessionManager
let server: Server
let sid: string
let toolErrors: boolean[]
let done: boolean
let requests: number
let outputErrors: string[]
let outputStates: string[]
let releases: Array<() => void>
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cogent-output-pi-'))
  writeFileSync(join(root, 'report.txt'), '报告')
  control.reject = false; control.block = false; toolErrors = []; done = false; requests = 0; outputErrors = []; outputStates = []; releases = []
  server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const tool = requests++ === 0
      const frame = (delta: object, finish: string | null) => ({ id: 'out', object: 'chat.completion.chunk', model: 'mock', created: 0, choices: [{ index: 0, delta, finish_reason: finish }] })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(frame(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'report-1', type: 'function', function: { name: 'report_outputs', arguments: JSON.stringify({ deliverables: [{ path: 'report.txt' }] }) } }] } : { role: 'assistant', content: '完成' }, null))}\n\n`)
      response.write(`data: ${JSON.stringify(frame({}, tool ? 'tool_calls' : 'stop'))}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStorePath: join(root, 'cache.json'), refreshOnCreate: false,
    credentials: { read: () => Promise.resolve(undefined), list: () => Promise.resolve([]), modify: () => Promise.resolve(undefined), delete: () => Promise.resolve(undefined) } })
  await runtime.setRuntimeApiKey('custom/mock', 'test-key')
  const credentials = new CredentialRegistry(); credentials.set('custom/mock', 'test-key')
  const storage = new JsonStorageDriver(root)
  manager = new SessionManager(credentials, storage, (method, params) => {
    if (method === 'run.completed' || method === 'run.failed') done = true
    if (method === 'tool.completed') toolErrors.push((params as { isError: boolean }).isError)
    if (method === 'outputs.error') outputErrors.push((params as { message: string }).message)
    if (method === 'outputs.updated') outputStates.push((params as { state: string }).state)
  }, new ProjectRegistry(storage), new ApprovalRegistry(root), new McpConfigStore(root), new SkillStore(root, join(root, 'agents')), new InspectStore(root), runtime, root)
  // 本册按主请求序号投喂工具响应；辅助标题由独立册验证，不参与这个脚本序列。
  manager.titleSettings.set({ enabled: false })
  manager.syncCustomProviders([{ id: 'custom/mock', name: 'Mock', models: [], baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, modelDefs: [{ id: 'mock', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] }], [])
  sid = manager.create({ cwd: root }).id
})
afterEach(async () => { for (const release of releases) release(); manager.disposeAll(); await manager.outputs.drain(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
async function run() { manager.submit(sid, '交付文件', 'mock', 'off', 'custom/mock'); await vi.waitFor(() => expect(done).toBe(true), { timeout: 10000 }) }

describe('pi申报最终确认', () => {
  it('真实工具成功后持久发布，工具不是简单返回文本的假实现', async () => {
    await run()
    expect(toolErrors).toEqual([false]); expect(requests).toBe(2)
    expect((await manager.outputs.get(sid))[0]).toMatchObject({ state: 'ready', published: [{ name: 'report.txt' }] })
  })
  it('扩展最终判错不提交暂存，终态无产物卡', async () => {
    control.reject = true; await run()
    expect(toolErrors).toEqual([true]); expect(await manager.outputs.get(sid)).toEqual([])
  })
  it('扩展拦截不执行申报，更不会把候选路径记为交付', async () => {
    control.block = true
    const capture = vi.spyOn(manager.outputs.storage, 'capture')
    await run(); expect(capture).not.toHaveBeenCalled(); expect(await manager.outputs.get(sid)).toEqual([])
  })
  it('manifest不能提交时真实工具结果是失败，模型仍可按正常循环继续', async () => {
    vi.spyOn(manager.outputs.storage, 'commit').mockRejectedValueOnce(new Error('ENOSPC-test'))
    await run(); expect(toolErrors).toEqual([true]); expect(requests).toBe(2); expect(await manager.outputs.get(sid)).toEqual([])
  })
  it('收尾保存期间持续占用预约，停止不会撤销已确认申报或永久busy', async () => {
    const capture = manager.outputs.storage.capture.bind(manager.outputs.storage)
    let calls = 0
    let release!: () => void
    let entered = false
    const wait = new Promise<void>((resolve) => { release = resolve })
    releases.push(release)
    vi.spyOn(manager.outputs.storage, 'capture').mockImplementation(async (...args) => {
      if (++calls === 2) { entered = true; await wait }
      return capture(...args)
    })
    manager.submit(sid, '交付文件', 'mock', 'off', 'custom/mock')
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10000 })
    expect(done).toBe(false)
    expect(() => manager.submit(sid, '抢入下一轮')).toThrow('正在回复')
    manager.abort(sid); release()
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 10000 })
    expect((await manager.outputs.get(sid))[0].published).toHaveLength(1)
  }, 15000)
  it('结算落盘失败单独报错并退出保存态，不能把文件错误改称模型失败', async () => {
    const commit = manager.outputs.storage.commit.bind(manager.outputs.storage)
    let writes = 0
    vi.spyOn(manager.outputs.storage, 'commit').mockImplementation(async (...args) => {
      if (++writes === 2) throw new Error('finalize-ENOSPC')
      await commit(...args)
    })
    await run()
    expect(toolErrors).toEqual([false]); expect(outputErrors).toEqual(['finalize-ENOSPC'])
    expect(outputStates.at(-1)).toBe('interrupted')
    expect((await manager.outputs.get(sid))[0].published).toHaveLength(1)
  })
})
