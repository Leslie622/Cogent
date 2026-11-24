/** 退出须先取消、等扩展清理；超时也释放实例，并且只执行一次。 */
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { shutdownPiSession } from '../../../src/host/kernel/pi-lifecycle'
afterEach(() => vi.useRealTimers())
it('可重入，清理扩展结束前不 dispose', async () => {
  let release!: () => void
  const emit = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const session = { abort: vi.fn().mockResolvedValue(undefined), extensionRunner: { emit }, dispose: vi.fn() }
  const pending = shutdownPiSession(session as unknown as AgentSession)
  expect(shutdownPiSession(session as unknown as AgentSession)).toBe(pending)
  await Promise.resolve()
  expect(emit).toHaveBeenCalledWith({ type: 'session_shutdown', reason: 'quit' })
  expect(session.dispose).not.toHaveBeenCalled()
  release(); await pending
  expect(session.dispose).toHaveBeenCalledOnce()
})
it('扩展挂起时有界失败，仍然释放实例', async () => {
  vi.useFakeTimers()
  const session = { abort: vi.fn().mockResolvedValue(undefined), extensionRunner: { emit: () => new Promise(() => {}) }, dispose: vi.fn() }
  const pending = shutdownPiSession(session as unknown as AgentSession)
  const assertion = expect(pending).rejects.toThrow('超过 4 秒')
  await vi.advanceTimersByTimeAsync(4_000)
  await assertion
  expect(session.dispose).toHaveBeenCalledOnce()
})
