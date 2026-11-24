/** 同一会话连续运行时，MCP 只能认领本次 run 的终态，兼顾受理回包前完成。 */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
const { sockets } = vi.hoisted(() => ({ sockets: [] as EventEmitter[] }))
vi.mock('ws', () => ({ WebSocket: class extends EventEmitter {
  static OPEN = 1
  readyState = 1
  constructor() { super(); sockets.push(this) }
  close() { this.emit('close') }
} }))
vi.mock('../../../src/host/mcp-server/config', () => ({ readAccess: () => ({ port: 1234, token: 'synthetic' }), REQUEST_TIMEOUT_MS: 1000 }))
import { subscribeRun } from '../../../src/host/mcp-server/host-client'
afterEach(() => { sockets.length = 0; vi.useRealTimers() })
function terminal(runId: string, text: string) {
  sockets.at(-1)!.emit('message', Buffer.from(JSON.stringify({ method: 'run.completed', params: { sessionId: 's', runId, message: { content: text } } })))
}
it('受理响应前完成也可认领，前一 run 的终态不抢走本次结果', async () => {
  const subscription = subscribeRun('s')
  await subscription.ready()
  terminal('old', '旧结果')
  terminal('new', '新结果')
  subscription.bindRun('new')
  expect(await subscription.awaitOutcome(1000, undefined)).toMatchObject({ state: 'completed', message: { content: '新结果' } })
})
it('绑定后仍忽略其它 run，断线只报告结果未知', async () => {
  const subscription = subscribeRun('s')
  subscription.bindRun('new')
  terminal('old', '旧结果')
  sockets.at(-1)!.emit('close')
  expect(await subscription.awaitOutcome(1000, undefined)).toEqual({ state: 'timeout' })
})
