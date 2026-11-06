import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppStatus } from '../../shared/ipc'

/**
 * renderer 与主进程之间的唯一通道。
 * 规则（docs/约定.md）：只暴露显式白名单方法，禁止转发任意 channel；
 * 暴露的 API 形状即 CogentApi，renderer 侧类型由此导出。
 */
const api = {
  /** 查询 Agent 引擎服务连接状态（诊断） */
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.appStatus)
}

export type CogentApi = typeof api

contextBridge.exposeInMainWorld('cogent', api)
