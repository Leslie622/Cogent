import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { HostManager } from './host/manager'
import { refreshMcpAccessFile } from './host/mcp-access'
import { resolveEngineNode } from './host/runtime'
import { CredentialStore } from './credentials/store'
import { CustomProvidersStore } from './custom-providers/store'
import { registerIpc } from './ipc'
import { readSettingsFile } from './ipc/settings'
import { ensureTray, installCloseBehavior, restoreMainWindow } from './window-close'
import { hardenWebviewAttachment } from './webview-policy'
import { IPC } from '../../shared/ipc'

// Windows 分数 DPI（125%/150%）下，LCD 亚像素文字经合成缩放会被 smear 成
// "虚肥 + 红蓝彩边"（用户对比 ChatGPT 发现笔画发糊的主因：我们侧彩边明显、
// ChatGPT 侧是干净灰度抗锯齿）。关掉 LCD 走灰度，边缘干净。
app.commandLine.appendSwitch('disable-lcd-text')

// Chromium 后台组件更新默认访问 Google 域，国内/信创内网下握手被重置，
// 启动日志刷屏 ssl handshake failed（net_error -101）。本应用不走 Chrome
// Web Store 分发，组件更新无功能意义 —— 关掉静音（2026-11-13 dev 实测；
// 若残余 CT 日志等其他 Google 域请求再逐项补）。
app.commandLine.appendSwitch('disable-component-update')

// Chrome 硬件加速（设置页开关）：关掉可规避部分显卡/驱动导致的白屏、闪退、
// 渲染异常。disableHardwareAcceleration 只准在 app ready 前调 —— 启动期读档
// 消费，设置页改的是盘上值，重启后在此生效（「修改后需重启」即此）
if (readSettingsFile().hardwareAcceleration === false) {
  app.disableHardwareAcceleration()
}

let mainWindow: BrowserWindow | null = null
let host: HostManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 730,
    minWidth: 400,
    minHeight: 600,
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
      // 关 Chromium 后台节流（2026-11-11）：默认开时窗口失焦/被遮挡（用户正盯
      // 控制台窗口看时间线）setInterval 被节流到分钟级 —— 「工作中」计时器冻在
      // 挂载值不动，而 spinner 是合成器动画照转，观感即"计时器卡死"。VS Code
      // 同款做法；桌面 Agent 客户端的流式 UI（计时/自动吸底）必须常活。
      backgroundThrottling: false,
      preload: join(import.meta.dirname, '../preload/index.cjs')
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

  // 「关闭窗口时」分流（quit 放行 / minimize 藏到托盘 / ask 推 renderer 弹窗）
  installCloseBehavior(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// 单例锁：第二实例不启壳，只把已有窗口呼到前台（minimize 档窗口藏在托盘
// 也能恢复）—— 双实例会争 ~/.cogent 的设置/会话文件与引擎子进程。拿不到锁
// 就尽快退出，主启动链全部收进 else 分支不跑
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', restoreMainWindow)

  // 入口 fire-and-forget（void 标记）：whenReady 之后的失败都在各自边界内处理
  void app.whenReady().then(() => {
    // 凭据存取（safeStorage）：可用性探测失败不再只落 console —— 记入 store 的
    // startupError，经 credentials:status 暴露给设置页呈现（同损坏降级一条通道）。
    // 降级链路细节见 credentials/store.ts 文件头：损坏/DPAPI 不匹配都不炸启动。
    const credentialStore = new CredentialStore()
    try {
      credentialStore.assertAvailable()
    } catch (error) {
      credentialStore.noteStartupError((error as Error).message)
      console.error('[main] credential store unavailable:', error)
    }
    const customProvidersStore = new CustomProvidersStore()

    // 引擎代理：握手时把宿主持久化的 key 灌进引擎内存表（凭据降级时这里是空表，
    // 引擎按"无 key"启动 —— 用户重输 key 后经 credentials:set 即时推送）
    const engineNodeBin = resolveEngineNode()
    host = new HostManager({
      entryPath: join(import.meta.dirname, 'host.js'),
      nodeBin: engineNodeBin,
      handshakeCredentials: credentialStore.readAll(),
      // HTTP 门默认开（阶段 3a 起：webview 页面消费者需要；loopback + 恒鉴权）
      enableHttpRpc: true
    })
    registerIpc({ host, getWindow: () => mainWindow }, credentialStore, customProvidersStore)

    // webview 附加硬化（D10）：在任何窗口创建前挂上（will-attach-webview 按事件
    // 拦截，createWindow 之后才挂就有绕过窗口期）
    hardenWebviewAttachment()

    // 壳与引擎解耦：引擎起不来（缺 Node / 版本不符）不阻塞窗口，状态经 app:status
    // 暴露给 UI 呈现（preload.getStatus）。fire-and-forget 是刻意为之（void 标记）。
    const startedHost = host
    void startedHost.start().then(
      // bin 来源一并打出：三级链是否吃到自带 node，dev 一眼可判（不再靠版本号倒推）
      () => {
        console.log(
          `[main] host ready (node ${startedHost.getStatus().nodeVersion}, bin ${engineNodeBin})`
        )
        // 对外 MCP 凭据刷新（阶段 5a）：Host 起来才知道端口；内部再判
        // settings.externalMcp.enabled，未启用时只做遗留文件清除
        void refreshMcpAccessFile(startedHost)
      },
      (error: unknown) => console.error('[main] host start failed:', error)
    )

    createWindow()

    // 托盘常驻（不限 minimize 档）：应用开着就可见可退出 —— minimize 档更是
    // 窗口藏起来的唯一找回入口；幂等，重复调用无害
    ensureTray()

    app.on('activate', () => {
      // mac dock 点击：minimize 档窗口只是 hide（未销毁）—— 先恢复再谈重建
      const hidden = BrowserWindow.getAllWindows().find((w) => !w.isVisible())
      if (hidden) {
        hidden.show()
        hidden.focus()
      } else if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    host?.stop()
    if (process.platform !== 'darwin') app.quit()
  })
}
