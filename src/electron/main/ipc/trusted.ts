/** 壳 IPC 的统一身份边界：角色、当前文档、顶层 frame 与文档代次缺一不可。 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IPC } from '../../../shared/ipc'

type Role = 'main' | 'console' | 'embedded' | 'guest'
interface Identity { role: Role; document: string; generation: number; owner?: WebContents }
const callers = new AsyncLocalStorage<() => void>()
export function checkCurrentCaller(): void { callers.getStore()?.() }
const identities = new WeakMap<WebContents, Identity>()

function documentKey(raw: string): string {
  const url = new URL(raw)
  url.hash = ''
  if (url.protocol === 'file:') {
    const path = realpathSync.native(fileURLToPath(url))
    return pathToFileURL(process.platform === 'win32' ? path.toLowerCase() : path).href + url.search
  }
  return url.href
}
export function appDocument(page = 'index.html'): string {
  return process.env.ELECTRON_RENDERER_URL
    ? new URL(page === 'index.html' ? process.env.ELECTRON_RENDERER_URL : page, process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(join(import.meta.dirname, '../renderer', page)).href
}
export function isAppDocument(raw: string, page = 'index.html'): boolean {
  try { return documentKey(raw) === documentKey(appDocument(page)) } catch { return false }
}
export function isTrustedContents(contents: WebContents, roles: readonly Role[] = ['main', 'console', 'embedded']): boolean {
  const identity = identities.get(contents)
  if (!identity || contents.isDestroyed() || !roles.includes(identity.role)) return false
  try {
    return documentKey(contents.getURL()) === identity.document &&
      (!identity.owner || isTrustedContents(identity.owner, ['main', 'embedded']))
  } catch { return false }
}
export function registerTrustedContents(contents: WebContents, role: Role, document = appDocument(), owner?: WebContents): void {
  const identity: Identity = { role, document: documentKey(document), generation: 0, owner }
  identities.set(contents, identity)
  const allow = (url: string): boolean => {
    try { return documentKey(url) === identity.document } catch { return false }
  }
  contents.on('will-frame-navigate', event => { if (event.isMainFrame && !allow(event.url)) event.preventDefault() })
  contents.on('will-redirect', (event, url, _inPlace, mainFrame) => { if (mainFrame && !allow(url)) event.preventDefault() })
  contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) identity.generation++ })
  contents.on('render-process-gone', () => { identity.generation++ })
  contents.once('destroyed', () => identities.delete(contents))
}
export function captureCaller(event: IpcMainInvokeEvent, roles: readonly Role[]): () => void {
  const identity = identities.get(event.sender)
  const frame = event.senderFrame
  const generation = identity?.generation
  const check = (): void => {
    if (!identity || identities.get(event.sender) !== identity || identity.generation !== generation ||
        !isTrustedContents(event.sender, roles) || !frame || frame !== event.sender.mainFrame || frame.isDestroyed() ||
        documentKey(frame.url) !== identity.document) throw new Error('IPC 调用页面未获授权或文档已失效')
  }
  check()
  return check
}
const common = new Set<string>([IPC.appStatus, IPC.windowClose, IPC.windowMinimize, IPC.windowMaximizeToggle, IPC.settingsGet])
/** 所有特权 invoke 都经此入口，拒绝 iframe；异步结果也不交给后来的文档。 */
export function handleTrusted(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const roles: Role[] = channel === IPC.guestCredentials ? ['guest'] :
      channel === IPC.engineRequest || common.has(channel) ? ['main', 'console', 'embedded'] : ['main']
    const check = captureCaller(event, roles)
    if (channel === IPC.engineRequest && identities.get(event.sender)!.role !== 'main') {
      const method = (args[0] as { method?: unknown } | undefined)?.method
      if (!['inspect.entries', 'inspect.entry', 'session.list', 'session.messages'].includes(String(method)))
        throw new Error('此窗口无权调用该引擎方法')
    }
    const result: unknown = await callers.run(check, () => {
      const response: unknown = listener(event, ...args)
      return response
    })
    check()
    return result
  })
}
