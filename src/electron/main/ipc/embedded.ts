/**
 * embedded 域 IPC：内嵌页面 demo 窗口（阶段 3a 验收载体）。
 *
 * 形态：独立 BrowserWindow（console 同款）+ hash '#embedded' 分流到容器
 * 组件，容器里放 <webview src="demo.html">（guest 沙箱由 webview-policy
 * 在 will-attach-webview 硬化，preload 也由它指定 —— 本窗口的 webPreferences
 * 与 console 同配，它只是宿主，真正的页面边界在 guest 侧）。
 * 单例语义同 console：已开则聚焦。
 */
import { registerTrustedContents } from './trusted'
import { handleTrusted } from './trusted'
import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { IPC } from '../../../shared/ipc'

let embeddedWindow: BrowserWindow | null = null

function createEmbeddedWindow(): void {
  embeddedWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'Cogent 内嵌页面 demo',
    webPreferences: {
      // 宿主容器配置：webviewTag 是放 <webview> 的前提（Electron 默认关）；
      // CJS 主 preload 在 sandbox 运行（与主窗口一致）。guest 的硬化
      // 不在这里 —— 在 webview-policy 的 will-attach-webview（那个才是页面边界）
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
      preload: join(import.meta.dirname, '../preload/index.cjs')
    }
  })

  registerTrustedContents(embeddedWindow.webContents, 'embedded')

  embeddedWindow.on('ready-to-show', () => embeddedWindow?.show())

  // 外部链接走系统浏览器（与主窗口/console 同策略）
  embeddedWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  embeddedWindow.on('closed', () => {
    embeddedWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.hash = 'embedded'
    void embeddedWindow.loadURL(url.toString())
  } else {
    void embeddedWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: 'embedded' })
  }
}

export function registerEmbeddedIpc(): void {
  handleTrusted(IPC.embeddedOpen, () => {
    if (embeddedWindow && !embeddedWindow.isDestroyed()) embeddedWindow.focus()
    else createEmbeddedWindow()
  })
}
