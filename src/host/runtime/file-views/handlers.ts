/** stdio 文件视图边界；windowId 只能由 main 私有通道注入，HTTP/WS 整域拒绝。 */
import type { FileViewPreviewPolicy, FileViewRoot, FileViewSource } from '../../../shared/file-views'
import { FILE_LIMITS } from '../../../shared/files'
import type { FileViewsService } from './service'
export function fileViewObject(raw: unknown): Record<string, unknown> { if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('文件视图参数必须是对象'); return raw as Record<string, unknown> }
export function fileViewString(p: Record<string, unknown>, key: string, allowEmpty = false): string { const value = p[key]; if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 32768 || value.includes('\0')) throw new Error(`文件视图参数 ${key} 不合法`); return value }
const optional = (p: Record<string, unknown>, key: string) => p[key] === undefined ? undefined : fileViewString(p, key)
const integer = (p: Record<string, unknown>, key: string, max = Number.MAX_SAFE_INTEGER, min = 0) => { const value = p[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`文件视图参数 ${key} 超出范围`); return value }
const boolean = (p: Record<string, unknown>, key: string) => { if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error(`文件视图参数 ${key} 必须为布尔值`); return p[key] }
export function fileViewSource(raw: unknown): FileViewSource {
  const p = fileViewObject(raw)
  if (p.kind === 'session') return { kind: 'session', sessionId: fileViewString(p, 'sessionId'), rawTarget: fileViewString(p, 'rawTarget'), turnId: optional(p, 'turnId'), relativeTo: optional(p, 'relativeTo') }
  if (p.kind === 'context') return { kind: 'context', contextId: fileViewString(p, 'contextId'), path: fileViewString(p, 'path'), relativeTo: optional(p, 'relativeTo') }
  if (p.kind === 'output') {
    const target = fileViewObject(p.target)
    if (target.version !== 'delivery' && target.version !== 'current') throw new Error('产物版本类型不合法')
    return { kind: 'output', target: { sessionId: fileViewString(target, 'sessionId'), turnId: fileViewString(target, 'turnId'), outputId: fileViewString(target, 'outputId'), revision: integer(target, 'revision'), version: target.version } }
  }
  throw new Error('文件来源类型不合法')
}
export function fileViewHandlers(service: FileViewsService): Array<[string, (raw: unknown) => unknown]> {
  const base = (raw: unknown, checkEpoch = true) => {
    const p = fileViewObject(raw); const windowId = integer(p, 'windowId', Number.MAX_SAFE_INTEGER, 1)
    if (checkEpoch && p.windowEpoch !== undefined) service.validateWindowEpoch(windowId, integer(p, 'windowEpoch'))
    return { p, windowId }
  }
  const read = (p: Record<string, unknown>) => ({ leaseId: fileViewString(p, 'leaseId'), version: fileViewString(p, 'version'), operationId: fileViewString(p, 'operationId') })
  return [
    ['fileViews.registerContext', (raw) => {
      const { p, windowId } = base(raw)
      if (!Array.isArray(p.roots) || p.roots.length > 64) throw new Error('文件根列表不合法')
      const roots: FileViewRoot[] = p.roots.map((rawRoot) => { const root = fileViewObject(rawRoot); if (root.kind !== 'directory' && root.kind !== 'file') throw new Error('文件根类型不合法'); return { id: fileViewString(root, 'id'), path: fileViewString(root, 'path'), name: fileViewString(root, 'name'), kind: root.kind, grantId: optional(root, 'grantId') } })
      return service.registerContext(windowId, fileViewString(p, 'scopeId'), roots)
    }],
    ['fileViews.closeContext', (raw) => { const { p, windowId } = base(raw); return service.closeContext(windowId, fileViewString(p, 'contextId')) }],
    ['fileViews.releaseWindow', (raw) => service.releaseWindow(base(raw).windowId)],
    ['fileViews.resetWindow', (raw) => { const { p, windowId } = base(raw, false); return service.resetWindow(windowId, integer(p, 'windowEpoch')) }],
    ['fileViews.acquire', (raw) => { const { p, windowId } = base(raw); return service.acquire(windowId, fileViewSource(p.source), fileViewString(p, 'operationId')) }],
    ['fileViews.cloneLease', (raw) => { const { p, windowId } = base(raw); return service.cloneLease(windowId, fileViewString(p, 'leaseId')) }],
    ['fileViews.previewResource', (raw) => {
      const { p, windowId } = base(raw); let policy: FileViewPreviewPolicy | undefined
      if (p.policy !== undefined) {
        const value = fileViewObject(p.policy), root = fileViewObject(value.root)
        if (!Array.isArray(value.blockedRoots) || value.blockedRoots.length > 16) throw new Error('网页保护目录不合法')
        policy = { root: { path: fileViewString(root, 'path'), realPath: fileViewString(root, 'realPath') }, blockedRoots: value.blockedRoots.map(path => fileViewString({ path }, 'path')) }
      }
      return service.previewResource(windowId, fileViewString(p, 'leaseId'), fileViewString(p, 'relativePath', true), policy)
    }],
    ['fileViews.release', (raw) => { const { p, windowId } = base(raw); return service.release(windowId, fileViewString(p, 'leaseId')) }],
    ['fileViews.cancel', (raw) => { const { p, windowId } = base(raw); return service.cancel(windowId, fileViewString(p, 'operationId'), optional(p, 'contextId')) }],
    ['fileViews.readText', (raw) => { const { p, windowId } = base(raw); return service.readText(windowId, { ...read(p), ...(p.offset === undefined ? {} : { offset: integer(p, 'offset', FILE_LIMITS.text) }) }) }],
    ['fileViews.readChunk', (raw) => { const { p, windowId } = base(raw); return service.readChunk(windowId, { ...read(p), offset: integer(p, 'offset', FILE_LIMITS.binary), length: integer(p, 'length', FILE_LIMITS.chunk, 1) }) }],
    ['fileViews.parseDocument', (raw) => { const { p, windowId } = base(raw); return service.parseDocument(windowId, { ...read(p), cursor: integer(p, 'cursor'), sheet: optional(p, 'sheet'), range: optional(p, 'range') }) }],
    ['fileViews.listDirectory', (raw) => { const { p, windowId } = base(raw); return service.listDirectory({ windowId, contextId: fileViewString(p, 'contextId'), directoryId: fileViewString(p, 'directoryId'), cursor: optional(p, 'cursor'), operationId: fileViewString(p, 'operationId'), refresh: boolean(p, 'refresh'), ...(p.limit === undefined ? {} : { limit: integer(p, 'limit', 500, 1) }) }) }],
    ['fileViews.search', (raw) => { const { p, windowId } = base(raw); return service.search({ windowId, contextId: fileViewString(p, 'contextId'), query: fileViewString(p, 'query', true), includeIgnored: boolean(p, 'includeIgnored'), cursor: optional(p, 'cursor'), operationId: fileViewString(p, 'operationId'), ...(p.limit === undefined ? {} : { limit: integer(p, 'limit', 500, 1) }) }) }],
    ['fileViews.actionTarget', (raw) => { const { p, windowId } = base(raw); return service.actionTarget(windowId, fileViewString(p, 'leaseId'), boolean(p, 'current')) }]
  ]
}
