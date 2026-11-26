/** 桌面本轮改动列表 RPC 参数校验入口；会话归属由调用方核对。 */
import { z } from 'zod'
import type { WorkspaceChangesService } from './service'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
const getSchema = z.object({ sessionId: id, turnId: id.optional() })
const diffSchema = z.object({
  sessionId: id,
  turnId: id,
  revision: z.number().int().positive(),
  changeId: z.string().regex(/^[a-f0-9]{16,64}$/)
})

export function changeHandlers(
  service: WorkspaceChangesService,
  requireSession: (sessionId: string) => void
): Array<[string, (raw: unknown) => unknown]> {
  return [
    ['changes.get', (raw) => {
      const p = getSchema.parse(raw)
      requireSession(p.sessionId)
      return service.get(p.sessionId, p.turnId)
    }],
    ['changes.diff', (raw) => {
      const p = diffSchema.parse(raw)
      requireSession(p.sessionId)
      return service.diff(p.sessionId, p.turnId, p.revision, p.changeId)
    }]
  ]
}
