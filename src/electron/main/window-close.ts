/**
 * 「关闭窗口时」行为分流（设置页 closeBehavior 的 main 侧消费）。
 *
 * 拦截窗口 close 事件（所有关闭入口 —— 自绘 header 的 X、Alt+F4、任务栏
 * 右键关闭 —— 都汇到 win.close()，此处一处分流全覆盖）：
 *   quit      放行 → 窗口销毁 → window-all-closed → host.stop + app.quit
 *   minimize  preventDefault + hide()；窗口不销毁故 host 继续跑（后台语义），
 *             托盘常驻（点击恢复 / 右键退出）
 *   ask       preventDefault + 推 window:ask-close 给 renderer 弹自绘询问弹窗，
 *             裁决（含取消）经 window:confirm-close 回来；remember 时 renderer
 *             自行落盘，main 只执行动作 —— 设置写入单一通道 settings:save
 *
 * 标志位（模块级单例，本应用单窗口）：
 *   quitting  真退出流程已启动（托盘退出 / ask 选退出 / before-quit）——
 *             拦截器见标志直接放行，否则退出流程会被自己拦住
 *   asking    询问弹窗在开（防重入：连点关闭钮不重弹，cancel 复位）
 */
import { handleTrusted } from './ipc/trusted'
import { app, BrowserWindow, Menu, Tray } from 'electron'
import { IPC, type WindowCloseAnswer } from '../../shared/ipc'
import { readSettingsFile } from './ipc/settings'

let quitting = false
let asking = false
let tray: Tray | null = null

/** 真退出：先置 quitting（后续 close 放行）再走标准退出链（host 收口在 window-all-closed） */
function quitApp(): void {
  quitting = true
  app.quit()
}

/** 恢复主窗口（托盘点击 / 菜单「打开」/ 单例第二实例呼起共用） */
export function restoreMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  win.show()
  win.focus()
}

/**
 * 托盘常驻（幂等）：minimize 档的后手 —— hide 后任务栏图标消失，没有托盘
 * 用户就再也找不到窗口。图标取可执行文件自身（app.getFileIcon）：dev =
 * electron.exe 图标、打包后自动是应用图标，零资源依赖；正式 logo 资源
 * 落地后此处一行替换。
 */
export function ensureTray(): void {
  if (tray) return
  void app.getFileIcon(process.execPath).then(
    (icon) => {
      // async 窗口期内 ensureTray 可能被再次调到 —— 成功回调里二次判空挡住重入
      if (tray) return
      tray = new Tray(icon)
      tray.setToolTip('Cogent')
      // Windows 惯例：左键点击恢复窗口，右键出菜单
      tray.on('click', restoreMainWindow)
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开 Cogent', click: restoreMainWindow },
          { label: '退出', click: quitApp }
        ])
      )
    },
    // 外部边界（OS 取图标）失败留痕：托盘缺位时 minimize 档窗口藏起来找不回，
    // 日志是排障唯一线索
    (error: unknown) => console.error('[main] tray icon unavailable:', error)
  )
}

/** 组装：close 拦截 + 裁决通道 + before-quit 兜底（系统关机等路径置 quitting） */
export function installCloseBehavior(win: BrowserWindow): void {
  // 每次读盘 —— 运行中改设置即时生效（低频事件，同步小文件读可忽略）
  win.on('close', (event) => {
    // 退出流程中的 close 一律放行（托盘退出 / ask 选退出 / 系统关机）
    if (quitting) return
    const behavior = readSettingsFile().closeBehavior ?? 'ask'
    if (behavior === 'quit') return
    event.preventDefault()
    if (behavior === 'minimize') {
      ensureTray()
      win.hide()
      return
    }
    // ask：弹窗开着时不重发（连点关闭钮防重入）；窗口已被 preventDefault 留在原地
    if (asking) return
    asking = true
    win.webContents.send(IPC.windowAskClose)
  })

  handleTrusted(IPC.windowConfirmClose, (event, raw: unknown) => {
    // 信任边界：载荷收窄（unknown → 判别联合），越界即抛（约定 §1.1）
    const answer = raw as Partial<WindowCloseAnswer>
    if (
      (answer.action !== 'minimize' && answer.action !== 'quit' && answer.action !== 'cancel') ||
      typeof answer.remember !== 'boolean'
    ) {
      throw new Error('window:confirm-close 载荷必须是 { action: minimize|quit|cancel, remember: boolean }')
    }
    // 只认发起询问的那扇窗口的裁决（多窗口时防旁窗代答）
    if (event.sender !== win.webContents) {
      throw new Error('window:confirm-close 只能由被询问的窗口应答')
    }
    asking = false
    if (answer.action === 'minimize') {
      ensureTray()
      win.hide()
    } else if (answer.action === 'quit') {
      quitApp()
    }
    // cancel：仅复位询问态，窗口留在原地
    return { ok: true as const }
  })

  app.on('before-quit', () => {
    quitting = true
  })
}
