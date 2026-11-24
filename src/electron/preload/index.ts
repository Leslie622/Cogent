import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FileActionRequest } from '../../shared/files'
import { FILE_VIEWS_CHANNEL, type FileViewMethods } from '../../shared/file-views'
import { BROWSER_CHANNEL, type BrowserMethods, type BrowserEvent } from '../../shared/browser'
import {
  IPC,
  type AppStatus,
  type ApiKeyStatus,
  type CredentialsStatus,
  type NotifyKind,
  type NotifyToastPayload,
  type RendererSettingsPatch,
  type SettingsFile,
  type StorageUsageResult,
  type WindowCloseAnswer
} from '../../shared/ipc'
import type {
  CustomProviderDef,
  ProviderOverrideDef,
  ProtocolMethods,
  RpcEvent,
  SessionSummary
} from '../../protocol'

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
  fileViewsRequest: <M extends keyof FileViewMethods>(method: M, params: FileViewMethods[M]['params']): Promise<FileViewMethods[M]['result']> => ipcRenderer.invoke(FILE_VIEWS_CHANNEL, { method, params }),
  browserRequest: <M extends keyof BrowserMethods>(method: M, params: BrowserMethods[M]['params']): Promise<BrowserMethods[M]['result']> => ipcRenderer.invoke(BROWSER_CHANNEL.request, { method, params }),
  onBrowserEvent: (callback: (event: BrowserEvent) => void): (() => void) => {
    const listener = (_event: unknown, event: BrowserEvent): void => callback(event)
    ipcRenderer.on(BROWSER_CHANNEL.event, listener)
    return () => ipcRenderer.removeListener(BROWSER_CHANNEL.event, listener)
  },
  fileAction: (request: FileActionRequest): Promise<{ canceled: boolean }> => ipcRenderer.invoke(IPC.filesAction, request),
  configureFileEditor: (): Promise<{ canceled: boolean }> => ipcRenderer.invoke(IPC.filesConfigureEditor),
  filePath: (file: File): string => webUtils.getPathForFile(file),
  pickAttachments: (): Promise<string[]> => ipcRenderer.invoke(IPC.attachmentsPick),
  clipboardFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.attachmentsClipboard),
  attachmentPreview: (id: string, thumbnail: boolean): Promise<string> => ipcRenderer.invoke(IPC.attachmentsPreview, { id, thumbnail }),
  attachmentAction: (id: string, action: 'reveal' | 'save'): Promise<void> => ipcRenderer.invoke(IPC.attachmentsAction, { id, action }),
  /** 查询 Agent 引擎服务连接状态（诊断） */
  restartHost: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.appRestart),
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

  /** 审批裁决（专属通道，不经 engineRequest 通用代理 —— 安全边界独立成路）：
      允许/拒绝引擎挂起中的写类工具调用；options.message = 拒绝附言（「告诉模型
      接下来怎么做」），options.always = 'workspace' 落工作区级始终允许规则，
      options.switchMode = 「允许，并切换为」（切会话模式 + 记项目默认，
      result.summary = 切换后的会话摘要） */
  respondApproval: (
    requestId: string,
    approved: boolean,
    options?: { message?: string; always?: 'workspace'; switchMode?: 'auto' | 'autonomous' }
  ): Promise<{ ok: true; summary?: SessionSummary }> =>
    ipcRenderer.invoke(IPC.approvalRespond, { requestId, approved, ...options }),

  /** 回答挂起中的 ask_user（交互座 4c-2；respondApproval 同款专属通道）：
      answers 按问题序，元素 = 选项 label / 自由输入（多选问题 = string[]） */
  respondQuestion: (
    requestId: string,
    answers: Array<string | string[]>
  ): Promise<{ ok: true }> => ipcRenderer.invoke(IPC.questionRespond, { requestId, answers }),

  /** 裁决挂起中的 submit_plan（交互座 4c-3；同款专属通道）：批准 = 关计划
      开关（权限档不动），拒绝可附 message 反馈（进工具结果给模型修订）；
      result.summary = 批准后的会话摘要 */
  respondPlan: (
    requestId: string,
    approved: boolean,
    options?: { message?: string }
  ): Promise<{ ok: true; summary?: SessionSummary }> =>
    ipcRenderer.invoke(IPC.planRespond, { requestId, approved, ...options }),

  /** 写入 API key：safeStorage 落盘 + 推给引擎内存（key 明文只此一路出 renderer） */
  setApiKey: (providerId: string, apiKey: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.credentialsSet, { providerId, apiKey }),

  /** 删除单条 API key（壳侧落盘移除 + 引擎内存表移除；清 key 的正路） */
  removeApiKey: (providerId: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.credentialsRemove, { providerId }),

  /** 读单个 provider 的 key 明文（设置页全量回显用；无记录返回空串） */
  getApiKey: (providerId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.credentialsGet, { providerId }),

  /** 查询 key 配置状态（只回 providerId + keyConfigured 布尔位） */
  listApiKeys: (): Promise<ApiKeyStatus[]> => ipcRenderer.invoke(IPC.credentialsList),

  /** 凭据链路健康状态（启动期降级的 UI 呈现源；error 为 null = 健康） */
  getCredentialsStatus: (): Promise<CredentialsStatus> => ipcRenderer.invoke(IPC.credentialsStatus),

  /** 读自定义 provider 定义（含内置 provider 的 baseUrl 覆盖） */
  getCustomProviders: (): Promise<CustomProvidersPayload> => ipcRenderer.invoke(IPC.customProvidersGet),

  /** 全量写自定义 provider 定义（落盘 + 引擎 running 时推 sync） */
  setCustomProviders: (providers: CustomProvidersPayload['providers'], overrides: CustomProvidersPayload['overrides']): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.customProvidersSet, { providers, overrides }),

  /** 读会话级偏好（选中模型/思考力度）；形状见 shared/ipc.ts 的 SettingsFile */
  getSettings: (): Promise<SettingsFile> => ipcRenderer.invoke(IPC.settingsGet),
  /** 写会话级偏好（字段合并） */
  saveSettings: (partial: RendererSettingsPatch): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.settingsSave, partial),
  /** 扫描存储根统计占用（设置页·存储分区）；根路径 + 顶层条目字节数 */
  getStorageUsage: (): Promise<StorageUsageResult> => ipcRenderer.invoke(IPC.storageUsage),
  /** 打开（或聚焦已开的）运行时控制台窗口 */
  openConsole: (): Promise<void> => ipcRenderer.invoke(IPC.consoleOpen),
  /** 打开（或聚焦已开的）内嵌页面 demo 窗口（webview 容器，阶段 3a） */
  openEmbedded: (): Promise<void> => ipcRenderer.invoke(IPC.embeddedOpen),

  /** 弹系统目录选择框（创建项目用）；用户取消返回 null */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.workspacePickDirectory),

  /** 系统默认程序打开路径/目录（目录 = 资源管理器）；成功 null，失败错误串 */
  openPath: (path: string): Promise<string | null> => ipcRenderer.invoke(IPC.shellOpenPath, path),

  /** 窗口控制（自绘 header 专用，白名单动作） */
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowMaximizeToggle),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
  /** 订阅「关闭窗口时」询问要求（closeBehavior=ask 的关窗弹窗触发） */
  onAskClose: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.windowAskClose, listener)
    return () => ipcRenderer.removeListener(IPC.windowAskClose, listener)
  },
  /** 询问弹窗裁决回传（cancel = 用户取消，仅复位询问态） */
  confirmClose: (answer: WindowCloseAnswer): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.windowConfirmClose, answer),
  /** 弹系统 toast（条件判定在 renderer，main 只展示；Linux 不支持时 ok:false） */
  notifyToast: (payload: NotifyToastPayload): Promise<{ ok: true } | { ok: false; reason: 'unsupported' }> =>
    ipcRenderer.invoke(IPC.notifyToast, payload),
  /** 选自定义声音文件（拷进 sounds/ 落字段，返回文件名；取消返回 null） */
  pickSoundFile: (kind: NotifyKind): Promise<string | null> =>
    ipcRenderer.invoke(IPC.soundPickFile, kind),
  /** 清除自定义声音文件（恢复内置提示音） */
  clearSoundFile: (kind: NotifyKind): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.soundClearFile, kind),
  /** 打开系统通知设置页（Linux 未注册本通道，renderer 按 platform 隐藏入口） */
  openNotificationSettings: (): Promise<void> => ipcRenderer.invoke(IPC.openNotificationSettings),
  /** 查系统通知开关快照（Windows 注册表；false = 系统层已关，null = 未知/默认开） */
  getSystemNotifyStatus: (): Promise<{ enabled: boolean | null }> =>
    ipcRenderer.invoke(IPC.notifySystemStatus),
  /** 运行平台（'win32' | 'darwin' | 'linux'；平台分支 UI 的判定源） */
  platform: process.platform,
  /** 主窗口是否启用了系统半透明材质（仅 Win11 22H2+ 且开启硬件加速；其余平台与子窗口均为 false） */
  backdropSupported: process.argv.includes('--cogent-backdrop=1'),
  /** 订阅最大化状态变化（自绘 header 的最大化/还原图标切换） */
  onWindowState: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: unknown, isMaximized: boolean): void => callback(isMaximized)
    ipcRenderer.on(IPC.windowState, listener)
    return () => ipcRenderer.removeListener(IPC.windowState, listener)
  }
} as const

export type CogentApi = typeof api

contextBridge.exposeInMainWorld('cogent', api)
