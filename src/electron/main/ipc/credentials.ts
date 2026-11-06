/**
 * credentials 域 IPC：API key 的写入与状态查询。
 * main 是 key 明文唯一的家：safeStorage 落盘 + 推给引擎内存；renderer 只见布尔位。
 */
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { CredentialStore } from '../credentials/store'
import type { AgentServiceManager } from '../service/manager'

export function registerCredentialsIpc(service: AgentServiceManager, store: CredentialStore): void {
  // 信任边界：providerId/apiKey 形状校验；业务语义（provider 是否存在）由引擎报错
  ipcMain.handle(IPC.credentialsSet, async (_event, raw: unknown) => {
    const payload = raw as Partial<{ providerId: unknown; apiKey: unknown }>
    if (typeof payload.providerId !== 'string' || payload.providerId.length === 0 || typeof payload.apiKey !== 'string') {
      throw new Error('credentials:set 需要 { providerId: string, apiKey: string }')
    }
    store.write(payload.providerId, payload.apiKey)
    // 引擎未运行时（启动失败）仅落盘：下次握手注入；这里不阻塞保存动作本身
    if (service.getStatus().state === 'running') {
      await service.request('credentials.set', { providerId: payload.providerId, apiKey: payload.apiKey })
    }
    return { ok: true as const }
  })

  ipcMain.handle(IPC.credentialsList, (): Array<{ providerId: string; keyConfigured: boolean }> => {
    return store.listConfigured()
  })
}
