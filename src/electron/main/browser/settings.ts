/** 浏览器站点策略由 main 单写，初始化失败不悄悄覆盖旧数据。 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ensureRoot, storageRoot, writeFileAtomic } from '../storage-root'
import type { BrowserPermissionDecision, BrowserSitePermission } from '../../../shared/browser'

const schema = z.object({ version: z.literal(1), permissions: z.record(z.string(), z.enum(['allow', 'deny'])), search: z.enum(['bing', 'google', 'duckduckgo']).default('bing') })
export class BrowserSettings {
  private data: z.infer<typeof schema>
  private readonly path: string
  constructor(root = storageRoot()) {
    this.path = join(root, 'browser-settings.json')
    this.data = existsSync(this.path) ? schema.parse(JSON.parse(readFileSync(this.path, 'utf8')) as unknown) : { version: 1, permissions: {}, search: 'bing' }
  }
  get(origin: string, permission: string, mediaTypes: readonly string[] = []): BrowserPermissionDecision {
    if (permission === 'media' && mediaTypes.length) {
      const decisions = mediaTypes.map(type => this.data.permissions[`${origin}|media|${type}`] ?? 'ask')
      return decisions.includes('deny') ? 'deny' : decisions.every(value => value === 'allow') ? 'allow' : 'ask'
    }
    return this.data.permissions[`${origin}|${permission}`] ?? 'ask'
  }
  list(origin: string): BrowserSitePermission[] {
    return Object.entries(this.data.permissions).filter(([key]) => key.startsWith(`${origin}|`)).map(([key, decision]) => ({ origin, permission: key.slice(origin.length + 1), decision }))
  }
  set(origin: string, permission: string, decision: BrowserPermissionDecision, mediaTypes: readonly string[] = []): void {
    const permissions = { ...this.data.permissions }
    const keys = permission === 'media' && mediaTypes.length ? mediaTypes.map(type => `${origin}|media|${type}`) : [`${origin}|${permission}`]
    for (const key of keys) { if (decision === 'ask') delete permissions[key]; else permissions[key] = decision }
    const next = { ...this.data, permissions }
    ensureRoot()
    writeFileAtomic(this.path, JSON.stringify(next, null, 2))
    this.data = next
  }
  search(value?: 'bing' | 'google' | 'duckduckgo'): 'bing' | 'google' | 'duckduckgo' {
    if (value !== undefined) { const next = { ...this.data, search: value }; ensureRoot(); writeFileAtomic(this.path, JSON.stringify(next, null, 2)); this.data = next }
    return this.data.search
  }
}
