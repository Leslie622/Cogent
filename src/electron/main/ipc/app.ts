/**
 * app 域 IPC：诊断能力（引擎连接状态）。
 * IPC 入口是信任边界（renderer 不可信）：本域当前无入参；后续任何带参数的
 * handler 都必须在此做一次参数形状校验，再进业务层。
 */
import { ipcMain } from 'electron'
import { IPC, type AppStatus } from '../../../shared/ipc'
import type { AgentServiceManager } from '../service/manager'

export function registerAppIpc(service: AgentServiceManager): void {
  ipcMain.handle(IPC.appStatus, (): AppStatus => service.getStatus())
}
