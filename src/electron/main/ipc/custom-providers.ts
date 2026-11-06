/**
 * custom-providers 域 IPC：自定义 provider 定义的读写（全量替换语义）。
 * main 只管定义的持久化与转发；provider 的构建在引擎（createProvider，见
 * agent-service/runtime/custom-providers.ts）。
 */
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { CustomProviderDef, ProviderOverrideDef } from '../../../protocol'
import type { CustomProvidersStore } from '../custom-providers/store'
import type { AgentServiceManager } from '../service/manager'

/** 定义形状校验（信任边界：renderer 不可信）；custom/ 前缀的业务约束在引擎侧收窄 */
function isDef(def: CustomProviderDef): boolean {
  return (
    typeof def.id === 'string' &&
    typeof def.name === 'string' &&
    typeof def.baseUrl === 'string' &&
    Array.isArray(def.models) &&
    def.models.every((m) => typeof m === 'string')
  )
}

function isOverride(o: ProviderOverrideDef): boolean {
  return typeof o.providerId === 'string' && typeof o.baseUrl === 'string'
}

export function registerCustomProvidersIpc(service: AgentServiceManager, store: CustomProvidersStore): void {
  ipcMain.handle(IPC.customProvidersGet, () => store.readAll())

  ipcMain.handle(IPC.customProvidersSet, async (_event, raw: unknown) => {
    const payload = raw as { providers: unknown; overrides: unknown }
    if (
      !Array.isArray(payload.providers) ||
      !payload.providers.every(isDef) ||
      !Array.isArray(payload.overrides) ||
      !payload.overrides.every(isOverride)
    ) {
      throw new Error('custom-providers:set 需要 { providers: CustomProviderDef[], overrides: ProviderOverrideDef[] }')
    }
    const providers = payload.providers as CustomProviderDef[]
    const overrides = payload.overrides as ProviderOverrideDef[]
    store.writeAll(providers, overrides)
    // 引擎未运行时仅落盘：renderer 在引擎就绪后主动 sync（App load 流程），这里不阻塞保存
    if (service.getStatus().state === 'running') {
      await service.request('providers.custom.sync', { providers, overrides })
    }
    return { ok: true as const }
  })
}
