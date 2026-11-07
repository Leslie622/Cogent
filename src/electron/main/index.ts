import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { AgentServiceManager } from './service/manager'
import { CredentialStore } from './credentials/store'
import { CustomProvidersStore } from './custom-providers/store'
import { registerIpc } from './ipc'
import { IPC } from '../../shared/ipc'

let mainWindow: BrowserWindow | null = null
let agentService: AgentServiceManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Cogent',
    // 无边框：系统标题栏去掉，由 renderer 自绘头部（拖拽区 + 窗口控制按钮，
    // 窗口控制走 ipc/window.ts；头部视觉按 UI 设计方针逐件重写）。
    frame: false,
    webPreferences: {
      // ESM preload（.mjs）要求关闭 sandbox；contextIsolation 始终保持开启，
      // renderer 只能通过 preload 暴露的窄接口访问主进程。
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, '../preload/index.mjs')
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 最大化状态变化推给 renderer：自绘 header 的最大化/还原图标需要跟随切换
  const sendWindowState = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.windowState, mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)

  // 外部链接交给系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // DevTools：F12 切换（Electron 不内建此键；Ctrl+Shift+I 是 Chromium 内建键）。
  // 显式 openDevTools({ mode: 'detach' }) 而非 toggleDevTools()：后者无参数，
  // 会沿用 Chromium 默认的右停靠（吃掉应用窗口宽度）——这里始终开成独立窗口
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12') return
    if (!mainWindow || mainWindow.isDestroyed()) return
    const wc = mainWindow.webContents
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools()
    } else {
      wc.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// 入口 fire-and-forget（void 标记）：whenReady 之后的失败都在各自边界内处理
void app.whenReady().then(() => {
  // 凭据存取（safeStorage）：先守可用性再建引擎代理 —— key 落不了盘时让问题
  // 在启动期暴露，而不是用户第一次保存 key 时才炸。
  const credentialStore = new CredentialStore()
  try {
    credentialStore.assertAvailable()
  } catch (error) {
    console.error('[main] credential store unavailable:', error)
  }
  const customProvidersStore = new CustomProvidersStore()

  // 引擎代理：握手时把宿主持久化的 key 灌进引擎内存表
  agentService = new AgentServiceManager({
    entryPath: join(import.meta.dirname, 'service.js'),
    handshakeCredentials: credentialStore.readAll()
  })
  registerIpc({ service: agentService, getWindow: () => mainWindow }, credentialStore, customProvidersStore)

  // 壳与引擎解耦：引擎起不来（缺 Node / 版本不符）不阻塞窗口，状态经 app:status
  // 暴露给 UI 呈现（preload.getStatus）。fire-and-forget 是刻意为之（void 标记）。
  void agentService.start().then(
    () => console.log(`[main] agent service ready (node ${agentService?.getStatus().nodeVersion ?? '?'})`),
    (error: unknown) => console.error('[main] agent service start failed:', error)
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  agentService?.stop()
  if (process.platform !== 'darwin') app.quit()
})
