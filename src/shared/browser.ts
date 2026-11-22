/** 普通浏览器的桌面窄合同；网页只得到 Chromium，绝不接触此 IPC 或 Host SDK。 */
export const BROWSER_CHANNEL = { request: 'cogent:browser:request', event: 'cogent:browser:event' } as const

export interface BrowserHistoryEntry { url: string; title: string }
export interface BrowserHistory { entries: BrowserHistoryEntry[]; index: number }
export interface BrowserState {
  scopeId: string
  tabId: string
  lease: string
  generation: number
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoom: number
  error: string | null
  crashed: boolean
  active: boolean
  held: boolean
  privateGroupId?: string
  localFile?: string
}
export interface BrowserReservation {
  lease: string
  partition: string
  bootstrapUrl: string
  state: BrowserState
}
export interface BrowserCloseResult { closed: boolean; keepMounted: boolean }
export type BrowserPermissionDecision = 'ask' | 'allow' | 'deny'
export interface BrowserSitePermission { origin: string; permission: string; mediaTypes?: Array<'audio' | 'video'>; decision: BrowserPermissionDecision }
export interface BrowserDownload {
  id: string
  tabId: string
  name: string
  received: number
  total: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  paused: boolean
  path: string
}
export interface BrowserPreviewTarget { leaseId: string }
type Lease = { lease: string }
export interface BrowserMethods {
  reserve: { params: { scopeId: string; tabId: string; privateGroupId?: string }; result: BrowserReservation }
  attach: { params: Lease & { webContentsId: number }; result: BrowserState }
  navigate: { params: Lease & { url: string }; result: BrowserState }
  back: { params: Lease; result: BrowserState }
  forward: { params: Lease; result: BrowserState }
  reload: { params: Lease; result: BrowserState }
  stop: { params: Lease; result: BrowserState }
  visibility: { params: Lease & { active: boolean }; result: BrowserState }
  close: { params: Lease; result: BrowserCloseResult }
  release: { params: Lease; result: void }
  find: { params: Lease & { text: string; forward?: boolean; findNext?: boolean }; result: void }
  zoom: { params: Lease & { factor: number }; result: BrowserState }
  history: { params: Lease; result: { entries: BrowserHistoryEntry[]; index: number } }
  goTo: { params: Lease & { index: number }; result: BrowserState }
  preferences: { params: Lease & { search?: 'bing' | 'google' | 'duckduckgo' }; result: { search: 'bing' | 'google' | 'duckduckgo' } }
  restore: { params: Lease & { entries: BrowserHistoryEntry[]; index: number }; result: BrowserState }
  permissions: { params: Lease; result: BrowserSitePermission[] }
  permission: { params: Lease & BrowserSitePermission; result: void }
  downloads: { params: Lease; result: BrowserDownload[] }
  download: { params: Lease & { id: string; action: 'cancel' | 'pause' | 'resume' | 'open' | 'reveal' }; result: void }
  clearData: { params: Lease & { all: boolean }; result: void }
  external: { params: Lease; result: void }
  preview: { params: Lease & { source: BrowserPreviewTarget; pickRoot?: boolean }; result: BrowserState }
  promptReply: { params: Lease & { requestId: string; value: string | null }; result: void }
}
export type BrowserMethod = keyof BrowserMethods
export type BrowserEvent =
  | { type: 'state'; scopeId: string; tabId: string; state: BrowserState }
  | { type: 'open'; scopeId: string; tabId: string; url: string; background: boolean; privateGroupId?: string }
  | { type: 'shortcut'; scopeId: string; tabId: string; command: 'new' | 'close' | 'next' | 'previous' | 'address' | 'find' | 'reopen' }
  | { type: 'download'; scopeId: string; tabId: string; download: BrowserDownload }
  | { type: 'released'; scopeId: string; tabId: string; lease: string }
  | { type: 'find'; scopeId: string; tabId: string; matches: number; active: number }
  | { type: 'prompt'; scopeId: string; tabId: string; requestId: string; kind?: 'prompt' | 'alert' | 'confirm' | 'authentication'; message: string; defaultValue: string }
  | { type: 'prompt-cancel'; scopeId: string; tabId: string; requestId: string }

/** 地址栏与恢复共用；显式未知协议不能悄悄变成搜索或交给操作系统。 */
export function browserAddress(value: string, search = 'https://www.bing.com/search?q='): string {
  const input = value.trim()
  if (!input) return 'about:blank'
  if (/^(?:(?:[a-z\d-]+\.)*localhost|127(?:\.\d+){0,3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input)) return new URL(`http://${input}`).href
  if (/^(?:[^\s/:]+\.)+[^\s/:]+(?::\d+)?(?:[/?#]|$)/.test(input)) return new URL(`https://${input}`).href
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) && input !== 'about:blank') throw new Error('此地址协议不能在浏览器中打开')
    if (url.username || url.password) throw new Error('请使用网站登录表单，不要在地址中携带账号密码')
    return url.href
  }
  return search + encodeURIComponent(input)
}

/** HistoryEntry.pageState 含表单值，必须逐项白名单投影后再交客户端存储。 */
export function publicBrowserHistory(entries: readonly BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  return entries.filter(entry => /^https?:/i.test(entry.url)).map(entry => ({ url: entry.url, title: entry.title }))
}
