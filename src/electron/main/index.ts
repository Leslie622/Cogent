import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { AgentServiceManager } from './service/manager'
import { registerIpc } from './ipc'

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

  // 外部链接交给系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
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
  // 引擎事件出口：骨架期先打到终端日志，便于诊断"两跳"链路；
  // TODO(事件转发)：renderer 按域订阅后，在 ipc/ 里接入 webContents.send。
  agentService = new AgentServiceManager({
    entryPath: join(import.meta.dirname, 'service.js'),
    onEvent: (event) => {
      console.log('[main] engine event:', JSON.stringify(event))
    }
  })
  registerIpc({ service: agentService, getWindow: () => mainWindow })

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
