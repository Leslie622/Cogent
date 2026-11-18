/** 重命名走真 Host：入口校验、摘要广播、重启恢复及手动默认标题保护。 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { makeTempDir, removeDir, startEngine, type EngineHandle } from './harness'
import type { SessionSummary } from '../../src/protocol'

let home: string
let engine: EngineHandle
beforeAll(async () => {
  home = makeTempDir('cogent-rename-')
  engine = startEngine(home)
  await engine.send('initialize', { client: 'rename-test', protocolVersion: 1 })
})
afterAll(() => { engine.kill(); removeDir(home) })

it('手动标题落盘并广播，重命名不改活动时间，重启可恢复', async () => {
  const created = await engine.send<SessionSummary>('session.create', {})
  const session = created.result!
  const renamed = await engine.send<{ summary: SessionSummary }>('session.rename', { sessionId: session.id, title: '  手动名称  ' })
  expect(renamed.error).toBeUndefined()
  expect(renamed.result?.summary).toEqual({ ...session, title: '手动名称', titleManual: true })
  const event = await engine.waitEvent('session.summaryChanged')
  expect(event.params.summary).toEqual(renamed.result?.summary)
  engine.kill()
  engine = startEngine(home)
  await engine.send('initialize', { client: 'rename-test', protocolVersion: 1 })
  const restored = await engine.send<SessionSummary[]>('session.list')
  expect(restored.result).toContainEqual(renamed.result?.summary)

  // 用户刻意命名为默认文案时，首条提交也不能把它替换为消息摘要。
  await engine.send('session.rename', { sessionId: session.id, title: '新会话' })
  await engine.send('agent.submit', { sessionId: session.id, text: '不应变成标题的首条消息' })
  const listed = await engine.send<SessionSummary[]>('session.list')
  expect(listed.result?.find((s) => s.id === session.id)?.title).toBe('新会话')
})

it.each(['', '   ', '第一行\n第二行', 123, null])('非法标题 %j 返回参数错误', async (title) => {
  const response = await engine.send('session.rename', { sessionId: 'any', title })
  expect(response.error?.code).toBe(-32602)
})

it('不存在的会话明确失败', async () => {
  const response = await engine.send('session.rename', { sessionId: 'missing', title: '新标题' })
  expect(response.error?.message).toContain('会话不存在')
})
