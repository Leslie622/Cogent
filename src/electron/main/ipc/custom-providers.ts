/** 定义真源在 Host；壳桥只做带页面身份校验的代理。 */
import { handleTrusted } from './trusted'
import { IPC } from '../../../shared/ipc'
import type { HostManager } from '../host/manager'
export function registerCustomProvidersIpc(host: HostManager): void {
  handleTrusted(IPC.customProvidersGet, () => host.request('providers.custom.get', {}))
  handleTrusted(IPC.customProvidersSet, async (_event, raw: unknown) => {
    await host.request('providers.custom.sync', raw as import('../../../protocol').ProvidersCustomSyncParams)
    return { ok: true as const }
  })
}
