/** 桌面产物 RPC 的唯一参数校验入口；归属与版本由服务核对。 */
import { z } from 'zod'
import type { OutputsService } from './service'
import type { FileService } from '../files/reader'
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
const get = z.object({ sessionId: id, turnId: id.optional() })
const target = z.object({ sessionId: id, turnId: id, revision: z.number().int().positive(), outputId: id, version: z.enum(['delivery', 'current']) })
export function outputHandlers(service: OutputsService, files: FileService, requireSession: (sessionId: string) => void): Array<[string, (raw: unknown) => unknown]> {
  return [
    ['outputs.get', (raw) => { const p = get.parse(raw); requireSession(p.sessionId); return service.get(p.sessionId, p.turnId) }],
    ['outputs.resolve', (raw) => { const p = target.parse(raw); requireSession(p.sessionId); return service.resolve(p, files) }]
  ]
}
