/** renderer 呈现队列：会话隔离、首片起拍而非 debounce；屏障同步排空，取消后无尾拍复活。 */
import type { EngineEvent } from '@/env.d'

export type MessageDelta = Extract<EngineEvent, { method: 'message.delta' }>['params']

export function createDeltaBatcher(publish: (sessionId: string, deltas: MessageDelta[]) => void) {
  const pending = new Map<string, { deltas: MessageDelta[]; timer: ReturnType<typeof setTimeout> }>()

  function discard(sessionId: string): void {
    const batch = pending.get(sessionId)
    if (batch === undefined) return
    clearTimeout(batch.timer)
    pending.delete(sessionId)
  }

  function flush(sessionId: string): void {
    const batch = pending.get(sessionId)
    if (batch === undefined) return
    // 发布前交还所有权：store 订阅的替换检查与重入不会重放本批。
    discard(sessionId)
    publish(sessionId, batch.deltas)
  }

  return {
    enqueue(delta: MessageDelta): void {
      const batch = pending.get(delta.sessionId)
      if (batch !== undefined) {
        batch.deltas.push(delta)
        return
      }
      pending.set(delta.sessionId, {
        deltas: [delta],
        timer: setTimeout(() => flush(delta.sessionId), 30)
      })
    },
    flush,
    discard,
    flushAll(): void {
      for (const sessionId of pending.keys()) flush(sessionId)
    },
    discardChanged(changed: (sessionId: string) => boolean): void {
      for (const sessionId of pending.keys()) {
        if (changed(sessionId)) discard(sessionId)
      }
    }
  }
}
