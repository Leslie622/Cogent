/** 仅给经过桌面文件服务复核的 HTML 授权静态目录；不开放 file:// 或整个工作区。 */
import { randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, relative, sep } from 'node:path'
import { protocol, type Session } from 'electron'
import type { FileViewPreviewPolicy } from '../../../shared/file-views'
import { checkPreviewResource, createPreviewPolicy } from '../file-views/preview-policy'
import { BLOCKED_PREVIEW_NAMES } from './policy'

export function registerBrowserScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'cogent-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
}
export function containedFile(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '' && !isAbsolute(path) && !path.split(sep).includes('..')
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
}
export interface BrowserPreviewSource { kind: 'current' | 'delivery'; path: string; entryPath?: string; policy?: FileViewPreviewPolicy; readResource: (relativePath: string) => Promise<{ bytes: Uint8Array; mime: string }>; release: () => Promise<void> }
interface Grant { owner: string; entryPath: string; policy?: FileViewPreviewPolicy; provider: BrowserPreviewSource }
export class BrowserLocalPreview {
  readonly hosts = new Set<string>()
  private readonly grants = new Map<string, Grant>()
  install(session: Session): void {
    session.protocol.handle('file', () => Response.error())
    session.protocol.handle('cogent-preview', request => this.respond(request))
  }
  async authorizeSource(owner: string, source: BrowserPreviewSource): Promise<string> {
    if (!/\.html?$/i.test(source.path)) throw new Error('网页预览仅支持本地 HTML 文件')
    const current = source.kind === 'current'
      ? source.policy === undefined ? await createPreviewPolicy(source.path) : { policy: source.policy, entryPath: source.entryPath ?? relative(source.policy.root.realPath, source.path).split(sep).join('/') }
      : undefined
    const entryPath = current?.entryPath ?? basename(source.path)
    if (current !== undefined) await checkPreviewResource(current.policy, entryPath)
    const id = randomUUID()
    this.grants.set(id, { owner, entryPath, policy: current?.policy, provider: source })
    this.hosts.add(id)
    return `cogent-preview://${id}/${entryPath.split('/').map(encodeURIComponent).join('/')}`
  }
  revokeUrl(value: string): void {
    const id = new URL(value).hostname, grant = this.grants.get(id)
    if (!grant) return
    this.grants.delete(id); this.hosts.delete(id)
    void grant.provider.release().catch(error => console.error('网页资源授权释放失败', error))
  }
  /** 新入口已成功导航后才替换；签发或导航失败时旧页面仍持有原授权。 */
  commit(owner: string, value: string): void {
    const id = new URL(value).hostname
    if (this.grants.get(id)?.owner !== owner) throw new Error('网页资源授权已失效或归属不匹配')
    for (const [otherId, grant] of this.grants) if (grant.owner === owner && otherId !== id) this.revokeUrl(`cogent-preview://${otherId}/`)
  }
  revoke(owner: string): void {
    for (const [id, grant] of this.grants) if (grant.owner === owner) {
      this.grants.delete(id); this.hosts.delete(id)
      void grant.provider.release().catch(error => console.error('网页资源授权释放失败', error))
    }
  }
  private async respond(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const grant = this.grants.get(url.hostname)
    if (!grant || (request.method !== 'GET' && request.method !== 'HEAD')) return new Response(null, { status: 403 })
    try {
      const parts = url.pathname.slice(1).split('/').map(decodeURIComponent)
      if (parts.some(part => !part || /[\\/:\0]/.test(part) || BLOCKED_PREVIEW_NAMES.test(part))) return new Response(null, { status: 403 })
      const resourcePath = parts.join('/')
      if (grant.policy !== undefined) await checkPreviewResource(grant.policy, resourcePath)
      const relativePath = resourcePath === grant.entryPath ? '' : resourcePath
      const value = await grant.provider.readResource(relativePath)
      return new Response(request.method === 'HEAD' ? null : value.bytes, { headers: { 'Content-Type': MIME[extname(parts.at(-1)!).toLowerCase()] ?? value.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } })
    } catch { return new Response(null, { status: 404 }) }
  }
}
