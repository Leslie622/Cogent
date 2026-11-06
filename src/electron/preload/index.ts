import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppStatus } from '../../shared/ipc'

/**
 * renderer 与主进程之间的唯一通道。
 * 规则（docs/约定.md）：只暴露显式白名单方法，禁止转发任意 channel；
 * 暴露的 API 形状即 CogentApi，renderer 侧类型由此导出。
 */
const api = {
  /** 查询 Agent 引擎服务连接状态（诊断） */
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.appStatus),

  /** 窗口控制（自绘 header 专用，白名单动作） */
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowMaximizeToggle),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
  /** 订阅最大化状态变化（自绘 header 的最大化/还原图标切换） */
  onWindowState: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: unknown, isMaximized: boolean): void => callback(isMaximized)
    ipcRenderer.on(IPC.windowState, listener)
    return () => ipcRenderer.removeListener(IPC.windowState, listener)
  }
}

export type CogentApi = typeof api

contextBridge.exposeInMainWorld('cogent', api)
