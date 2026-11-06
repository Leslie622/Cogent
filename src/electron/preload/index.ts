import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppStatus, type ApiKeyStatus } from '../../shared/ipc'
import type { CustomProviderDef, ProviderOverrideDef, ProtocolMethods, RpcEvent } from '../../protocol'

/** 引擎事件帧：RpcEvent（method + params），renderer 侧按 method 分发 */
type EngineEventFrame = RpcEvent

/** custom-providers IPC 的载荷（定义不含 key —— key 走 credentials 单独管理） */
type CustomProvidersPayload = { providers: CustomProviderDef[]; overrides: ProviderOverrideDef[] }

/**
 * renderer 与主进程之间的唯一通道。
 * 规则（docs/约定.md）：只暴露显式白名单方法，禁止转发任意 channel；
 * 暴露的 API 形状即 CogentApi，renderer 侧类型由此导出。
 */
const api = {
  /** 查询 Agent 引擎服务连接状态（诊断） */
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.appStatus),

  /** 引擎方法代理：method 名受 ipc/engine.ts 白名单收窄，载荷类型由 ProtocolMethods 约束 */
  engineRequest: <M extends keyof ProtocolMethods>(
    method: M,
    params: ProtocolMethods[M]['params']
  ): Promise<ProtocolMethods[M]['result']> => ipcRenderer.invoke(IPC.engineRequest, { method, params }),

  /** 订阅引擎事件流（run/message/tool/approval 各域事件），返回取消订阅函数 */
  onEngineEvent: (callback: (event: EngineEventFrame) => void): (() => void) => {
    const listener = (_event: unknown, frame: EngineEventFrame): void => callback(frame)
    ipcRenderer.on(IPC.engineEvent, listener)
    return () => ipcRenderer.removeListener(IPC.engineEvent, listener)
  },

  /** 写入 API key：safeStorage 落盘 + 推给引擎内存（key 明文只此一路，查询接口不回明文） */
  setApiKey: (providerId: string, apiKey: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.credentialsSet, { providerId, apiKey }),

  /** 查询 key 配置状态（只回 providerId + keyConfigured 布尔位） */
  listApiKeys: (): Promise<ApiKeyStatus[]> => ipcRenderer.invoke(IPC.credentialsList),

  /** 读自定义 provider 定义（含内置 provider 的 baseUrl 覆盖） */
  getCustomProviders: (): Promise<CustomProvidersPayload> => ipcRenderer.invoke(IPC.customProvidersGet),

  /** 全量写自定义 provider 定义（落盘 + 引擎 running 时推 sync） */
  setCustomProviders: (providers: CustomProvidersPayload['providers'], overrides: CustomProvidersPayload['overrides']): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.customProvidersSet, { providers, overrides }),

  /** 窗口控制（自绘 header 专用，白名单动作） */
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowMaximizeToggle),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
  /** 订阅最大化状态变化（自绘 header 的最大化/还原图标切换） */
  onWindowState: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: unknown, isMaximized: boolean): void => callback(isMaximized)
    ipcRenderer.on(IPC.windowState, listener)
    return () => ipcRenderer.removeListener(IPC.windowState, listener)
  }
} as const

export type CogentApi = typeof api

contextBridge.exposeInMainWorld('cogent', api)
