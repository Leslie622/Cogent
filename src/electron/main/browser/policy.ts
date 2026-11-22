/** 纯策略供 main 与单元测试共用；端口集合由当前 Host 生命周期动态供给。 */
export function allowedBrowserUrl(value: string, protectedPorts: readonly number[], localHosts: ReadonlySet<string> = new Set()): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.username || url.password) return false
  if (url.protocol === 'about:') return url.href === 'about:blank' || url.href.startsWith('about:blank#')
  if (url.protocol === 'cogent-preview:') return localHosts.has(url.hostname)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false
  const port = Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80))
  // 对受保护端口不按 hostname 猜归属，DNS alias/rebinding 也不能访问同端口。
  return !protectedPorts.includes(port)
}

export function permissionKey(origin: string, permission: string, mediaTypes: readonly string[] = []): string {
  return `${new URL(origin).origin}|${permission}|${[...mediaTypes].sort().join(',')}`
}

export const PROMPT_BROWSER_PERMISSIONS = new Set(['clipboard-read', 'notifications', 'media', 'geolocation', 'fullscreen', 'pointerLock', 'keyboardLock', 'speaker-selection'])
export { FILE_VIEW_PREVIEW_BLOCKED_NAMES as BLOCKED_PREVIEW_NAMES } from '../../../shared/file-views'
