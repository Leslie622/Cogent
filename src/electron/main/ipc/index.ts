/**
 * IPC 注册中心：每个域一个文件（session / agent / approval / settings…），
 * 入口统一挂载，保持 main 入口干净。
 * 新增域：shared/ipc.ts 加契约 → ipc/ 下加文件 → 在此挂载一行。
 */
import type { BrowserWindow } from 'electron'
import type { HostManager } from '../host/manager'
import type { CredentialStore } from '../credentials/store'
import type { CustomProvidersStore } from '../custom-providers/store'
import { registerAppIpc } from './app'
import { registerWindowIpc } from './window'
import { registerConsoleIpc } from './console'
import { registerEngineIpc } from './engine'
import { registerApprovalIpc } from './approval'
import { registerCredentialsIpc } from './credentials'
import { registerCustomProvidersIpc } from './custom-providers'
import { registerWorkspaceIpc } from './workspace'
import { registerSettingsIpc } from './settings'

export interface IpcDeps {
  host: HostManager
  /** 主窗口引用（窗口域外的零星转发用；事件转发已广播化，见 ipc/engine.ts） */
  getWindow: () => BrowserWindow | null
}

export function registerIpc(deps: IpcDeps, store: CredentialStore, customProviders: CustomProvidersStore): void {
  registerAppIpc(deps.host)
  registerWindowIpc()
  registerConsoleIpc()
  registerEngineIpc(deps)
  registerApprovalIpc(deps)
  registerCredentialsIpc(deps.host, store)
  registerCustomProvidersIpc(deps.host, customProviders)
  registerWorkspaceIpc(deps)
  registerSettingsIpc()
}
