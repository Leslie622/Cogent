import { BrowserWindow, ipcMain } from 'electron'
import { IPC, type AgentEventPayload, type AgentStatus } from '../shared/ipc'
import { abort, prompt, status, subscribe } from './agent/runtime'

/**
 * IPC 桥：renderer 的请求走 ipcMain.handle，
 * Agent 事件流通过 webContents.send 推送到 renderer。
 */
export function registerAgentIpc(getWindow: () => BrowserWindow | null): void {
  subscribe((event: AgentEventPayload) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.agentEvent, event)
    }
  })

  ipcMain.handle(IPC.agentStatus, (): AgentStatus => status())

  ipcMain.handle(IPC.agentPrompt, (_event, text: unknown) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('prompt text must be a non-empty string')
    }
    // 不等待整个 run 结束：结果通过 agent:event 事件流推送回 renderer。
    void prompt(text.trim()).catch((error) => {
      console.error('[agent] prompt failed:', error)
    })
  })

  ipcMain.handle(IPC.agentAbort, () => {
    abort()
  })
}
