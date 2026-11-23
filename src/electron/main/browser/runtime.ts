/** 普通浏览器资源 owner：lease 绑定父窗口/工作面/标签；网页无 Host SDK，也不 attach CDP。 */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, Menu, session, shell, webContents, type DownloadItem, type IpcMainEvent, type Session, type WebContents, type WebPreferences } from 'electron'
import { BROWSER_CHANNEL, browserAddress, type BrowserCloseResult, type BrowserDownload, type BrowserEvent, type BrowserHistory, type BrowserHistoryEntry, type BrowserReservation, type BrowserSitePermission, type BrowserState } from '../../../shared/browser'
import { BrowserSettings } from './settings'
import { BrowserLocalPreview, type BrowserPreviewSource } from './local-preview'
import { allowedBrowserUrl, permissionKey, PROMPT_BROWSER_PERMISSIONS } from './policy'
import { edgeExternalUrl } from './external-url'

interface Profile { id: string; partition: string; session: Session; private: boolean; grants: Map<number, Set<string>>; decisions: Map<string, 'ask' | 'allow' | 'deny'>; certificates: Set<string>; inflight: Map<string, Promise<number>>; lifetime: AbortController }
interface Tab {
  owner: WebContents
  profile: Profile
  state: BrowserState
  guest?: WebContents
  attaching: boolean
  document: number
  closing?: Promise<BrowserCloseResult>
  closeAttempt?: { canceled: boolean }
  closeResult?: (result: BrowserCloseResult) => void
  cleanup: (() => void)[]
  popups: Set<BrowserWindow>
  previewPath?: string
  previewRequest?: symbol
  restored?: BrowserHistory & { pending?: number; nativeIndex: number }
}
interface Download { profile: Profile; tab: Tab; item: DownloadItem; state: BrowserDownload; done: boolean }
interface Prompt { tab: Tab; sender: WebContents; replies: Array<(value: string | null) => void>; timer: ReturnType<typeof setTimeout>; document: number; key?: string }

export interface BrowserRuntimeDeps { getProtectedPorts: () => number[] }

export class BrowserTabRuntime {
  private readonly tabs = new Map<string, Tab>()
  private readonly profiles = new Map<string, Profile>()
  private readonly downloads = new Map<string, Download>()
  private readonly prompts = new Map<string, Prompt>()
  private readonly owners = new Set<number>()
  private readonly documents = new Map<number, number>()
  private settings: BrowserSettings | Error
  private readonly preview = new BrowserLocalPreview()
  private generation = 0

  constructor(private readonly deps: BrowserRuntimeDeps) {
    try { this.settings = new BrowserSettings() } catch (error) { this.settings = error instanceof Error ? error : new Error(String(error)) }
    app.on('will-quit', () => {
      for (const download of this.downloads.values()) if (!download.done) download.item.cancel()
      for (const tab of [...this.tabs.values()]) this.destroy(tab)
    })
  }

  reserve(owner: WebContents, params: { scopeId: string; tabId: string; privateGroupId?: string }): BrowserReservation {
    this.browserSettings()
    // lease属于本次初始化而非逻辑tab。StrictMode重挂或重试的旧回调仍要释放自己的lease，
    // 若按tab复用授权，旧effect的迟到release会撤销新webview，后者永远等不到dom-ready。
    const profile = this.profile(params.privateGroupId === undefined ? 'normal' : `private:${owner.id}:${params.privateGroupId}`)
    const lease = randomUUID()
    const state: BrowserState = { ...params, lease, generation: ++this.generation, url: '', title: '浏览器', favicon: null, loading: false, canGoBack: false, canGoForward: false, zoom: 1, error: null, crashed: false, active: false, held: false }
    const tab: Tab = { owner, profile, state, attaching: false, document: 0, cleanup: [], popups: new Set() }
    this.tabs.set(lease, tab)
    if (!this.owners.has(owner.id)) {
      this.owners.add(owner.id)
      const release = () => {
        for (const item of this.tabs.values()) if (item.owner === owner) this.destroy(item)
      }
      owner.on('render-process-gone', release)
      owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) release() })
      owner.once('destroyed', () => { release(); this.owners.delete(owner.id) })
    }
    return this.reservation(tab)
  }

  private reservation(tab: Tab): BrowserReservation {
    return { lease: tab.state.lease, partition: tab.profile.partition, bootstrapUrl: `about:blank#${tab.state.lease}`, state: { ...tab.state } }
  }

  configureAttachment(owner: WebContents, preferences: WebPreferences, params: Record<string, string>): boolean | undefined {
    if (!params.src.startsWith('about:blank#')) return undefined
    const tab = this.tabs.get(params.src.slice('about:blank#'.length))
    if (!tab || tab.owner !== owner || tab.attaching || tab.guest || params.partition !== tab.profile.partition) return false
    tab.attaching = true
    for (const key of Object.keys(preferences)) if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
    Object.assign(preferences, {
      partition: tab.profile.partition, sandbox: true, contextIsolation: true, webSecurity: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false,
      allowRunningInsecureContent: false, plugins: false, navigateOnDragDrop: false, backgroundThrottling: true,
      preload: join(import.meta.dirname, '../preload/browser-dialog.cjs'), safeDialogs: true,
    })
    delete params.preload
    delete params.nodeintegration
    delete params.disablewebsecurity
    params.allowpopups = 'true'
    return true
  }

  attach(owner: WebContents, lease: string, id: number): BrowserState {
    const tab = this.tab(owner, lease)
    const guest = webContents.fromId(id)
    if (!guest || guest.getType() !== 'webview' || guest.hostWebContents !== owner || guest.session !== tab.profile.session || guest.getURL() !== `about:blank#${lease}`) throw new Error('网页实例与标签授权不匹配')
    if (tab.guest === guest) return { ...tab.state }
    if (tab.guest) throw new Error('标签已绑定另一个网页实例')
    tab.guest = guest
    this.bind(tab, guest)
    return this.publish(tab)
  }

  state(owner: WebContents, lease: string): BrowserState { return { ...this.tab(owner, lease).state } }
  private tab(owner: WebContents, lease: string): Tab {
    const tab = this.tabs.get(lease)
    if (!tab || tab.owner !== owner) throw new Error('网页标签已关闭或不属于当前窗口')
    return tab
  }
  private guest(tab: Tab): WebContents {
    if (!tab.guest || tab.guest.isDestroyed()) throw new Error('网页尚未就绪，请重试此标签')
    return tab.guest
  }
  private allowed(url: string): boolean { return allowedBrowserUrl(url, this.deps.getProtectedPorts(), this.preview.hosts) }
  private browserSettings(): BrowserSettings {
    if (this.settings instanceof Error) throw new Error(`浏览器站点策略读取失败，请修复 browser-settings.json 后重启：${this.settings.message}`)
    return this.settings
  }
  private requireUrl(url: string): void { if (!this.allowed(url)) throw new Error('此地址的协议或受保护端口不允许浏览') }
  private send(tab: Tab, event: BrowserEvent): void { if (!tab.owner.isDestroyed()) tab.owner.send(BROWSER_CHANNEL.event, event) }
  private publish(tab: Tab): BrowserState {
    const guest = tab.guest
    if (guest && !guest.isDestroyed()) {
      const url = guest.getURL()
      if (!(tab.closeAttempt !== undefined && url === 'about:blank')) {
        if (!url.startsWith('about:blank#')) tab.state.url = url === 'about:blank' || url.startsWith('cogent-preview:') ? '' : url
        tab.state.localFile = url.startsWith('cogent-preview:') ? tab.previewPath : undefined
        const title = guest.getTitle()
        tab.state.title = url.startsWith('about:blank') ? '浏览器' : title.replace(/cogent-preview:\/\/[a-f\d-]+/gi, '本地网页') || '浏览器'
      }
      tab.state.loading = guest.isLoading()
      tab.state.canGoBack = tab.restored ? tab.restored.index > 0 : guest.navigationHistory.canGoBack()
      tab.state.canGoForward = tab.restored ? tab.restored.index < tab.restored.entries.length - 1 : guest.navigationHistory.canGoForward()
      tab.state.zoom = guest.getZoomFactor()
    }
    const state = { ...tab.state }
    this.send(tab, { type: 'state', scopeId: state.scopeId, tabId: state.tabId, state })
    return state
  }

  async navigate(owner: WebContents, lease: string, value: string): Promise<BrowserState> {
    const tab = this.tab(owner, lease)
    const search = { bing: 'https://www.bing.com/search?q=', google: 'https://www.google.com/search?q=', duckduckgo: 'https://duckduckgo.com/?q=' }[this.browserSettings().search()]
    const url = value.startsWith('cogent-preview:') ? value : browserAddress(value, search)
    this.requireUrl(url)
    tab.state.error = null
    tab.state.crashed = false
    tab.state.loading = true
    this.publish(tab)
    try { await this.guest(tab).loadURL(url) }
    catch (error) {
      if (!(error instanceof Error && error.message.includes('ERR_ABORTED'))) { tab.state.error = String(error).replace(/cogent-preview:\/\/[a-f\d-]+/gi, '本地网页'); this.publish(tab); throw new Error(tab.state.error) }
    }
    return this.publish(tab)
  }
  command(owner: WebContents, lease: string, command: 'back' | 'forward' | 'reload' | 'stop'): BrowserState {
    const tab = this.tab(owner, lease), guest = this.guest(tab)
    if (tab.restored && (command === 'back' || command === 'forward')) {
      const index = tab.restored.index + (command === 'back' ? -1 : 1)
      if (index >= 0 && index < tab.restored.entries.length) this.traverseRestored(tab, index)
      return this.publish(tab)
    }
    if (command === 'back' && guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack()
    if (command === 'forward' && guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward()
    if (command === 'reload') { tab.state.error = null; if (tab.restored) tab.restored.pending = tab.restored.index; guest.reload() }
    if (command === 'stop') { if (tab.restored) tab.restored.pending = undefined; guest.stop() }
    return this.publish(tab)
  }
  visibility(owner: WebContents, lease: string, active: boolean): BrowserState {
    const tab = this.tab(owner, lease)
    tab.state.active = active
    if (!active && tab.guest && !tab.guest.isDestroyed() && tab.guest.isFocused() && !owner.isDestroyed()) owner.focus()
    return this.publish(tab)
  }
  find(owner: WebContents, lease: string, text: string, forward = true, findNext = false): void {
    const guest = this.guest(this.tab(owner, lease))
    if (text) guest.findInPage(text, { forward, findNext: !findNext })
    else guest.stopFindInPage('clearSelection')
  }
  zoom(owner: WebContents, lease: string, factor: number): BrowserState {
    const tab = this.tab(owner, lease)
    this.guest(tab).setZoomFactor(factor)
    return this.publish(tab)
  }
  history(owner: WebContents, lease: string): { entries: BrowserHistoryEntry[]; index: number } {
    const tab = this.tab(owner, lease), history = this.guest(tab).navigationHistory
    // HTML 临时 capability URL 不进入客户端存储；私密页完全不导出历史。
    if (tab.profile.private) return { entries: [], index: -1 }
    if (tab.restored) return { entries: tab.restored.entries.map(entry => ({ ...entry })), index: tab.restored.index }
    const all = history.getAllEntries(), active = history.getActiveIndex()
    const entries = all.filter(item => /^https?:/i.test(item.url)).map(item => ({ url: item.url, title: item.title }))
    const index = all.slice(0, active + 1).filter(item => /^https?:/i.test(item.url)).length - 1
    return { entries, index }
  }
  goTo(owner: WebContents, lease: string, index: number): BrowserState {
    const tab = this.tab(owner, lease), history = this.guest(tab).navigationHistory
    if (tab.restored) {
      if (index < 0 || index >= tab.restored.entries.length) throw new Error('网页历史位置已失效')
      this.traverseRestored(tab, index)
      return this.publish(tab)
    }
    if (index < 0 || index >= history.length()) throw new Error('网页历史位置已失效')
    const entries = history.getAllEntries().map((entry, nativeIndex) => ({ entry, nativeIndex })).filter(value => /^https?:/i.test(value.entry.url))
    if (!entries[index]) throw new Error('网页历史位置已失效')
    history.goToIndex(entries[index].nativeIndex)
    return this.publish(tab)
  }
  preferences(owner: WebContents, lease: string, search?: 'bing' | 'google' | 'duckduckgo'): { search: 'bing' | 'google' | 'duckduckgo' } { this.tab(owner, lease); return { search: this.browserSettings().search(search) } }
  async restore(owner: WebContents, lease: string, entries: BrowserHistoryEntry[], index: number): Promise<BrowserState> {
    const tab = this.tab(owner, lease)
    for (const entry of entries) { if (!/^https?:/i.test(entry.url)) throw new Error('历史记录包含不允许恢复的协议'); this.requireUrl(entry.url) }
    if (index < 0 || index >= entries.length) throw new Error('网页历史位置已失效')
    // webview 的 bootstrap 已提交，Electron native restore 此时必拒绝。只恢复公开栈，
    // 首次只加载选中 URL；工具条回访重新导航，不伪造 POST/JS history/表单的内存恢复。
    tab.restored = { entries: entries.map(entry => ({ url: entry.url, title: entry.title })), index, pending: index, nativeIndex: this.guest(tab).navigationHistory.getActiveIndex() }
    return this.navigate(owner, lease, entries[index].url)
  }
  private traverseRestored(tab: Tab, index: number): void {
    const history = tab.restored!
    history.pending = index
    void this.navigate(tab.owner, tab.state.lease, history.entries[index].url).catch(error => { if (this.tabs.has(tab.state.lease)) { tab.state.error = String(error); this.publish(tab) } })
  }
  private recordNavigation(tab: Tab, inPage: boolean): void {
    const history = tab.restored
    if (!history) return
    const guest = this.guest(tab), url = guest.getURL()
    if (!/^https?:/i.test(url)) return
    const entry = { url, title: guest.getTitle() }, nativeIndex = guest.navigationHistory.getActiveIndex()
    if (history.pending !== undefined) { history.index = history.pending; history.entries[history.index] = entry; history.pending = undefined }
    else if (url === history.entries[history.index].url || inPage && nativeIndex === history.nativeIndex) history.entries[history.index] = entry
    else { history.entries = [...history.entries.slice(0, history.index + 1), entry]; history.index++ }
    history.nativeIndex = nativeIndex
  }
  async localPreviewSource(owner: WebContents, lease: string, source: BrowserPreviewSource): Promise<BrowserState> {
    let url: string | undefined
    let tab: Tab | undefined
    let previousPath: string | undefined
    const request = Symbol('preview')
    try {
      tab = this.tab(owner, lease)
      previousPath = tab.previewPath
      tab.previewRequest = request
      url = await this.preview.authorizeSource(tab.state.lease, source)
      if (this.tab(owner, lease) !== tab || tab.previewRequest !== request) throw new Error('网页预览请求已被替换')
      tab.previewPath = source.path
      await this.navigate(owner, lease, url)
      if (this.tab(owner, lease) !== tab || tab.previewRequest !== request) throw new Error('网页预览请求已被替换')
      if (!this.guest(tab).getURL().startsWith(`cogent-preview://${new URL(url).hostname}/`)) throw new Error('网页预览导航未完成或已取消')
      this.preview.commit(lease, url)
      // 被撤销的capability不能成为Back/Forward目标；只移除旧预览项，保留HTTP历史。
      const history = this.guest(tab).navigationHistory, entries = history.getAllEntries(), active = history.getActiveIndex()
      for (let index = entries.length - 1; index >= 0; index--) if (index !== active && entries[index].url.startsWith('cogent-preview:') && !this.allowed(entries[index].url)) history.removeEntryAtIndex(index)
      return this.publish(tab)
    } catch (error) {
      if (tab !== undefined && this.tabs.get(lease) === tab && tab.previewRequest === request) { tab.previewPath = previousPath; this.publish(tab) }
      if (url) this.preview.revokeUrl(url)
      else await source.release()
      throw error
    }
  }
  async external(owner: WebContents, lease: string): Promise<void> {
    const url = this.tab(owner, lease).state.url
    if (!/^https?:/i.test(url)) throw new Error('此页面不能通过网络地址交给系统浏览器')
    this.requireUrl(url)
    const compatible = edgeExternalUrl(url)
    // 只兼容实测会丢弃此地址的 Windows Edge；其他默认浏览器仍收到原 URL，也不为普通地址查询系统关联。
    const target = process.platform === 'win32' && compatible !== url && app.getApplicationNameForProtocol(url) === 'Microsoft Edge' ? compatible : url
    await shell.openExternal(target)
  }

  private bind(tab: Tab, guest: WebContents): void {
    const guestId = guest.id
    this.documents.set(guestId, 0)
    guest.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!inPlace) this.cancelPrompts(tab)
      if (mainFrame && !inPlace) {
        tab.document = this.advanceDocument(tab.profile, guestId)
        tab.state.error = null
        tab.state.favicon = null
      }
    })
    const update = () => { this.publish(tab) }
    guest.on('did-navigate', () => { this.recordNavigation(tab, false); update() })
    guest.on('did-navigate-in-page', (_event, _url, mainFrame) => { if (mainFrame) this.recordNavigation(tab, true); update() })
    guest.on('did-start-loading', update)
    guest.on('did-stop-loading', update)
    guest.on('page-title-updated', () => { if (tab.restored && !(tab.closeAttempt !== undefined && guest.getURL() === 'about:blank')) tab.restored.entries[tab.restored.index].title = guest.getTitle(); update() })
    guest.on('did-fail-load', (_event, code, message, _url, mainFrame) => {
      if (mainFrame && code !== -3) { tab.state.error = `${message}（${code}）`; tab.state.loading = false; this.publish(tab) }
    })
    guest.on('page-favicon-updated', (_event, urls) => { void this.favicon(tab, urls[0]) })
    guest.on('will-frame-navigate', event => { if (!this.allowed(event.url)) event.preventDefault() })
    guest.on('will-redirect', (event, url) => { if (!this.allowed(url)) event.preventDefault() })
    guest.on('will-attach-webview', event => event.preventDefault())
    guest.on('will-prevent-unload', event => {
      const leave = dialog.showMessageBoxSync(this.window(tab), { type: 'question', title: '离开网页', message: '此网页可能有未保存的内容，仍然离开？', buttons: ['离开', '留在此页'], defaultId: 1, cancelId: 1 }) === 0
      if (leave) event.preventDefault()
      else if (tab.closeAttempt !== undefined) tab.closeAttempt.canceled = true
    })
    guest.on('render-process-gone', (_event, details) => {
      tab.document = this.advanceDocument(tab.profile, guestId)
      tab.state.crashed = true
      tab.state.error = `网页进程已停止（${details.reason}）`
      tab.state.loading = false
      this.cancelPrompts(tab)
      this.publish(tab)
    })
    guest.once('destroyed', () => {
      this.forgetDocument(tab.profile, guestId)
      tab.closeResult?.({ closed: true, keepMounted: false })
      this.finish(tab)
    })
    guest.on('focus', () => { if (!tab.state.active && !tab.owner.isDestroyed()) tab.owner.focus() })
    guest.on('found-in-page', (_event, result) => this.send(tab, { type: 'find', scopeId: tab.state.scopeId, tabId: tab.state.tabId, matches: result.matches, active: result.activeMatchOrdinal }))
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !tab.state.active) return
      const key = input.key.toLowerCase(), primary = input.control || input.meta
      const command = primary && !input.alt ? key === 't' ? input.shift ? 'reopen' : 'new' : key === 'w' ? 'close' : key === 'l' ? 'address' : key === 'f' ? 'find' : key === 'tab' ? input.shift ? 'previous' : 'next' : undefined : undefined
      if (command) { event.preventDefault(); tab.owner.focus(); this.send(tab, { type: 'shortcut', scopeId: tab.state.scopeId, tabId: tab.state.tabId, command }) }
      else if (primary && key === 'r') { event.preventDefault(); this.command(tab.owner, tab.state.lease, 'reload') }
      else if (input.alt && ['arrowleft', 'arrowright'].includes(key)) { event.preventDefault(); this.command(tab.owner, tab.state.lease, key === 'arrowleft' ? 'back' : 'forward') }
      else if (primary && ['+', '=', '-', '0'].includes(key)) { event.preventDefault(); this.zoom(tab.owner, tab.state.lease, key === '0' ? 1 : Math.max(0.25, Math.min(5, guest.getZoomFactor() + (key === '-' ? -0.1 : 0.1)))) }
    })
    this.installPopupSafety(tab, guest)
    guest.on('context-menu', (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = []
      if (params.linkURL && this.allowed(params.linkURL)) items.push({ label: '在新标签页打开链接', click: () => this.open(tab, params.linkURL, false) }, { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) })
      if (params.isEditable) items.push({ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' })
      else if (params.selectionText) items.push({ role: 'copy', label: '复制' })
      if (params.srcURL && this.allowed(params.srcURL)) items.push({ label: '下载图片或媒体', click: () => guest.downloadURL(params.srcURL) })
      if (items.length) Menu.buildFromTemplate(items).popup({ window: this.window(tab) })
    })
  }
  private installPopupSafety(tab: Tab, guest: WebContents): void {
    guest.on('login', (event, details, auth, callback) => {
      event.preventDefault()
      const origin = this.origin(details.url)
      if (!tab.state.active || !origin) { callback(); return }
      const message = `${auth.isProxy ? '代理服务器' : '网站'}：${auth.host}:${auth.port}\n页面：${origin}\n验证区域：${auth.realm}`
      this.ask(tab, guest, 'authentication', message, '', value => {
        if (value === null) { callback(); return }
        let input: unknown
        try { input = JSON.parse(value) as unknown } catch { callback(); return }
        if (typeof input !== 'object' || input === null || !('username' in input) || !('password' in input) || typeof input.username !== 'string' || typeof input.password !== 'string' || input.username.length > 4096 || input.password.length > 16384) { callback(); return }
        callback(input.username, input.password)
      }, `${origin}|${auth.isProxy}|${auth.host}|${auth.port}|${auth.realm}`)
    })
    guest.on('certificate-error', (event, value, error, certificate, callback, isMainFrame) => {
      const url = new URL(value)
      const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || /^127\./.test(url.hostname) || url.hostname === '[::1]'
      if (!isMainFrame || !local || !tab.state.active) { callback(false); return }
      event.preventDefault()
      const key = `${url.origin}|${createHash('sha256').update(certificate.data).digest('hex')}`
      if (tab.profile.certificates.has(key)) { callback(true); return }
      const document = this.documents.get(guest.id)
      void dialog.showMessageBox(this.window(tab), { type: 'warning', title: '本地开发站点证书', message: `${url.origin}\n${error}\n仅对此地址和当前证书继续？`, buttons: ['继续访问', '取消'], defaultId: 1, cancelId: 1 }).then(result => {
        const allow = result.response === 0 && this.documents.get(guest.id) === document && !guest.isDestroyed()
        if (allow) tab.profile.certificates.add(key)
        callback(allow)
      }).catch(() => callback(false))
    })
    guest.setWindowOpenHandler(details => {
      if (!tab.state.active) return { action: 'deny' }
      if (details.url !== 'about:blank' && !this.allowed(details.url)) return { action: 'deny' }
      if (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') {
        if (!details.postBody && !details.frameName) { this.open(tab, details.url, details.disposition === 'background-tab'); return { action: 'deny' } }
      }
      // JS window proxy/opener/POST 必须由 Chromium 创建真实子窗口，不能 deny 后只重开 URL。
      return { action: 'allow', overrideBrowserWindowOptions: { parent: this.window(tab), autoHideMenuBar: true, width: 720, height: 720, webPreferences: { session: tab.profile.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, preload: join(import.meta.dirname, '../preload/browser-dialog.cjs') } } }
    })
    guest.on('did-create-window', popup => {
      tab.popups.add(popup)
      const contents = popup.webContents
      const contentsId = contents.id
      this.documents.set(contentsId, 0)
      const retireDocument = (): void => { this.advanceDocument(tab.profile, contentsId); this.cancelPrompts(tab) }
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) retireDocument() })
      contents.on('render-process-gone', retireDocument)
      contents.on('will-frame-navigate', event => { if (!this.allowed(event.url)) event.preventDefault() })
      contents.on('will-redirect', (event, url) => { if (!this.allowed(url)) event.preventDefault() })
      this.installPopupSafety(tab, contents)
      contents.on('will-attach-webview', event => event.preventDefault())
      popup.once('closed', () => { this.forgetDocument(tab.profile, contentsId); tab.popups.delete(popup) })
    })
  }
  private window(tab: Tab): BrowserWindow { const win = BrowserWindow.fromWebContents(tab.owner); if (!win) throw new Error('浏览器所属窗口已关闭'); return win }
  private open(tab: Tab, url: string, background: boolean): void {
    if (!this.allowed(url)) return
    this.send(tab, { type: 'open', scopeId: tab.state.scopeId, tabId: tab.state.tabId, url, background, ...(tab.state.privateGroupId !== undefined && { privateGroupId: tab.state.privateGroupId }) })
  }
  private async favicon(tab: Tab, value: string | undefined): Promise<void> {
    if (!value || !this.allowed(value)) return
    const generation = tab.document
    try {
      const response = await tab.profile.session.fetch(value, { signal: AbortSignal.any([AbortSignal.timeout(5000), tab.profile.lifetime.signal]) })
      const mime = response.headers.get('content-type') ?? ''
      if (!/^image\/(?:png|jpeg|gif|webp|x-icon|vnd.microsoft.icon)(?:;|$)/i.test(mime) || Number(response.headers.get('content-length')) > 262144) return
      const reader = response.body?.getReader()
      if (!reader) return
      const parts: Uint8Array[] = []; let size = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        const chunk: unknown = part.value
        if (!(chunk instanceof Uint8Array)) throw new Error('网页图标响应不是字节流')
        size += chunk.length
        if (size > 262144) { await reader.cancel(); return }
        parts.push(chunk)
      }
      if (tab.document === generation && this.tabs.has(tab.state.lease)) { tab.state.favicon = `data:${mime.split(';')[0]};base64,${Buffer.concat(parts).toString('base64')}`; this.publish(tab) }
    } catch { /* 外站图标不是页面加载成功的前提；失败保留类型图标。 */ }
  }

  private profile(id: string): Profile {
    const existing = this.profiles.get(id)
    if (existing) return existing
    const partition = id === 'normal' ? 'persist:cogent-workspace-browser-v1' : `cogent-browser-${randomUUID()}`
    const profile: Profile = { id, partition, session: session.fromPartition(partition), private: id !== 'normal', grants: new Map(), decisions: new Map(), certificates: new Set(), inflight: new Map(), lifetime: new AbortController() }
    this.profiles.set(id, profile)
    this.preview.install(profile.session)
    profile.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const allowed = ['data:', 'blob:'].includes(url.protocol) || this.allowed(details.url)
      callback({ cancel: !allowed })
    })
    profile.session.setPermissionRequestHandler((guest, permission, callback, details) => {
      const mediaTypes = ('mediaTypes' in details ? details.mediaTypes : undefined) ?? []
      const origin = this.origin('requestingUrl' in details ? details.requestingUrl : guest.getURL())
      const tab = this.ownerForGuest(guest)
      if (!tab || !tab.state.active || !PROMPT_BROWSER_PERMISSIONS.has(permission) || origin === null) { callback(false); return }
      const key = permissionKey(origin, permission, mediaTypes)
      const mediaDecision = permission === 'media' && mediaTypes.length ? mediaTypes.map(type => profile.decisions.get(`${origin}|media|${type}`) ?? 'ask') : [profile.decisions.get(`${origin}|${permission}`) ?? 'ask']
      const saved = profile.private ? mediaDecision.includes('deny') ? 'deny' : mediaDecision.every(value => value === 'allow') ? 'allow' : 'ask' : this.browserSettings().get(origin, permission, mediaTypes)
      if (saved !== 'ask') { callback(saved === 'allow'); return }
      const guestId = guest.id
      const document = this.documents.get(guestId)
      if (document === undefined) { callback(false); return }
      const grantKey = `${key}|${guestId}|${document}`
      if (profile.grants.get(guestId)?.has(key)) { callback(true); return }
      let flight = profile.inflight.get(grantKey)
      if (!flight) {
        flight = dialog.showMessageBox(this.window(tab), { type: 'question', title: '网站权限', message: `${origin}\n请求${this.permissionLabel(permission)}${mediaTypes.length ? `（${mediaTypes.join('、')}）` : ''}`, buttons: profile.private ? ['本次允许', '拒绝'] : ['本次允许', '始终允许', '拒绝'], defaultId: profile.private ? 1 : 2, cancelId: profile.private ? 1 : 2 }).then(result => result.response).finally(() => profile.inflight.delete(grantKey))
        profile.inflight.set(grantKey, flight)
      }
      void flight.then(choice => {
        if (!this.tabs.has(tab.state.lease) || this.documents.get(guestId) !== document || guest.isDestroyed() || !tab.state.active) { callback(false); return }
        const always = !profile.private && choice === 1
        if (always) this.browserSettings().set(origin, permission, 'allow', mediaTypes)
        if (choice === 0) {
          const grants = profile.grants.get(guestId) ?? new Set<string>()
          grants.add(key)
          profile.grants.set(guestId, grants)
        }
        callback(always || choice === 0)
      }).catch(() => callback(false))
    })
    profile.session.setPermissionCheckHandler((guest, permission, requestingOrigin, details) => {
      const origin = this.origin(requestingOrigin)
      if (permission === 'clipboard-sanitized-write') return true
      if (!guest || !origin || !this.ownerForGuest(guest)?.state.active || !PROMPT_BROWSER_PERMISSIONS.has(permission)) return false
      const mediaTypes = permission === 'media' && (details.mediaType === 'audio' || details.mediaType === 'video') ? [details.mediaType] : []
      if (permission === 'media' && !mediaTypes.length) return false
      const persistent = profile.private ? profile.decisions.get(permission === 'media' ? `${origin}|media|${mediaTypes[0]}` : `${origin}|${permission}`) === 'allow' : this.browserSettings().get(origin, permission, mediaTypes) === 'allow'
      const grants = profile.grants.get(guest.id)
      return persistent || (grants !== undefined && [...grants].some(key => key.startsWith(`${origin}|${permission}|`) && (permission !== 'media' || key.split('|')[2].split(',').includes(mediaTypes[0]))))
    })
    profile.session.setDevicePermissionHandler(() => false)
    profile.session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    profile.session.on('will-download', (_event, item, guest) => this.trackDownload(profile, item, guest))
    return profile
  }
  private origin(value: string): string | null { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null } catch { return null } }
  private permissionLabel(permission: string): string { return ({ media: '使用摄像头或麦克风', geolocation: '获取位置', notifications: '发送通知', 'clipboard-read': '读取剪贴板', fullscreen: '进入全屏', pointerLock: '锁定指针', keyboardLock: '锁定键盘', 'speaker-selection': '选择音频输出' } as Record<string, string>)[permission] ?? permission }
  private ownerForGuest(guest: WebContents): Tab | undefined { return [...this.tabs.values()].find(tab => tab.guest === guest || [...tab.popups].some(popup => !popup.isDestroyed() && popup.webContents === guest)) }
  permissions(owner: WebContents, lease: string): BrowserSitePermission[] {
    const tab = this.tab(owner, lease), origin = this.origin(tab.state.url)
    if (!origin) return []
    return [...PROMPT_BROWSER_PERMISSIONS].flatMap(permission => (permission === 'media' ? ['audio', 'video'] as const : [null]).map(type => ({ origin, permission, ...(type !== null && { mediaTypes: [type] }), decision: tab.profile.private ? tab.profile.decisions.get(type !== null ? `${origin}|media|${type}` : `${origin}|${permission}`) ?? 'ask' : this.browserSettings().get(origin, permission, type !== null ? [type] : []) })))
  }
  permission(owner: WebContents, lease: string, value: BrowserSitePermission): void {
    const tab = this.tab(owner, lease)
    if (this.origin(tab.state.url) !== value.origin || !PROMPT_BROWSER_PERMISSIONS.has(value.permission)) throw new Error('只能修改当前站点的已知权限')
    if (value.permission === 'media' && !value.mediaTypes?.length) throw new Error('请分别指定摄像头或麦克风权限')
    if (!tab.profile.private) this.browserSettings().set(value.origin, value.permission, value.decision, value.mediaTypes)
    else if (value.permission === 'media') for (const type of value.mediaTypes!) tab.profile.decisions.set(`${value.origin}|media|${type}`, value.decision)
    else tab.profile.decisions.set(`${value.origin}|${value.permission}`, value.decision)
    for (const [guestId, grants] of tab.profile.grants) {
      for (const key of grants) if (key.startsWith(`${value.origin}|${value.permission}|`)) grants.delete(key)
      if (!grants.size) tab.profile.grants.delete(guestId)
    }
    // 重新加载使已开启的采集与旧文档一起结束；不是只修改未来请求的回调。
    for (const peer of this.tabs.values()) if (peer.profile === tab.profile && this.origin(peer.state.url) === value.origin && peer.guest && !peer.guest.isDestroyed()) peer.guest.reload()
    for (const peer of this.tabs.values()) if (peer.profile === tab.profile) for (const popup of peer.popups) if (!popup.isDestroyed() && this.origin(popup.webContents.getURL()) === value.origin) popup.reload()
  }
  async clearData(owner: WebContents, lease: string, all: boolean): Promise<void> {
    const tab = this.tab(owner, lease)
    await tab.profile.session.clearCache()
    if (all) { await tab.profile.session.clearStorageData(); await tab.profile.session.clearAuthCache(); tab.profile.grants.clear() }
  }

  private trackDownload(profile: Profile, item: DownloadItem, guest: WebContents): void {
    const tab = this.ownerForGuest(guest)
    if (!tab) { item.cancel(); return }
    // 原生对话框支持仅传文件名；系统下载目录可能被删除或在隔离用户资料下不可用。
    // 让对话框选择初始目录，避免路径查询异常从 Session 事件逃逸到主进程。
    item.setSaveDialogOptions({ title: '保存下载文件', defaultPath: item.getFilename(), properties: ['showOverwriteConfirmation', 'createDirectory'] })
    const state: BrowserDownload = { id: randomUUID(), tabId: tab.state.tabId, name: item.getFilename(), received: 0, total: item.getTotalBytes(), state: 'progressing', paused: false, path: '' }
    const download: Download = { profile, tab, item, state, done: false }
    this.downloads.set(state.id, download)
    const publish = () => {
      state.received = item.getReceivedBytes(); state.total = item.getTotalBytes(); state.paused = item.isPaused(); state.path = item.getSavePath()
      this.send(tab, { type: 'download', scopeId: tab.state.scopeId, tabId: tab.state.tabId, download: { ...state } })
    }
    item.on('updated', (_event, status) => { if (status === 'interrupted') state.state = 'interrupted'; publish() })
    item.once('done', (_event, status) => {
      download.done = true; state.state = status; publish()
      if (tab.state.held && !this.activeDownloads(tab).length) this.destroy(tab)
      const completed = [...this.downloads.values()].filter(value => value.done)
      for (const value of completed.slice(0, Math.max(0, completed.length - 100))) this.downloads.delete(value.state.id)
    })
    publish()
  }
  private activeDownloads(tab: Tab): Download[] { return [...this.downloads.values()].filter(download => download.tab === tab && !download.done) }
  listDownloads(owner: WebContents, lease: string): BrowserDownload[] {
    const tab = this.tab(owner, lease)
    return [...this.downloads.values()].filter(value => value.profile === tab.profile).map(value => ({ ...value.state }))
  }
  async download(owner: WebContents, lease: string, id: string, action: 'cancel' | 'pause' | 'resume' | 'open' | 'reveal'): Promise<void> {
    const tab = this.tab(owner, lease), value = this.downloads.get(id)
    if (!value || value.profile !== tab.profile) throw new Error('下载任务不属于当前浏览组')
    if (action === 'cancel' && !value.done) value.item.cancel()
    if (action === 'pause' && !value.done) value.item.pause()
    if (action === 'resume' && !value.done) value.item.resume()
    if (action === 'open' || action === 'reveal') {
      if (value.state.state !== 'completed') throw new Error('下载尚未完成')
      if (action === 'reveal') shell.showItemInFolder(value.state.path)
      else { const message = await shell.openPath(value.state.path); if (message) throw new Error(message) }
    }
  }

  close(owner: WebContents, lease: string): Promise<BrowserCloseResult> {
    const tab = this.tab(owner, lease)
    if (tab.closing) return tab.closing
    const downloads = this.activeDownloads(tab)
    if (downloads.length) {
      const choice = dialog.showMessageBoxSync(this.window(tab), { type: 'question', title: '关闭下载中的标签', message: '未保存的网页内容将关闭，是否继续下载？', buttons: ['关闭标签并继续下载', '取消下载并关闭', '返回网页'], defaultId: 2, cancelId: 2 })
      if (choice === 2) return Promise.resolve({ closed: false, keepMounted: false })
      if (choice === 0) { tab.state.held = true; tab.state.active = false; this.guest(tab).setAudioMuted(true); this.publish(tab); return Promise.resolve({ closed: true, keepMounted: true }) }
      for (const download of downloads) download.item.cancel()
    }
    if (!tab.guest || tab.guest.isDestroyed()) { this.finish(tab); return Promise.resolve({ closed: true, keepMounted: false }) }
    const guest = this.guest(tab), previousUrl = guest.getURL(), attempt = { canceled: false }
    tab.closeAttempt = attempt
    const operation = (async (): Promise<BrowserCloseResult> => {
      // Electron40的webview.close桥会忽略beforeunload取消；公开导航API走Chromium
      // 自身的取消路径。等about:blank提交后才强制销毁，取消必须先等ERR_ABORTED。
      try { await guest.loadURL('about:blank') }
      catch (error) {
        if (guest.isDestroyed()) return { closed: true, keepMounted: false }
        if (attempt.canceled && guest.getURL() === previousUrl) return { closed: false, keepMounted: false }
        throw error
      }
      if (guest.isDestroyed()) return { closed: true, keepMounted: false }
      if (attempt.canceled || guest.getURL() !== 'about:blank') throw new Error('网页未完成关闭确认，原标签保留')
      return await new Promise<BrowserCloseResult>(resolve => { tab.closeResult = resolve; guest.close({ waitForBeforeUnload: false }) })
    })()
    tab.closing = operation
    void operation.finally(() => { if (tab.closing === operation) tab.closing = undefined; if (tab.closeAttempt === attempt) tab.closeAttempt = undefined }).catch(() => {})
    return operation
  }
  release(owner: WebContents, lease: string): void {
    const tab = this.tabs.get(lease)
    if (!tab) return
    if (tab.owner !== owner) throw new Error('网页标签不属于当前窗口')
    if (!tab.state.held) this.destroy(tab)
  }
  private cancelPrompts(tab: Tab): void {
    for (const [id, prompt] of this.prompts) if (prompt.tab === tab) {
      clearTimeout(prompt.timer); this.prompts.delete(id); for (const reply of prompt.replies) reply(null)
      this.send(tab, { type: 'prompt-cancel', scopeId: tab.state.scopeId, tabId: tab.state.tabId, requestId: id })
    }
  }
  prompt(event: IpcMainEvent, message: string, defaultValue: string, kind: 'prompt' | 'alert' | 'confirm' = 'prompt'): void {
    const tab = this.ownerForGuest(event.sender)
    if (!tab || !tab.state.active || event.senderFrame !== event.sender.mainFrame) { event.returnValue = null; return }
    this.ask(tab, event.sender, kind, message, defaultValue, value => { event.returnValue = value })
  }
  private ask(tab: Tab, sender: WebContents, kind: 'prompt' | 'alert' | 'confirm' | 'authentication', message: string, defaultValue: string, reply: (value: string | null) => void, key?: string): void {
    const document = this.documents.get(sender.id) ?? 0
    if (key) {
      const existing = [...this.prompts.values()].find(prompt => prompt.sender === sender && prompt.document === document && prompt.key === key)
      if (existing) { existing.replies.push(reply); return }
    }
    const id = randomUUID()
    const timer = setTimeout(() => {
      const prompt = this.prompts.get(id)
      if (prompt) { this.prompts.delete(id); for (const response of prompt.replies) response(null); this.send(tab, { type: 'prompt-cancel', scopeId: tab.state.scopeId, tabId: tab.state.tabId, requestId: id }) }
    }, 120000)
    this.prompts.set(id, { tab, sender, replies: [reply], timer, document, key })
    this.send(tab, { type: 'prompt', scopeId: tab.state.scopeId, tabId: tab.state.tabId, requestId: id, kind, message: message.slice(0, 10000), defaultValue: defaultValue.slice(0, 10000) })
  }
  promptReply(owner: WebContents, lease: string, requestId: string, value: string | null): void {
    const tab = this.tab(owner, lease), prompt = this.prompts.get(requestId)
    if (!prompt || prompt.tab !== tab || prompt.document !== this.documents.get(prompt.sender.id)) throw new Error('网页输入请求已失效')
    clearTimeout(prompt.timer); this.prompts.delete(requestId); for (const reply of prompt.replies) reply(value)
  }
  private destroy(tab: Tab): void {
    this.cancelPrompts(tab)
    for (const item of this.activeDownloads(tab)) item.item.cancel()
    for (const popup of tab.popups) if (!popup.isDestroyed()) popup.destroy()
    if (tab.guest && !tab.guest.isDestroyed()) tab.guest.close({ waitForBeforeUnload: false })
    this.finish(tab)
  }
  /** WebContents 可以重用，临时授权和未答复的请求只属于旧文档。 */
  private advanceDocument(profile: Profile, guestId: number): number {
    profile.grants.delete(guestId)
    const revision = (this.documents.get(guestId) ?? 0) + 1
    this.documents.set(guestId, revision)
    return revision
  }
  private forgetDocument(profile: Profile, guestId: number): void {
    profile.grants.delete(guestId)
    this.documents.delete(guestId)
  }
  private finish(tab: Tab): void {
    if (!this.tabs.delete(tab.state.lease)) return
    this.cancelPrompts(tab)
    if (tab.guest && !tab.guest.isDestroyed()) this.forgetDocument(tab.profile, tab.guest.id)
    for (const popup of tab.popups) if (!popup.isDestroyed()) popup.destroy()
    this.preview.revoke(tab.state.lease)
    for (const release of tab.cleanup) release()
    this.send(tab, { type: 'released', scopeId: tab.state.scopeId, tabId: tab.state.tabId, lease: tab.state.lease })
    if (tab.profile.private && ![...this.tabs.values()].some(peer => peer.profile === tab.profile)) {
      this.profiles.delete(tab.profile.id)
      tab.profile.lifetime.abort()
      for (const [id, download] of this.downloads) if (download.profile === tab.profile) this.downloads.delete(id)
        void tab.profile.session.closeAllConnections().then(() => tab.profile.session.clearStorageData()).then(() => tab.profile.session.clearAuthCache()).then(() => tab.profile.session.clearCache()).catch(error => console.error('临时浏览数据清理失败', error))
    }
  }
}

let runtime: BrowserTabRuntime | undefined
export function installBrowserRuntime(deps: BrowserRuntimeDeps): BrowserTabRuntime { runtime = new BrowserTabRuntime(deps); return runtime }
export function configureBrowserAttachment(owner: WebContents, preferences: WebPreferences, params: Record<string, string>): boolean | undefined { return runtime?.configureAttachment(owner, preferences, params) }
