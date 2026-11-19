/** 附件草稿与媒体绑定的 Host 真源；磁盘读取和 RPC 都在这里校验。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ATTACHMENT_LIMITS, isDirectoryRef, type DirectoryRef, type AttachmentMethods, type MediaBindings } from '../../shared/attachments'
import type { AttachmentService } from './attachments'

export function validateMediaBindings(value: unknown): asserts value is MediaBindings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('媒体绑定必须是对象')
  for (const [key, raw] of Object.entries(value)) {
    if (!['image', 'video', 'document'].includes(key) || typeof raw !== 'object' || raw === null) throw new Error('媒体绑定类型不合法')
    const b = raw as Record<string, unknown>
    for (const field of ['server', 'tool', 'pathArgument', 'questionArgument']) {
      if (typeof b[field] !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(b[field])) throw new Error(`媒体绑定 ${field} 必须是名称`)
    }
    if (b.pathArgument === b.questionArgument || (b.pagesArgument !== undefined &&
      (typeof b.pagesArgument !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(b.pagesArgument) ||
        b.pagesArgument === b.pathArgument || b.pagesArgument === b.questionArgument))) throw new Error('媒体参数映射重复或不合法')
    if (!Array.isArray(b.formats) || !b.formats.every((f) => typeof f === 'string' && /^\.[a-z0-9]+$/.test(f))) throw new Error('格式需为 .png 等扩展名数组')
    if (b.maxBytes !== undefined && (typeof b.maxBytes !== 'number' || !Number.isSafeInteger(b.maxBytes) || b.maxBytes <= 0)) throw new Error('媒体容量限制必须为正整数')
    if (b.audio !== undefined && typeof b.audio !== 'boolean') throw new Error('音轨声明必须为布尔值')
  }
}

export class AttachmentConfig {
  private directory: string
  constructor(root: string) { this.directory = join(root, 'attachments', 'v1'); mkdirSync(join(this.directory, 'drafts'), { recursive: true }) }
  private draftPath(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('草稿 id 不合法')
    return join(this.directory, 'drafts', `${id}.json`)
  }
  private write(path: string, data: unknown): void {
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(data)); renameSync(temp, path)
  }
  readDraft(id: string): { id: string; text: string; attachmentIds: string[]; directories?: DirectoryRef[] } {
    const path = this.draftPath(id)
    if (!existsSync(path)) return { id, text: '', attachmentIds: [] }
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const draft = raw as { version?: number; id?: string; text?: unknown; attachmentIds?: unknown; directories?: unknown }
    if (draft.version !== 1 || draft.id !== id) throw new Error('草稿版本或身份不合法')
    return this.validateDraft(draft)
  }
  validateDraft(value: unknown): { id: string; text: string; attachmentIds: string[]; directories?: DirectoryRef[] } {
    const p = value as { id?: unknown; text?: unknown; attachmentIds?: unknown; directories?: unknown }
    if (typeof p.id !== 'string' || typeof p.text !== 'string' || p.text.length > 1_000_000 ||
      !Array.isArray(p.attachmentIds) ||
      !p.attachmentIds.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))) throw new Error('草稿形状不合法')
    this.draftPath(p.id)
    if (p.directories !== undefined && (!Array.isArray(p.directories) || !p.directories.every(isDirectoryRef))) throw new Error('草稿文件夹引用不合法')
    return { id: p.id, text: p.text, attachmentIds: p.attachmentIds as string[],
      ...(p.directories !== undefined && { directories: p.directories }) }
  }
  saveDraft(value: unknown): void {
    const draft = this.validateDraft(value)
    this.write(this.draftPath(draft.id), { version: 1, ...draft })
  }
  references(id: string): boolean {
    return readdirSync(join(this.directory, 'drafts')).filter((name) => name.endsWith('.json'))
      .some((name) => this.readDraft(name.slice(0, -5)).attachmentIds.includes(id))
  }
  media(): MediaBindings {
    const path = join(this.directory, 'media.json')
    if (!existsSync(path)) return {}
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    validateMediaBindings(raw); return raw
  }
  saveMedia(value: unknown): void { validateMediaBindings(value); this.write(join(this.directory, 'media.json'), value) }
}

/** 壳专用方法注册表；HTTP/WS 在传输边界整体拒绝 attachments.*。 */
export function attachmentHandlers(service: AttachmentService, config: AttachmentConfig): Array<[keyof AttachmentMethods, (params: unknown) => unknown]> {
  const object = (raw: unknown): Record<string, unknown> => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('附件参数必须为对象')
    return raw as Record<string, unknown>
  }
  const string = (p: Record<string, unknown>, field: string): string => {
    if (typeof p[field] !== 'string') throw new Error(`附件 ${field} 必须为字符串`)
    return p[field]
  }
  return [
    ['attachments.describe', (raw) => service.describePath(string(object(raw), 'path'))],
    ['attachments.importPath', (raw) => {
      const p = object(raw); const path = string(p, 'path')
      return service.importPathOperation(p.operationId === undefined ? randomUUID() : string(p, 'operationId'), path)
    }],
    ['attachments.begin', (raw) => {
      const p = object(raw)
      if (typeof p.size !== 'number') throw new Error('附件 size 必须为数字')
      return { id: service.begin(string(p, 'name'), p.size, string(p, 'mime')) }
    }],
    ['attachments.chunk', async (raw) => {
      const p = object(raw); const base64 = string(p, 'base64')
      if (base64.length > Math.ceil(ATTACHMENT_LIMITS.chunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('附件分片不合法')
      await service.chunk(string(p, 'id'), Buffer.from(base64, 'base64')); return { ok: true }
    }],
    ['attachments.finish', (raw) => service.finish(string(object(raw), 'id'))],
    ['attachments.cancel', (raw) => { service.cancel(string(object(raw), 'id')); return { ok: true } }],
    ['attachments.release', (raw) => { service.release(string(object(raw), 'id'), (id) => config.references(id)); return { ok: true } }],
    ['attachments.resolve', (raw) => service.resolve(string(object(raw), 'id'))],
    ['attachments.draft', (raw) => {
      const d = config.readDraft(string(object(raw), 'id'))
      return { id: d.id, text: d.text, attachments: d.attachmentIds.map((id) => service.get(id)),
        ...(d.directories !== undefined && { directories: d.directories }) }
    }],
    ['attachments.saveDraft', (raw) => {
      const d = config.validateDraft(raw); d.attachmentIds.forEach((id) => service.get(id))
      const previous = config.readDraft(d.id); config.saveDraft(d)
      for (const id of previous.attachmentIds) if (!d.attachmentIds.includes(id)) service.release(id, (target) => config.references(target))
      return { ok: true }
    }],
    ['attachments.media', () => config.media()],
    ['attachments.saveMedia', (raw) => { config.saveMedia(object(raw).bindings); return { ok: true } }]
  ]
}
