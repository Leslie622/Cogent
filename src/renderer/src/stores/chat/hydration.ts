/** 仅在快照请求在途时暂存事件；快照水位之后的事件重放，避免旧历史覆盖实时消息。 */
import type { EngineEvent } from '@/env.d'
const loads = new Map<string, { owner: symbol; events: EngineEvent[]; overflow: boolean }>()
let replay: ((event: EngineEvent) => void) | undefined
export function setHistoryReplay(handler: (event: EngineEvent) => void): void { replay = handler }
export function beginHistory(sessionId: string, owner: symbol): void { loads.set(sessionId, { owner, events: [], overflow: false }) }
export function rememberDuringHistory(event: EngineEvent): void {
  if (!('sessionId' in event.params)) return
  const load = loads.get(event.params.sessionId)
  if (!load) return
  if (load.events.length >= 4096) { load.overflow = true; return }
  load.events.push(event)
}
export function finishHistory(sessionId: string, owner: symbol, watermark?: number): boolean {
  const load = loads.get(sessionId)
  if (!load || load.owner !== owner) return false
  loads.delete(sessionId)
  if (load.overflow) return false
  for (const event of load.events) if (watermark === undefined || event.sequence === undefined || event.sequence > watermark) replay?.(event)
  return true
}
export function cancelHistory(sessionId: string, owner?: symbol): void {
  if (owner === undefined || loads.get(sessionId)?.owner === owner) loads.delete(sessionId)
}
