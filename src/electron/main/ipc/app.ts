/**
 * app 域 IPC：诊断能力（引擎连接状态）。
 * IPC 入口是信任边界（renderer 不可信）：本域当前无入参；后续任何带参数的
 * handler 都必须在此做一次参数形状校验，再进业务层。
 */
import { refreshMcpAccessFile } from '../host/mcp-access'
import { handleTrusted } from './trusted'
import { IPC, type AppStatus } from '../../../shared/ipc'
import type { HostManager } from '../host/manager'

export function registerAppIpc(host: HostManager): void {
  handleTrusted(IPC.appRestart, async () => { await host.stop(); await host.start(); await refreshMcpAccessFile(host); return host.getStatus() })
  handleTrusted(IPC.appStatus, (): AppStatus => host.getStatus())
}
