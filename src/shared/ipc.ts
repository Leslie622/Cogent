/**
 * Electron 三端契约（renderer ↔ preload ↔ main）。
 * 只放 channel 常量与载荷类型，禁止任何运行时依赖。
 *
 * 注意分界：这是"壳内部"的契约；跨项目复用的引擎协议在 src/protocol/，
 * 两者不要混用 —— 引擎换宿主时壳契约不受影响。
 */

export const IPC = {
  /** renderer → main：查询 Agent 引擎服务连接状态 */
  appStatus: 'app:status',
  /** renderer → main：窗口控制（最小化 / 切换最大化 / 关闭）——自绘 header 专用 */
  windowMinimize: 'window:minimize',
  windowMaximizeToggle: 'window:maximize-toggle',
  windowClose: 'window:close',
  /** main → renderer：最大化状态变化（payload: boolean isMaximized） */
  windowState: 'window:state-changed'
} as const

/** 引擎服务连接状态（诊断用；UI 可据此提示"引擎未就绪"） */
export interface AppStatus {
  state: 'starting' | 'running' | 'stopped' | 'failed'
  /** 引擎实际运行的 Node 版本（握手时上报） */
  nodeVersion: string | null
  /** state=failed 时的原因，供日志/UI 呈现 */
  error: string | null
}
