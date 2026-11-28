/** 启动失败的诊断必须穿过 main 代理保留下来，并收掉进程与并发请求。 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostManager } from '../../../../src/electron/main/host/manager'
import { McpCredentialStore } from '../../../../src/electron/main/credentials/mcp-store'

const { spawn, cipher } = vi.hoisted(() => ({ spawn: vi.fn(), cipher: {
  isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: vi.fn(() => 'keychain'),
  decryptString: vi.fn((value: Buffer) => value.toString().slice(7))
} }))
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('electron', () => ({ safeStorage: cipher }))
vi.mock('../../../../src/electron/main/storage-root', () => ({ storageRoot: () => '/unused' }))

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
    cipher.isEncryptionAvailable.mockReturnValue(true)
    cipher.getSelectedStorageBackend.mockReturnValue('keychain')
    cipher.decryptString.mockImplementation((value: Buffer) => value.toString().slice(7))
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
    vi.unstubAllGlobals()
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

  it.each(['JSON损坏', '解密失败', '安全存储不可用', 'basic_text后端'])('MCP凭据%s不阻断Host启动握手，保留原文件与故障诊断', async (failure) => {
    const root = mkdtempSync(join(tmpdir(), 'cogent-mcp-startup-'))
    try {
      const path = join(root, 'mcp-credentials.json')
      const content = failure === 'JSON损坏' ? '{bad-json' : JSON.stringify({ version: 1,
        oauthStates: { old: Buffer.from('cipher:{"serverUrl":"https://mcp.example"}').toString('base64') } })
      writeFileSync(path, content)
      if (failure === '解密失败') cipher.decryptString.mockImplementationOnce(() => { throw new Error('DPAPI 解密失败') })
      if (failure === '安全存储不可用') cipher.isEncryptionAvailable.mockReturnValue(false)
      if (failure === 'basic_text后端') {
        vi.stubGlobal('process', { ...process, platform: 'linux' })
        cipher.getSelectedStorageBackend.mockReturnValue('basic_text')
      }
      const store = new McpCredentialStore(root)
      host = new HostManager({ entryPath: '/app/host.js', nodeBin: '/runtime/node', readMcpCredentials: () => store.readAll() })
      const frames: Array<{ id: number; params: unknown }> = []
      child.stdin.on('data', (line: Buffer) => frames.push(JSON.parse(line.toString()) as typeof frames[number]))
      const starting = host.start()
      expect(frames[0].params).toMatchObject({ mcpOAuthStates: {} })
      expect(frames[0].params).not.toHaveProperty('mcpSecrets')
      child.stdout.write(JSON.stringify({ id: frames[0].id, result: { node: 'v22.23.5' } }) + '\n')
      await starting
      expect(host.getStatus().state).toBe('running')
      expect(child.kill).not.toHaveBeenCalled()
      expect(store.status().error).not.toBeNull()
      expect(readFileSync(path, 'utf8')).toBe(content)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('MCP OAuth快照与启动期变更按提交顺序交接，普通请求等待新凭据生效', async () => {
    let latest = { oauthStates: { server: { token: 'old' } } }
    host = new HostManager({ entryPath: '/app/host.js', nodeBin: '/runtime/node',
      readMcpCredentials: () => latest })
    const frames: Array<{ id: number; method: string; params: unknown }> = []
    child.stdin.on('data', (line: Buffer) => frames.push(JSON.parse(line.toString()) as typeof frames[number]))
    const reply = (index: number, result: unknown = { ok: true }) => child.stdout.write(JSON.stringify({ id: frames[index].id, result }) + '\n')
    const starting = host.start()
    expect(frames[0].params).toMatchObject({ mcpOAuthStates: { server: { token: 'old' } } })
    latest = { oauthStates: { server: { token: 'new' } } }
    const changed = host.applyMcpCredentials(latest)
    const listed = host.request('session.list', {})
    reply(0, { node: 'v22.23.5' })
    await vi.advanceTimersByTimeAsync(0)
    expect(frames[1]).toMatchObject({ method: 'mcp.secrets.sync', params: { oauthStates: { server: { token: 'new' } } } })
    expect(host.getStatus().state).toBe('starting')
    reply(1); await changed; await starting; await vi.advanceTimersByTimeAsync(0)
    expect(frames[2].method).toBe('session.list')
    reply(2, []); expect(await listed).toEqual([])
  })

  it('等待握手时新增OAuth状态不被旧快照清空，登出的删除仍生效', async () => {
    let latest: { oauthStates: Record<string, unknown> } = { oauthStates: { first: { token: 'old' } } }
    host = new HostManager({ entryPath: '/app/host.js', nodeBin: '/runtime/node', readMcpCredentials: () => latest })
    const frames: Array<{ id: number; method: string; params: unknown }> = []
    child.stdin.on('data', (line: Buffer) => frames.push(JSON.parse(line.toString()) as typeof frames[number]))
    const reply = (index: number, result: unknown = { ok: true }) => child.stdout.write(JSON.stringify({ id: frames[index].id, result }) + '\n')
    const starting = host.start()
    latest = { oauthStates: { first: { token: 'new' } } }
    const changed = host.applyMcpCredentials(latest)
    // 模拟initialize期间另一条OAuth保存链已在main提交，旧排队载荷仍没有该状态。
    latest = { oauthStates: { ...latest.oauthStates, second: { token: 'authorized' } } }
    reply(0, { node: 'v22.23.5' })
    await vi.advanceTimersByTimeAsync(0)
    expect(frames[1]).toMatchObject({ method: 'mcp.secrets.sync', params: { oauthStates: { first: { token: 'new' }, second: { token: 'authorized' } } } })
    reply(1); await changed; await starting
    latest = { oauthStates: { second: { token: 'authorized' } } }
    const removed = host.applyMcpCredentials(latest)
    await vi.advanceTimersByTimeAsync(0)
    expect(frames[2]).toMatchObject({ method: 'mcp.secrets.sync', params: { oauthStates: { second: { token: 'authorized' } } } })
    expect((frames[2].params as { oauthStates: Record<string, unknown> }).oauthStates).not.toHaveProperty('first')
    reply(2); await removed
  })

  it('MCP OAuth私有事件不广播，保存确认不等待握手且拒绝旧代确认', async () => {
    const frames: Array<{ id: number; method: string }> = []
    child.stdin.on('data', (line: Buffer) => frames.push(JSON.parse(line.toString()) as typeof frames[number]))
    const renderer = vi.fn(), privateEvents = vi.fn()
    host.setEventSink(renderer)
    host.setMcpEventSink(privateEvents)
    const starting = host.start()
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'mcp.oauth.persistState', params: { requestId: 'save-1', key: 'synthetic', state: { serverUrl: 'https://mcp.example' } } }) + '\n')
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'mcp.oauth.openUrl', params: { loginId: 'login-1', url: 'https://auth.example' } }) + '\n')
    expect(privateEvents).toHaveBeenCalledTimes(2)
    expect(renderer).not.toHaveBeenCalled()
    const confirmation = host.confirmMcpPersistence({ requestId: 'save-1' }, host.getGeneration())
    expect(frames[1].method).toBe('mcp.oauth.persistResult')
    child.stdout.write(JSON.stringify({ id: frames[1].id, result: { ok: true } }) + '\n')
    await confirmation
    child.stdout.write(JSON.stringify({ id: frames[0].id, result: { node: 'v22.23.5' } }) + '\n')
    await starting
    await expect(host.confirmMcpPersistence({ requestId: 'save-1' }, host.getGeneration() - 1)).rejects.toThrow('host closed')
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
