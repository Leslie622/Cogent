/**
 * IPC 注册中心：每个域一个文件（session / agent / approval / settings…），
 * 入口统一挂载，保持 main 入口干净。
 * 新增域：shared/ipc.ts 加契约 → ipc/ 下加文件 → 在此挂载一行。
 */
import type { BrowserWindow } from 'electron'
import type { AgentServiceManager } from '../service/manager'
import type { CredentialStore } from '../credentials/store'
import type { CustomProvidersStore } from '../custom-providers/store'
import { registerAppIpc } from './app'
import { registerWindowIpc } from './window'
import { registerEngineIpc } from './engine'
import { registerCredentialsIpc } from './credentials'
import { registerCustomProvidersIpc } from './custom-providers'
import { registerWorkspaceIpc } from './workspace'
import { registerSettingsIpc } from './settings'

export interface IpcDeps {
  service: AgentServiceManager
  /** 事件转发用：引擎事件经 webContents.send 推给 renderer */
  getWindow: () => BrowserWindow | null
}

export function registerIpc(deps: IpcDeps, store: CredentialStore, customProviders: CustomProvidersStore): void {
  registerAppIpc(deps.service)
  registerWindowIpc(deps.getWindow)
  registerEngineIpc(deps)
  registerCredentialsIpc(deps.service, store)
  registerCustomProvidersIpc(deps.service, customProviders)
  registerWorkspaceIpc(deps)
  registerSettingsIpc()
}
