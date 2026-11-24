/** pi dispose 不发送 session_shutdown；先取消并排空扩展，再释放实例，调用可重入。 */
import type { AgentSession } from '@earendil-works/pi-coding-agent'
const closing = new WeakMap<AgentSession, Promise<void>>()
export function shutdownPiSession(session: AgentSession): Promise<void> {
  const existing = closing.get(session)
  if (existing) return existing
  const done = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const drain = async () => {
      await session.abort()
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    }
    try {
      await Promise.race([drain(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('pi 清理超过 4 秒')), 4_000) })])
    } finally { clearTimeout(timer); session.dispose() }
  })()
  closing.set(session, done)
  return done
}
