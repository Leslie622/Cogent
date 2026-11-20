/** 文件 RPC 的唯一载荷校验边界；HTTP/WS 另在传输门整体拒绝此域。 */
import { FILE_LIMITS } from '../../../shared/files'
import type { FileService } from './reader'

function object(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('文件参数必须是对象')
  return raw as Record<string, unknown>
}
function string(p: Record<string, unknown>, key: string): string {
  const value = p[key]
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 32768 ||
    value.includes('\0')
  )
    throw new Error(`文件参数 ${key} 必须是有效字符串`)
  return value
}
function optional(p: Record<string, unknown>, key: string): string | undefined {
  return p[key] === undefined ? undefined : string(p, key)
}
function integer(p: Record<string, unknown>, key: string, max: number, min = 0): number {
  const value = p[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`文件参数 ${key} 超出范围`)
  return value
}
export function fileHandlers(service: FileService): Array<[string, (raw: unknown) => unknown]> {
  const handle = (p: Record<string, unknown>) => ({
    sessionId: string(p, 'sessionId'),
    fileId: string(p, 'fileId')
  })
  const read = (p: Record<string, unknown>) => ({
    ...handle(p),
    version: string(p, 'version'),
    operationId: string(p, 'operationId')
  })
  return [
    [
      'files.resolve',
      (raw) => {
        const p = object(raw)
        return service.resolve(
          string(p, 'sessionId'),
          string(p, 'rawTarget'),
          optional(p, 'turnId'),
          optional(p, 'relativeTo')
        )
      }
    ],
    ['files.actionTarget', (raw) => service.actionTarget(handle(object(raw)))],
    [
      'files.readText',
      (raw) => {
        const p = object(raw)
        return service.readText({
          ...read(p),
          ...(p.offset !== undefined && { offset: integer(p, 'offset', FILE_LIMITS.text) })
        })
      }
    ],
    [
      'files.readChunk',
      (raw) => {
        const p = object(raw)
        return service.readChunk({
          ...read(p),
          offset: integer(p, 'offset', FILE_LIMITS.binary),
          length: integer(p, 'length', FILE_LIMITS.chunk, 1)
        })
      }
    ],
    [
      'files.parseDocument',
      (raw) => {
        const p = object(raw)
        return service.parseDocument({
          ...read(p),
          cursor: integer(p, 'cursor', Number.MAX_SAFE_INTEGER),
          sheet: optional(p, 'sheet'),
          range: optional(p, 'range')
        })
      }
    ],
    [
      'files.cancel',
      (raw) => {
        const p = object(raw)
        return service.cancel(string(p, 'sessionId'), string(p, 'operationId'), optional(p, 'fileId'))
      }
    ]
  ]
}
