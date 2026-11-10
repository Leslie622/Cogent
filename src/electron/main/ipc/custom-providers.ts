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

/** 定义形状校验（信任边界：renderer 不可信）。载荷是任意 JSON，按 unknown 收窄 ——
    用标注类型接不可信载荷会让 TS 检查形同虚设（同 isModelDef 的理由）；
    custom/ 前缀的业务约束在引擎侧收窄 */
function isDef(def: unknown): boolean {
  if (typeof def !== 'object' || def === null) return false
  const d = def as Record<string, unknown>
  return (
    typeof d.id === 'string' &&
    d.id.length > 0 &&
    typeof d.name === 'string' &&
    typeof d.baseUrl === 'string' &&
    Array.isArray(d.models) &&
    d.models.every((m) => typeof m === 'string' && m.length > 0) &&
    (d.modelDefs === undefined || (Array.isArray(d.modelDefs) && d.modelDefs.every(isModelDef)))
  )
}

/** 模型定义校验：载荷实为 renderer 任意 JSON，协议类型只是契约声明 —— 按
    unknown 逐字段收窄，字段检查不依赖标注类型（否则"类型已保证"是假象） */
function isModelDef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  if (typeof m.id !== 'string' || m.id.length === 0) return false
  if (m.name !== undefined && typeof m.name !== 'string') return false
  if (m.contextWindow !== undefined && typeof m.contextWindow !== 'number') return false
  if (m.maxTokens !== undefined && typeof m.maxTokens !== 'number') return false
  if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') return false
  if (m.input !== undefined) {
    if (!Array.isArray(m.input) || !m.input.every((v) => v === 'text' || v === 'image')) return false
  }
  return true
}

function isOverride(o: unknown): boolean {
  if (typeof o !== 'object' || o === null) return false
  const r = o as Record<string, unknown>
  return (
    typeof r.providerId === 'string' &&
    typeof r.baseUrl === 'string' &&
    (r.models === undefined || (Array.isArray(r.models) && r.models.every(isModelDef))) &&
    (r.disabledModels === undefined || (Array.isArray(r.disabledModels) && r.disabledModels.every((m) => typeof m === 'string')))
  )
}

export function registerCustomProvidersIpc(service: AgentServiceManager, store: CustomProvidersStore): void {
  ipcMain.handle(IPC.customProvidersGet, () => store.readAll())

  ipcMain.handle(IPC.customProvidersSet, async (_event, raw: unknown) => {
    const payload = raw as Partial<{ providers: unknown; overrides: unknown }>
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
    // 推送引擎：starting 期也推（请求在引擎 stdin 排队、握手后作答 —— 引擎慢启动
    // 不丢定义）；仅在已 failed/stopped（引擎确定不在）时跳过，落盘的定义由
    // renderer 启动重推（engine store load）补上。推送失败只记警告不报错给
    // renderer —— 落盘已成功，定义不会丢，报"保存失败"反而是谎报
    const state = service.getStatus().state
    if (state === 'starting' || state === 'running') {
      try {
        await service.request('providers.custom.sync', { providers, overrides })
      } catch (error) {
        console.warn('[main] custom providers 推送引擎失败（已落盘，下次启动重推）:', error)
      }
    }
    return { ok: true as const }
  })
}
