/** 启动失败的诊断必须穿过 main 代理保留下来，并收掉进程与并发请求。 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostManager } from '../../../../src/electron/main/host/manager'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))

function makeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  })
}

describe('HostManager 启动诊断', () => {
  let child: ReturnType<typeof makeChild>
  let host: HostManager

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    child = makeChild()
    spawn.mockReturnValue(child)
    host = new HostManager({ entryPath: '/app/host.js', nodeBin: '/runtime/node' })
  })

  afterEach(() => {
    void host.stop()
    child.emit('exit', 0)
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('超时带最后启动阶段，拒绝并发请求时保留原因，并结束子进程', async () => {
    const started = host.start().catch((error: unknown) => error)
    const pending = host.request('session.list', {}).catch((error: unknown) => error)
    child.stderr.write('[startup] +20ms 加载 Host 模块\n')
    child.stderr.write('[startup] +80ms 初始化模型运行时\n其他诊断\n')
    await vi.advanceTimersByTimeAsync(60_000)
    const message = '引擎握手超时（60000ms）；最后阶段：[startup] +80ms 初始化模型运行时'
    expect(await started).toEqual(new Error(message))
    expect(await pending).toEqual(new Error(message))
    expect(child.kill).toHaveBeenCalledOnce()
    expect(host.getStatus()).toEqual({ state: 'failed', nodeVersion: null, error: message })
    child.emit('exit', null)
    expect(host.getStatus().state).toBe('failed')
  })

  it('Host 尚未输出日志时明确区分，不伪造初始化阶段', async () => {
    const started = host.start().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await started).toEqual(new Error('引擎握手超时（60000ms）；最后阶段：尚未收到 Host 启动阶段日志'))
  })

  it('正常握手清除计时器，stderr 阶段日志不干扰响应', async () => {
    const started = host.start()
    child.stderr.write('[startup] +100ms initialize 完成\n')
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { node: 'v22.23.5', httpPort: 12345 } }) + '\n')
    await started
    await vi.advanceTimersByTimeAsync(15_000)
    expect(host.getStatus()).toEqual({ state: 'running', nodeVersion: 'v22.23.5', error: null })
    expect(host.getHttpPort()).toBe(12345)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('冷依赖加载超过旧的 15 秒窗口仍能就绪，并保留排队请求', async () => {
    const started = host.start()
    const listed = host.request('session.list', {})
    child.stderr.write('[startup] +192ms 加载 Host 模块\n')
    await vi.advanceTimersByTimeAsync(42_000)
    expect(host.getStatus().state).toBe('starting')
    expect(child.kill).not.toHaveBeenCalled()
    child.stdout.write(JSON.stringify({ id: 1, result: { node: 'v22.23.5' } }) + '\n')
    await started
    await Promise.resolve()
    child.stdout.write(JSON.stringify({ id: 2, result: { sessions: [] } }) + '\n')
    expect(await listed).toEqual({ sessions: [] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.getStatus().state).toBe('running')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('启动进程出错时立即失败，不等冷启动预算耗尽', async () => {
    const started = host.start().catch((error: unknown) => error)
    child.emit('error', new Error('spawn ENOENT'))
    expect(await started).toEqual(new Error('host closed: spawn ENOENT'))
    expect(host.getStatus().state).toBe('failed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('启动期的新增、替换、删除逐项应用，普通请求等到凭据交接完成', async () => {
    host = new HostManager({ entryPath: '/app/host.js', nodeBin: '/runtime/node', readCredentials: () => ({ test: { apiKey: 'old' } }) })
    const frames: Array<{ id: number; method: string; params: unknown }> = []
    child.stdin.on('data', (line: Buffer) => frames.push(JSON.parse(line.toString()) as typeof frames[number]))
    const reply = (index: number, result: unknown = { ok: true }) => child.stdout.write(JSON.stringify({ id: frames[index].id, result }) + '\n')
    const starting = host.start()
    expect(frames[0].params).toMatchObject({ credentials: { test: { apiKey: 'old' } } })
    const first = host.applyCredential('test', 'new')
    const second = host.applyCredential('other', 'added')
    const third = host.applyCredential('test')
    const listed = host.request('session.list', {})
    expect(frames.map(frame => frame.method)).toEqual(['initialize'])
    reply(0, { node: 'v22.23.5' })
    await vi.advanceTimersByTimeAsync(0)
    expect(frames[1]).toMatchObject({ method: 'credentials.set', params: { providerId: 'test', apiKey: 'new' } })
    expect(host.getStatus().state).toBe('starting')
    reply(1); await first; await vi.advanceTimersByTimeAsync(0)
    expect(frames[2]).toMatchObject({ method: 'credentials.set', params: { providerId: 'other', apiKey: 'added' } })
    reply(2); await second; await vi.advanceTimersByTimeAsync(0)
    expect(frames[3]).toMatchObject({ method: 'credentials.remove', params: { providerId: 'test' } })
    reply(3); await third; await starting; await vi.advanceTimersByTimeAsync(0)
    expect(frames[4].method).toBe('session.list')
    reply(4, []); expect(await listed).toEqual([])
  })

  it('旧进程迟到退出与回包不能关闭新进程，每次启动现读凭据', async () => {
    const readCredentials = vi.fn(() => ({ test: { apiKey: 'current' } }))
    host = new HostManager({ entryPath: '/app/host.js', nodeBin: '/runtime/node', readCredentials })
    const first = host.start().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await first).toBeInstanceOf(Error)
    const old = child
    child = makeChild(); spawn.mockReturnValue(child)
    const frames: Array<{ id: number }> = []
    child.stdin.on('data', (line: Buffer) => frames.push(JSON.parse(line.toString()) as typeof frames[number]))
    const starting = host.start()
    old.emit('exit', 1)
    old.stdout.write(JSON.stringify({ id: frames[0].id, result: { node: 'v1.0.0' } }) + '\n')
    child.stdout.write(JSON.stringify({ id: frames[0].id, result: { node: 'v22.23.5' } }) + '\n')
    await starting
    expect(readCredentials).toHaveBeenCalledTimes(2)
    expect(host.getStatus().state).toBe('running')
    expect(child.kill).not.toHaveBeenCalled()
    old.stdin.destroy(); old.stdout.destroy(); old.stderr.destroy()
  })

  it('正常停止先发私有清理请求，收到确认后才结束子进程', async () => {
    const frames: Array<{ id: number; method: string }> = []
    child.stdin.on('data', (line: Buffer) => frames.push(JSON.parse(line.toString()) as typeof frames[number]))
    const starting = host.start()
    child.stdout.write(JSON.stringify({ id: frames[0].id, result: { node: 'v22.23.5' } }) + '\n')
    await starting
    const stopping = host.stop()
    expect(frames.at(-1)!.method).toBe('host.shutdown')
    expect(child.kill).not.toHaveBeenCalled()
    child.stdout.write(JSON.stringify({ id: frames.at(-1)!.id, result: { ok: true } }) + '\n')
    await stopping
    expect(child.kill).toHaveBeenCalledOnce()
    expect(host.getStatus().state).toBe('stopped')
  })
})
