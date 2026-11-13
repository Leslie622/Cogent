/**
 * engine 域 IPC：renderer → 引擎的通用代理 + 引擎事件 → renderer 的转发。
 *
 * 设计：一条 `engine:request` 通道代理全部引擎方法，而不是每 method 一条 IPC ——
 * method 集合与载荷形状已在 protocol/types.ts 的 ProtocolMethods 里类型化，
 * 白名单是唯一要守的边界：renderer 能触达哪些引擎方法在此显式收窄，
 * 未经点名的 method（如未来的 approval.respond）不经过 renderer 手。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { ProtocolMethods } from '../../../protocol'
import type { IpcDeps } from './index'

/**
 * renderer 可触达的引擎方法白名单（approval.respond 等宿主侧裁决不在此列）。
 * 注意 providers.custom.sync 不在白名单：自定义 provider 的写路径只有
 * custom-providers:set 一条（壳落盘 + 推引擎），若 renderer 还能经本通道直推
 * 引擎内存态，会出现"盘上不变、引擎重启回滚"的状态分叉。
 */
const ALLOWED_METHODS = new Set<string>([
  'session.list',
  'session.create',
  'session.delete',
  'session.messages',
  'session.setPinned',
  'session.archive',
  'session.listArchived',
  'session.setPermission',
  'session.compact',
  'session.continue',
  'project.list',
  'project.create',
  'project.rename',
  'project.update',
  'project.delete',
  'project.setPinned',
  'agent.submit',
  'agent.abort',
  'credentials.list',
  'models.list',
  'inspect.entries',
  'inspect.entry'
])

export function registerEngineIpc({ host }: IpcDeps): void {
  // 信任边界：renderer 不可信 —— method 白名单 + params 形状在此收窄，业务校验在引擎 dispatch
  ipcMain.handle(IPC.engineRequest, async (_event, raw: unknown) => {
    const payload = raw as { method: unknown; params: unknown }
    if (typeof payload.method !== 'string' || !ALLOWED_METHODS.has(payload.method)) {
      throw new Error(`engine:request 非法调用：method 必须在白名单内`)
    }
    const params: unknown = payload.params
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error(`engine:request 非法调用：params 必须是对象`)
    }
    const method = payload.method as keyof ProtocolMethods
    return host.request(method, params)
  })

  // 引擎事件 → renderer：单向转发，main 不理解事件语义（壳的角色）。
  // 广播到全部窗口（主窗口消费聊天事件，控制台窗口消费 inspect 域）——
  // 各窗口按 method 自行取舍，main 不做按窗口分发
  host.setEventSink((rpcEvent) => {
    // 诊断日志：帧截到 200 字符（run.completed 的 message.content 是整段回复，
    // 全量打印会淹没终端）。message.delta 与 inspect.event 是逐 token/逐条目
    // 高频帧，流式期间每秒数十条，不滤会把终端刷爆且 JSON.stringify 白烧主进程
    if (rpcEvent.method !== 'message.delta' && rpcEvent.method !== 'inspect.event') {
      console.log('[main] engine event:', JSON.stringify(rpcEvent).slice(0, 200))
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.engineEvent, rpcEvent)
    }
  })
}
