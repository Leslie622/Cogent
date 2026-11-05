import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AgentEventPayload, type AgentStatus } from '../shared/ipc'

/**
 * renderer 与主进程之间的唯一通道。
 * 暴露的 API 形状即 CogentApi 类型，renderer 侧通过 window.cogent 调用。
 */
const cogent = {
  status: (): Promise<AgentStatus> => ipcRenderer.invoke(IPC.agentStatus),

  send: (text: string): Promise<void> => ipcRenderer.invoke(IPC.agentPrompt, text),

  abort: (): Promise<void> => ipcRenderer.invoke(IPC.agentAbort),

  /** 订阅 Agent 事件流，返回取消订阅函数 */
  onAgentEvent: (listener: (event: AgentEventPayload) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEventPayload): void => {
      listener(payload)
    }
    ipcRenderer.on(IPC.agentEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC.agentEvent, handler)
    }
  }
}

export type CogentApi = typeof cogent

contextBridge.exposeInMainWorld('cogent', cogent)
