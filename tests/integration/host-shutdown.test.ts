/** 真实 Host、pi、shell 与 stdio MCP 进程在运行/等待审批时的退出合同。 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { SessionSummary } from '../../src/protocol'
import { chunk, closeLoopback, initEngine, listenLoopback, makeTempDir, removeDir, sse, startEngine } from './harness'

// 文件存在时写入可能尚未完成；空串转成 0 会让清理误杀当前测试进程。
const readPid = (path: string): Promise<number> => vi.waitFor(() => {
  expect(existsSync(path)).toBe(true)
  const pid = Number(readFileSync(path, 'utf8').trim())
  expect(Number.isSafeInteger(pid)).toBe(true)
  expect(pid).toBeGreaterThan(0)
  expect(pid).not.toBe(process.pid)
  return pid
}, { timeout: 10_000 })

it.each(['ask', 'auto'] as const)('%s：退出收尾当前运行、MCP 连接与真实工具进程，不再受理新任务', async mode => {
  const home = makeTempDir('cogent-shutdown-'), shellPidFile = join(home, 'shell.pid'), mcpPidFile = join(home, 'mcp.pid')
  const windows = process.platform === 'win32'
  const command = windows
    ? `Set-Content -LiteralPath '${shellPidFile.replaceAll("'", "''")}' -Value $PID; Start-Sleep -Seconds 60`
    : `printf '%s' "$$" > '${shellPidFile.replaceAll("'", "'\\''")}'; sleep 60`
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sse(chunk({ tool_calls: [{ index: 0, id: 'shell', type: 'function', function: {
        name: windows ? 'powershell' : 'bash', arguments: JSON.stringify({ command })
      } }] })) + sse(chunk({}, 'tool_calls')) + 'data: [DONE]\n\n')
    })
  })
  const engine = startEngine(home)
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  let shellPid: number | undefined, mcpPid: number | undefined
  try {
    const port = await listenLoopback(server)
    await initEngine(engine, { client: 'shutdown-test', providers: [{ id: 'custom/mock', name: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['mock'] }] })
    expect((await engine.send('mcp.sync', { servers: [{ name: 'lifecycle', type: 'stdio', command: process.execPath,
      args: [resolve('tests/integration/mock-mcp-server.mjs')], env: { COGENT_TEST_PID_FILE: mcpPidFile }, exposure: 'direct' }] })).error).toBeUndefined()
    const session = (await engine.send<SessionSummary>('session.create', { cwd: home, permissionMode: mode })).result!
    const accepted = await engine.send<{ runId: string }>('agent.submit', { sessionId: session.id, text: '隔离退出回归', model: 'mock' })
    await engine.waitEvent(mode === 'ask' ? 'approval.request' : 'tool.started', params => params.sessionId === session.id)
    mcpPid = await readPid(mcpPidFile)
    expect(alive(mcpPid)).toBe(true)
    if (mode === 'auto') {
      shellPid = await readPid(shellPidFile)
      expect(alive(shellPid)).toBe(true)
    }
    expect((await engine.send('host.shutdown', {}, 10_000)).result).toEqual({ ok: true })
    const terminal = await engine.waitEvent('run.failed', params => params.sessionId === session.id)
    expect(terminal.params).toMatchObject({ runId: accepted.result!.runId, reason: 'aborted' })
    expect((await engine.send('session.create', {})).error?.message).toContain('正在退出')
    await vi.waitFor(() => {
      expect(alive(mcpPid!)).toBe(false)
      if (shellPid !== undefined) expect(alive(shellPid)).toBe(false)
    }, { timeout: 5000 })
  } finally {
    await engine.stop(); await closeLoopback(server)
    for (const pid of [shellPid, mcpPid]) if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL')
    removeDir(home)
  }
})
