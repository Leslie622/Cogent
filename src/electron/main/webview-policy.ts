/**
 * webview 附加硬化（决定 30，借鉴 zcode pluginSandbox/guestPolicy.ts:24-58）：
 * renderer 传来的 webPreferences 与 params 一律视为不可信输入 —— 在
 * will-attach-webview 钩子里推倒重建：强制沙箱/contextIsolation/webSecurity、
 * 删除全部 Node 口子、preload 只认 Cogent 的 guest preload、src 只认
 * 白名单页面。renderer 写了 preload/src 也会被覆盖，配置失误不可能把
 * 未硬化页面放出去。
 */
import { app, type WebContents } from 'electron'
import { join } from 'node:path'
import { appDocument, isAppDocument, isTrustedContents, registerTrustedContents } from './ipc/trusted'
import { configureBrowserAttachment } from './browser/runtime'

/** guest preload 唯一允许的路径（构建产物 out/preload/guest.cjs） */
export function guestPreloadPath(): string {
  return join(import.meta.dirname, '../preload/guest.cjs')
}

/** 3a 页面白名单：demo 页（与宿主同源的静态页）。真实第三方页面接入时扩表 */
const trustedGuests = new WeakSet<WebContents>()
export function isTrustedAppGuest(guest: WebContents): boolean { return trustedGuests.has(guest) && isTrustedContents(guest, ['guest']) }

export function hardenWebviewAttachment(): void {
  app.on('web-contents-created', (_event, contents) => {
    const pending: boolean[] = []
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      if (!isTrustedContents(contents, ['main', 'embedded'])) { event.preventDefault(); return }
      const browser = configureBrowserAttachment(contents, webPreferences, params)
      if (browser !== undefined) { if (!browser) event.preventDefault(); else pending.push(false); return }
      if (!isAppDocument(params.src, 'demo.html')) { event.preventDefault(); return }
      // webPreferences 推倒重建：只留硬化的最小集 + 我们的 guest preload
      delete webPreferences.nodeIntegration
      delete webPreferences.nodeIntegrationInWorker
      delete webPreferences.nodeIntegrationInSubFrames
      delete webPreferences.webviewTag
      delete webPreferences.enableBlinkFeatures
      delete webPreferences.experimentalFeatures
      webPreferences.sandbox = true
      webPreferences.contextIsolation = true
      webPreferences.webSecurity = true
      webPreferences.preload = guestPreloadPath()
      pending.push(true)
    })
    contents.on('did-attach-webview', (_event, guest) => {
      // browser-dialog preload 与可信应用 SDK 是两个独立身份，不能只凭 webview 类型发票据。
      if (pending.shift() === true && guest.hostWebContents === contents) {
        trustedGuests.add(guest)
        registerTrustedContents(guest, 'guest', appDocument('demo.html'), contents)
      }
    })
  })
}
