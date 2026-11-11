/**
 * console 域 IPC：运行时控制台窗口（Agent DevTools）的生命周期管理。
 *
 * 形态决策（2026-11-10 用户定）：控制台是**独立 BrowserWindow**，不是主窗口里的
 * 一个视图 —— 学习场景要"边聊边看"，聊天流与观测时间线同屏实时联动。
 * 实现上复用同一 renderer bundle + hash 路由（#console）分流到控制台根组件，
 * preload / 引擎事件通道 / 白名单全部零重复。
 *
 * 单例语义：已开则聚焦（避免多实例抢事件流）；关闭即释放引用。
 * 窗口自身 frameless + renderer 自绘 header（与主窗口同一套窗口控制 IPC，
 * window.ts 已按"发起窗口"寻址，主/控制台窗口共用）。
 */
import { join } from 'node:path'
import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '../../../shared/ipc'

/** 控制台窗口引用；null = 未开（单例，见文件头） */
let consoleWindow: BrowserWindow | null = null

function createConsoleWindow(): void {
  consoleWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Cogent 控制台',
    frame: false,
    webPreferences: {
      // 与主窗口同配置：ESM preload 关 sandbox + 恒开 contextIsolation +
      // 关后台节流（主窗口 index.ts 同款理由：控制台的实时时间线也在跑计时）
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: join(import.meta.dirname, '../preload/index.mjs')
    }
  })

  consoleWindow.on('ready-to-show', () => consoleWindow?.show())

  // 自绘 header 的最大化图标跟随（同主窗口；只发给本窗口自己的 webContents）
  const sendWindowState = (): void => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send(IPC.windowState, consoleWindow.isMaximized())
    }
  }
  consoleWindow.on('maximize', sendWindowState)
  consoleWindow.on('unmaximize', sendWindowState)

  // 外部链接走系统浏览器（与主窗口同策略）
  consoleWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  consoleWindow.on('closed', () => {
    consoleWindow = null
  })

  // 加载同一 renderer，hash 区分根组件（dev 的 ELECTRON_RENDERER_URL / 产物 index.html）
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.hash = 'console'
    void consoleWindow.loadURL(url.toString())
  } else {
    void consoleWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: 'console' })
  }
}

export function registerConsoleIpc(): void {
  // 无参数：动作语义由 channel 表达（同 window 域）
  ipcMain.handle(IPC.consoleOpen, () => {
    if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.focus()
    else createConsoleWindow()
  })
}
