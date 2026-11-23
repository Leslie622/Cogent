import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'
import type { BrowserEvent } from '../../../../src/shared/browser'
import { BAIDU_HOT_SEARCH_EXTERNAL_URL, BAIDU_HOT_SEARCH_URL } from './fixtures'
const mocks = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(), fromPartition: vi.fn<(partition: string) => unknown>(),
  fromId: vi.fn<(id: number) => unknown>(), question: vi.fn<() => Promise<{ response: number }>>(), questionSync: vi.fn<() => number>(),
  openExternal: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  app: { on: vi.fn(), getPath: vi.fn<(key: string) => string>(), getApplicationNameForProtocol: vi.fn<(url: string) => string>() },
}))
vi.mock('electron', () => ({
  app: mocks.app, session: { fromPartition: mocks.fromPartition }, webContents: { fromId: mocks.fromId },
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) }, dialog: { showMessageBox: mocks.question, showMessageBoxSync: mocks.questionSync },
  shell: { openExternal: mocks.openExternal, openPath: vi.fn(), showItemInFolder: vi.fn() }, clipboard: { writeText: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() }, protocol: { registerSchemesAsPrivileged: vi.fn() },
}))
import { BrowserTabRuntime } from '../../../../src/electron/main/browser/runtime'
import { BrowserSettings } from '../../../../src/electron/main/browser/settings'

class ProfileSession extends EventEmitter {
  protocol = { handle: vi.fn() }
  webRequest = { onBeforeRequest: vi.fn() }
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  setDevicePermissionHandler = vi.fn()
  setDisplayMediaRequestHandler = vi.fn()
  clearStorageData = vi.fn().mockResolvedValue(undefined)
  clearCache = vi.fn().mockResolvedValue(undefined)
  clearAuthCache = vi.fn().mockResolvedValue(undefined)
  closeAllConnections = vi.fn().mockResolvedValue(undefined)
}
class Contents extends EventEmitter {
  id = 1
  mainFrame = {}
  hostWebContents: WebContents | null = null
  session: Session = {} as Session
  url = ''
  destroyed = false
  title = '网页'
  type = 'window'
  entries = [{ url: 'about:blank', title: '' }, { url: 'https://example.org', title: '普通', pageState: 'secret' }]
  navigationHistory = { canGoBack: () => true, canGoForward: () => false, getAllEntries: () => this.entries, getActiveIndex: () => 1, length: () => this.entries.length, goToIndex: vi.fn(), removeEntryAtIndex: vi.fn() }
  send = vi.fn()
  focus = vi.fn()
  getURL = () => this.url
  getType = () => this.type
  getTitle = () => this.title
  isDestroyed = () => this.destroyed
  isFocused = () => false
  isLoading = () => false
  getZoomFactor = () => 1
  setWindowOpenHandler = vi.fn()
  setAudioMuted = vi.fn()
  findInPage = vi.fn()
  close = () => { this.destroyed = true; this.emit('destroyed') }
  loadURL = vi.fn((url: string) => { this.url = url; return Promise.resolve() })
}
class Download extends EventEmitter {
  getFilename = () => 'report.txt'
  getTotalBytes = () => 100
  getReceivedBytes = () => 20
  isPaused = () => false
  getSavePath = () => 'C:/test/report.txt'
  setSaveDialogOptions = vi.fn()
  cancel = vi.fn()
}
let root = ''
let oldRoot: string | undefined
beforeEach(() => {
  vi.clearAllMocks(); mocks.sessions.clear()
  oldRoot = process.env.COGENT_HOME; root = mkdtempSync(join(tmpdir(), 'cogent-browser-test-')); process.env.COGENT_HOME = root
  mocks.app.getPath.mockImplementation(() => root)
  mocks.app.getApplicationNameForProtocol.mockReturnValue('其他浏览器')
  mocks.question.mockResolvedValue({ response: 0 }); mocks.questionSync.mockReturnValue(0)
  mocks.fromPartition.mockImplementation(partition => { let value = mocks.sessions.get(partition); if (!value) { value = new ProfileSession(); mocks.sessions.set(partition, value) } return value })
})
afterEach(() => { if (oldRoot === undefined) delete process.env.COGENT_HOME; else process.env.COGENT_HOME = oldRoot; rmSync(root, { recursive: true, force: true }) })
function ready(privateGroupId?: string) {
  const runtime = new BrowserTabRuntime({ getProtectedPorts: () => [19200] })
  const owner = new Contents()
  const reservation = runtime.reserve(owner as unknown as WebContents, { scopeId: 'draft', tabId: 'tab', privateGroupId })
  const guest = new Contents(); guest.id = 2; guest.type = 'webview'; guest.hostWebContents = owner as unknown as WebContents; guest.session = mocks.sessions.get(reservation.partition) as Session; guest.url = reservation.bootstrapUrl
  mocks.fromId.mockReturnValue(guest)
  runtime.attach(owner as unknown as WebContents, reservation.lease, guest.id)
  return { runtime, ownerCalls: owner.send.mock.calls, owner: owner as unknown as WebContents, guest, reservation, profile: guest.session as unknown as ProfileSession }
}
describe('浏览器资源身份与生命周期', () => {
  it('其他默认浏览器接收完整地址，百度查询的中文编码、加号与所有参数保持原样', async () => {
    const { runtime, owner, reservation, guest } = ready()
    const urls = [
      'https://www.baidu.com/',
      BAIDU_HOT_SEARCH_URL,
    ]
    for (const url of urls) {
      guest.url = url
      guest.emit('did-navigate')
      await runtime.external(owner, reservation.lease)
    }
    expect(mocks.openExternal.mock.calls).toEqual(urls.map(url => [url]))
  })
  it.runIf(process.platform === 'win32')('默认 Edge 交接已兼容地址，内置网页的地址与历史不变', async () => {
    const { runtime, owner, reservation, guest } = ready()
    mocks.app.getApplicationNameForProtocol.mockReturnValue('Microsoft Edge')
    guest.url = BAIDU_HOT_SEARCH_URL
    guest.entries = [{ url: BAIDU_HOT_SEARCH_URL, title: '百度热榜搜索', pageState: '' }]
    guest.emit('did-navigate')
    await runtime.external(owner, reservation.lease)
    expect(mocks.openExternal).toHaveBeenCalledWith(BAIDU_HOT_SEARCH_EXTERNAL_URL)
    expect(runtime.state(owner, reservation.lease).url).toBe(BAIDU_HOT_SEARCH_URL)
    expect(runtime.history(owner, reservation.lease).entries[0].url).toBe(BAIDU_HOT_SEARCH_URL)
    expect(mocks.app.getApplicationNameForProtocol).toHaveBeenCalledWith(BAIDU_HOT_SEARCH_URL)
  })
  it('普通地址直接交给系统，不查询浏览器关联或改写参数', async () => {
    const { runtime, owner, reservation, guest } = ready()
    guest.url = 'https://example.org/s?wd=a+b&tn=baidutop10'
    guest.emit('did-navigate')
    await runtime.external(owner, reservation.lease)
    expect(mocks.app.getApplicationNameForProtocol).not.toHaveBeenCalled()
    expect(mocks.openExternal).toHaveBeenCalledWith(guest.url)
  })
  it('系统浏览器打开失败向调用方报告，受保护端口与本地协议不交给系统', async () => {
    const { runtime, owner, reservation, guest } = ready()
    guest.url = 'https://www.baidu.com/'
    guest.emit('did-navigate')
    mocks.openExternal.mockRejectedValueOnce(new Error('系统拒绝打开地址'))
    await expect(runtime.external(owner, reservation.lease)).rejects.toThrow('系统拒绝打开地址')
    mocks.openExternal.mockClear()
    for (const url of ['http://localhost:19200/', 'file:///C:/secret.html']) {
      guest.url = url
      guest.emit('did-navigate')
      await expect(runtime.external(owner, reservation.lease)).rejects.toThrow()
    }
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
  it.each([undefined, 'private-startup'])('同标签两次初始化各持独立lease，旧effect迟到释放不能撤销新webview授权：%s', (privateGroupId) => {
    const runtime = new BrowserTabRuntime({ getProtectedPorts: () => [] })
    const owner = new Contents() as unknown as WebContents
    const first = runtime.reserve(owner, { scopeId: 'draft', tabId: 'strict-tab', privateGroupId })
    const second = runtime.reserve(owner, { scopeId: 'draft', tabId: 'strict-tab', privateGroupId })
    expect(second.lease).not.toBe(first.lease)
    runtime.release(owner, first.lease)
    expect(() => runtime.state(owner, first.lease)).toThrow('已关闭')
    expect(runtime.state(owner, second.lease).lease).toBe(second.lease)
    expect(runtime.configureAttachment(owner, {}, { src: first.bootstrapUrl, partition: first.partition })).toBe(false)
    expect(runtime.configureAttachment(owner, {}, { src: second.bootstrapUrl, partition: second.partition })).toBe(true)
    runtime.release(owner, second.lease)
  })
  it('Basic/Proxy身份验证合并同文档请求，答复后不持有凭据，导航取消旧回调', () => {
    const { runtime, owner, ownerCalls, reservation, guest } = ready()
    runtime.visibility(owner, reservation.lease, true)
    const challenge = { isProxy: false, host: 'example.org', port: 443, realm: 'private', scheme: 'basic' }
    const first = vi.fn(), second = vi.fn()
    const event = { preventDefault: vi.fn() }
    guest.emit('login', event, { url: 'https://example.org/private' }, challenge, first)
    guest.emit('login', event, { url: 'https://example.org/private' }, challenge, second)
    const prompts = ownerCalls.map(call => call[1] as BrowserEvent).filter(value => value.type === 'prompt')
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]
    expect(prompt).toMatchObject({ kind: 'authentication' })
    runtime.promptReply(owner, reservation.lease, prompt.requestId, JSON.stringify({ username: 'user', password: 'test-secret' }))
    expect(first).toHaveBeenCalledWith('user', 'test-secret')
    expect(second).toHaveBeenCalledWith('user', 'test-secret')
    expect(() => runtime.promptReply(owner, reservation.lease, prompt.requestId, 'again')).toThrow('失效')
    expect(JSON.stringify(runtime.history(owner, reservation.lease))).not.toContain('test-secret')
    const pending = vi.fn()
    guest.emit('login', event, { url: 'https://example.org/proxy' }, { ...challenge, isProxy: true }, pending)
    guest.emit('did-start-navigation', {}, 'https://example.org/new', false, true)
    expect(pending).toHaveBeenCalledExactlyOnceWith()
    runtime.visibility(owner, reservation.lease, false)
    const hidden = vi.fn()
    guest.emit('login', event, { url: 'https://example.org/proxy' }, challenge, hidden)
    expect(hidden).toHaveBeenCalledExactlyOnceWith()
    runtime.release(owner, reservation.lease)
  })
  it('lease 只接受同窗口和一次附加，renderer 的 Node/preload 偏好被推倒重建', () => {
    const runtime = new BrowserTabRuntime({ getProtectedPorts: () => [] }), owner = new Contents()
    const value = runtime.reserve(owner as unknown as WebContents, { scopeId: 'a', tabId: 'b' })
    const preferences = { nodeIntegration: true, preload: 'evil.js', webviewTag: true }
    const params = { src: value.bootstrapUrl, partition: value.partition, nodeintegration: 'true', disablewebsecurity: 'true' }
    expect(runtime.configureAttachment(new Contents() as unknown as WebContents, preferences, params)).toBe(false)
    expect(runtime.configureAttachment(owner as unknown as WebContents, preferences, params)).toBe(true)
    expect(preferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false })
    expect(preferences.preload).toContain('browser-dialog.cjs')
    expect(params).not.toHaveProperty('nodeintegration')
    expect(runtime.configureAttachment(owner as unknown as WebContents, preferences, params)).toBe(false)
    expect(() => runtime.state(new Contents() as unknown as WebContents, value.lease)).toThrow('不属于')
  })
  it('不能用主窗口或别窗口的 WebContents 冒充网页 guest', () => {
    const { runtime, owner, reservation } = ready()
    mocks.fromId.mockReturnValue(owner)
    expect(() => runtime.attach(owner, reservation.lease, 1)).toThrow('不匹配')
  })
  it('历史不导出 pageState，公开索引仍命中正确 native entry', async () => {
    const { runtime, owner, reservation, guest } = ready()
    expect(runtime.history(owner, reservation.lease)).toEqual({ entries: [{ url: 'https://example.org', title: '普通' }], index: 0 })
    runtime.goTo(owner, reservation.lease, 0)
    expect(guest.navigationHistory.goToIndex).toHaveBeenCalledWith(1)
    await expect(runtime.restore(owner, reservation.lease, [{ url: 'http://other:19200', title: '' }], 0)).rejects.toThrow('受保护')
  })
  it('私密组不导出历史，最后网页释放后清掉站点存储', async () => {
    const { runtime, owner, reservation, profile } = ready('private-group')
    expect(reservation.partition.startsWith('persist:')).toBe(false)
    expect(runtime.history(owner, reservation.lease)).toEqual({ entries: [], index: -1 })
    runtime.release(owner, reservation.lease)
    await Promise.resolve()
    expect(profile.clearStorageData).toHaveBeenCalledOnce()
  })
  it('新查找必须开启原生session，继续查找才复用上次请求', () => {
    const { runtime, owner, reservation, guest } = ready()
    runtime.find(owner, reservation.lease, 'hello')
    runtime.find(owner, reservation.lease, 'hello', true, true)
    expect(guest.findInPage.mock.calls).toEqual([['hello', { forward: true, findNext: true }], ['hello', { forward: true, findNext: false }]])
  })
  it('摄像头的持久允许不能自动放行麦克风；弹窗导航使旧的一次授权失效', async () => {
    const { runtime, owner, reservation, profile, guest } = ready()
    runtime.visibility(owner, reservation.lease, true)
    const handler = profile.setPermissionRequestHandler.mock.calls[0][0] as (guest: WebContents, permission: string, callback: (value: boolean) => void, details: { requestingUrl: string; mediaTypes: string[] }) => void
    const check = profile.setPermissionCheckHandler.mock.calls[0][0] as (guest: WebContents, permission: string, origin: string, details: { mediaType: string }) => boolean
    const camera = vi.fn()
    mocks.question.mockResolvedValueOnce({ response: 1 })
    handler(guest as unknown as WebContents, 'media', camera, { requestingUrl: 'https://example.org', mediaTypes: ['video'] })
    await vi.waitFor(() => expect(camera).toHaveBeenCalledWith(true))
    expect(check(guest as unknown as WebContents, 'media', 'https://example.org', { mediaType: 'video' })).toBe(true)
    expect(check(guest as unknown as WebContents, 'media', 'https://example.org', { mediaType: 'audio' })).toBe(false)
    const popupGuest = new Contents(); popupGuest.id = 3
    const popup = Object.assign(new EventEmitter(), { webContents: popupGuest, isDestroyed: () => false, reload: vi.fn() })
    guest.emit('did-create-window', popup)
    const microphone = vi.fn()
    handler(popupGuest as unknown as WebContents, 'media', microphone, { requestingUrl: 'https://example.org', mediaTypes: ['audio'] })
    await vi.waitFor(() => expect(microphone).toHaveBeenCalledWith(true))
    expect(check(popupGuest as unknown as WebContents, 'media', 'https://example.org', { mediaType: 'audio' })).toBe(true)
    popupGuest.emit('did-start-navigation', {}, 'https://example.org/new', false, true)
    expect(check(popupGuest as unknown as WebContents, 'media', 'https://example.org', { mediaType: 'audio' })).toBe(false)
  })
  it('关闭标签后 DownloadHold 仍保留 guest，完成才释放', async () => {
    const { runtime, owner, reservation, profile, guest } = ready()
    const item = new Download()
    profile.emit('will-download', {}, item, guest)
    await expect(runtime.close(owner, reservation.lease)).resolves.toEqual({ closed: true, keepMounted: true })
    expect(guest.destroyed).toBe(false)
    item.emit('done', {}, 'completed')
    expect(guest.destroyed).toBe(true)
    expect(() => runtime.state(owner, reservation.lease)).toThrow('已关闭')
  })
  it('关闭先用真实导航协商，取消等本次abort后保留同guest，再确认才强制close', async () => {
    const { runtime, owner, reservation, guest } = ready()
    guest.url = 'https://example.org/form'; const close = vi.spyOn(guest, 'close')
    let abort!: () => void
    mocks.questionSync.mockReturnValue(1)
    guest.loadURL.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      const event = { preventDefault: vi.fn() }; guest.emit('will-prevent-unload', event)
      expect(event.preventDefault).not.toHaveBeenCalled()
      abort = () => reject(new Error('ERR_ABORTED'))
    }))
    const cancelled = runtime.close(owner, reservation.lease); let settled = false
    void cancelled.then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false); expect(close).not.toHaveBeenCalled()
    abort(); await expect(cancelled).resolves.toEqual({ closed: false, keepMounted: false })
    expect(guest.destroyed).toBe(false); expect(guest.url).toBe('https://example.org/form')
    expect(runtime.state(owner, reservation.lease).lease).toBe(reservation.lease)
    mocks.questionSync.mockReturnValue(0)
    guest.loadURL.mockImplementationOnce(url => {
      const event = { preventDefault: vi.fn() }; guest.emit('will-prevent-unload', event)
      expect(event.preventDefault).toHaveBeenCalledOnce(); guest.url = url; return Promise.resolve()
    })
    await expect(runtime.close(owner, reservation.lease)).resolves.toEqual({ closed: true, keepMounted: false })
    expect(guest.loadURL).toHaveBeenCalledWith('about:blank')
    expect(close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false }); expect(guest.destroyed).toBe(true)
  })
  it.each(['HTTP', 'HTML'])('关闭%s探测不把空白URL/标题/来源写回标签或已恢复历史', async kind => {
    const { runtime, owner, ownerCalls, reservation, guest } = ready()
    if (kind === 'HTTP') await runtime.restore(owner, reservation.lease, [{ url: 'https://example.org/form', title: '原始标题' }], 0)
    else await runtime.localPreviewSource(owner, reservation.lease, { kind: 'delivery', path: join(root, 'report.html'), readResource: vi.fn(), release: vi.fn().mockResolvedValue(undefined) })
    guest.title = '保留标题'; guest.emit('page-title-updated')
    const original = runtime.state(owner, reservation.lease), close = guest.close
    ownerCalls.length = 0
    let historyAtClose: ReturnType<BrowserTabRuntime['history']> | undefined
    vi.spyOn(guest, 'close').mockImplementation(() => { historyAtClose = runtime.history(owner, reservation.lease); close() })
    guest.loadURL.mockImplementationOnce(url => {
      guest.url = url; guest.title = ''; guest.emit('did-navigate', {}, url); guest.emit('page-title-updated'); return Promise.resolve()
    })
    await runtime.close(owner, reservation.lease)
    const states = ownerCalls.map(([, event]) => event as BrowserEvent).filter((event): event is Extract<BrowserEvent, { type: 'state' }> => event.type === 'state')
    expect(states.length).toBeGreaterThan(0)
    for (const event of states) expect(event.state).toMatchObject({ url: original.url, title: original.title, localFile: original.localFile })
    if (kind === 'HTTP') expect(historyAtClose?.entries).toEqual([{ url: 'https://example.org/form', title: '保留标题' }])
    else expect(original.localFile).toBe(join(root, 'report.html'))
  })
  it('系统下载目录不可用时仍能创建原生保存对话框与下载任务', () => {
    const { runtime, owner, reservation, profile, guest } = ready()
    mocks.app.getPath.mockImplementation(() => { throw new Error("Failed to get 'downloads' path") })
    const item = new Download()
    expect(() => profile.emit('will-download', {}, item, guest)).not.toThrow()
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({ title: '保存下载文件', defaultPath: 'report.txt', properties: ['showOverwriteConfirmation', 'createDirectory'] })
    expect(runtime.listDownloads(owner, reservation.lease)).toMatchObject([{ name: 'report.txt', state: 'progressing' }])
    item.emit('done', {}, 'completed')
    expect(runtime.listDownloads(owner, reservation.lease)).toMatchObject([{ name: 'report.txt', state: 'completed' }])
  })
  it('后台页不能创建popup，正常关闭私密标签销毁全部子窗口后清站点数据', async () => {
    const { runtime, owner, reservation, guest, profile } = ready('private-popup')
    const open = guest.setWindowOpenHandler.mock.calls[0][0] as (details: { url: string; disposition: string }) => { action: string }
    expect(open({ url: 'https://example.org', disposition: 'new-window' })).toEqual({ action: 'deny' })
    runtime.visibility(owner, reservation.lease, true)
    const popupGuest = new Contents(); popupGuest.id = 3
    let closed = false
    const popup = Object.assign(new EventEmitter(), { webContents: popupGuest, isDestroyed: () => closed, destroy: vi.fn(() => { closed = true; popup.emit('closed') }) })
    guest.emit('did-create-window', popup)
    await expect(runtime.close(owner, reservation.lease)).resolves.toEqual({ closed: true, keepMounted: false })
    expect(closed).toBe(true)
    expect(popup.destroy).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(profile.clearStorageData).toHaveBeenCalledOnce())
    expect(profile.closeAllConnections).toHaveBeenCalledOnce()
  })
  it('替换HTML预览成功后只保留当前grant，旧URL失效且旧文件租约释放', async () => {
    const { runtime, owner, reservation, guest, profile } = ready()
    const source = (name: string) => ({ kind: 'delivery' as const, path: join(root, name + '.html'), readResource: vi.fn().mockResolvedValue({ bytes: new TextEncoder().encode(name), mime: 'text/html' }), release: vi.fn().mockResolvedValue(undefined) })
    const first = source('first'), second = source('second')
    await runtime.localPreviewSource(owner, reservation.lease, first); const oldUrl = guest.url
    guest.loadURL.mockImplementationOnce(url => { guest.url = url; guest.entries = [{ url: 'https://example.org', title: 'HTTP' }, { url: oldUrl, title: 'old' }, { url, title: 'new' }]; return Promise.resolve() })
    guest.navigationHistory.getActiveIndex = () => 2
    await runtime.localPreviewSource(owner, reservation.lease, second); const newUrl = guest.url
    const respond = profile.protocol.handle.mock.calls.find(([name]) => name === 'cogent-preview')![1] as (request: Request) => Promise<Response>
    expect((await respond(new Request(oldUrl))).status).toBe(403)
    expect(await (await respond(new Request(newUrl))).text()).toBe('second')
    expect(first.release).toHaveBeenCalledOnce(); expect(second.release).not.toHaveBeenCalled()
    expect(guest.navigationHistory.removeEntryAtIndex).toHaveBeenCalledExactlyOnceWith(1)
    runtime.release(owner, reservation.lease)
    expect(second.release).toHaveBeenCalledOnce()
  })
  it.each(['authorize', 'navigate', 'aborted'])('HTML新%s失败只释放新来源，旧授权与可用页面保留', async failure => {
    const { runtime, owner, reservation, guest, profile } = ready()
    const first = { kind: 'delivery' as const, path: join(root, 'first.html'), readResource: vi.fn().mockResolvedValue({ bytes: new TextEncoder().encode('first'), mime: 'text/html' }), release: vi.fn().mockResolvedValue(undefined) }
    await runtime.localPreviewSource(owner, reservation.lease, first); const oldUrl = guest.url
    const second = { ...first, kind: failure === 'authorize' ? 'current' as const : 'delivery' as const, path: join(root, 'missing.html'), release: vi.fn().mockResolvedValue(undefined) }
    if (failure !== 'authorize') guest.loadURL.mockRejectedValueOnce(new Error(failure === 'aborted' ? 'ERR_ABORTED' : 'ERR_FAILED'))
    await expect(runtime.localPreviewSource(owner, reservation.lease, second)).rejects.toThrow()
    const respond = profile.protocol.handle.mock.calls.find(([name]) => name === 'cogent-preview')![1] as (request: Request) => Promise<Response>
    expect(await (await respond(new Request(oldUrl))).text()).toBe('first')
    expect(guest.url).toBe(oldUrl); expect(first.release).not.toHaveBeenCalled(); expect(second.release).toHaveBeenCalledOnce()
    expect(runtime.state(owner, reservation.lease).localFile).toBe(first.path)
  })
  it('HTML并发替换的迟到成功不撤销较新的预览授权', async () => {
    const { runtime, owner, reservation, guest, profile } = ready()
    let finish!: () => void
    guest.loadURL.mockImplementationOnce(url => { guest.url = url; return new Promise<void>(resolve => { finish = resolve }) })
    const first = { kind: 'delivery' as const, path: join(root, 'first.html'), readResource: vi.fn().mockResolvedValue({ bytes: new TextEncoder().encode('first'), mime: 'text/html' }), release: vi.fn().mockResolvedValue(undefined) }
    const second = { ...first, path: join(root, 'second.html'), release: vi.fn().mockResolvedValue(undefined) }
    const pending = runtime.localPreviewSource(owner, reservation.lease, first)
    const rejected = expect(pending).rejects.toThrow('已被替换')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await runtime.localPreviewSource(owner, reservation.lease, second); const newUrl = guest.url
    finish(); await rejected
    const respond = profile.protocol.handle.mock.calls.find(([name]) => name === 'cogent-preview')![1] as (request: Request) => Promise<Response>
    expect((await respond(new Request(newUrl))).status).toBe(200)
    expect(first.release).toHaveBeenCalledOnce(); expect(second.release).not.toHaveBeenCalled()
  })
  it('站点策略原子写后可恢复，坏数据不能静默覆盖成默认', () => {
    const settings = new BrowserSettings(root)
    settings.set('https://example.org', 'media', 'allow')
    expect(new BrowserSettings(root).get('https://example.org', 'media')).toBe('allow')
    settings.set('https://example.org', 'media', 'ask')
    expect(new BrowserSettings(root).get('https://example.org', 'media')).toBe('ask')
    writeFileSync(join(root, 'browser-settings.json'), '{broken')
    expect(() => new BrowserSettings(root)).toThrow()
  })
})
