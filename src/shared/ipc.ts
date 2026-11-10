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
  /** renderer → main：引擎方法通用代理（载荷 { method, params }；白名单校验在 ipc/engine.ts） */
  engineRequest: 'engine:request',
  /** main → renderer：引擎事件流转发（载荷 = protocol RpcEvent） */
  engineEvent: 'engine:event',
  /** renderer → main：写入 API key（safeStorage 落盘 + 推给引擎） */
  credentialsSet: 'credentials:set',
  /** renderer → main：读单个 provider 的 key 明文（设置页全量回显用） */
  credentialsGet: 'credentials:get',
  /** renderer → main：查询 key 配置状态（只回布尔位） */
  credentialsList: 'credentials:list',
  /** renderer → main：读自定义 provider 定义（name/baseUrl/模型列表 + 内置覆盖） */
  customProvidersGet: 'custom-providers:get',
  /** renderer → main：全量写自定义 provider 定义（落盘 + 推引擎 sync） */
  customProvidersSet: 'custom-providers:set',
  /** renderer → main：读会话级偏好（选中模型/思考力度） */
  settingsGet: 'settings:get',
  /** renderer → main：写会话级偏好（字段合并语义，落 ~/.cogent/settings.json） */
  settingsSave: 'settings:save',
  /** renderer → main：弹系统目录选择框（创建项目/工作区绑定用）；返回所选绝对路径或 null */
  workspacePickDirectory: 'workspace:pick-directory',
  /** renderer → main：打开（或聚焦已开的）运行时控制台窗口 */
  consoleOpen: 'console:open',
  /** renderer → main：窗口控制（最小化 / 切换最大化 / 关闭）——自绘 header 专用；作用于发起窗口 */
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

/** key 配置状态（credentials:list 响应）：只回布尔位；明文只走 credentials:get 单取 */
export interface ApiKeyStatus {
  providerId: string
  keyConfigured: boolean
}
