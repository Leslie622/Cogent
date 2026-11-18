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
  /** renderer → main：审批裁决专属通道（不经 engine:request 通用代理 —— 审批是
      安全边界，宿主侧裁决走独立通道，与「工具结果不经 renderer 转发」同理；
      载荷 { requestId, approved }，直达引擎 approval.respond） */
  approvalRespond: 'approval:respond',
  /** renderer → main：回答挂起中的 ask_user（交互座 4c-2；approvalRespond 同款
      宿主侧人机裁决通道；载荷 { requestId, answers }，直达引擎 question.respond） */
  questionRespond: 'question:respond',
  /** renderer → main：裁决方案审批（交互座 4c-3；同款专属通道；载荷
      { requestId, approved, switchMode?, message? }，直达引擎 plan.respond） */
  planRespond: 'plan:respond',
  /** renderer → main：写入 API key（safeStorage 落盘 + 推给引擎） */
  credentialsSet: 'credentials:set',
  /** renderer → main：删除单条 API key（壳侧落盘移除 + 引擎内存表移除） */
  credentialsRemove: 'credentials:remove',
  /** renderer → main：读单个 provider 的 key 明文（设置页全量回显用） */
  credentialsGet: 'credentials:get',
  /** renderer → main：查询 key 配置状态（只回布尔位） */
  credentialsList: 'credentials:list',
  /** renderer → main：凭据链路健康状态（损坏降级/safeStorage 不可用的 UI 呈现源） */
  credentialsStatus: 'credentials:status',
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
  /** renderer → main：系统默认程序打开路径/目录（项目「在资源管理器中打开」等）；
      成功返回 null，失败返回错误串（shell.openPath 的口径，供调用方呈现） */
  shellOpenPath: 'shell:open-path',
  /** renderer → main：打开（或聚焦已开的）运行时控制台窗口 */
  consoleOpen: 'console:open',
  /** renderer → main：打开（或聚焦已开的）内嵌页面 demo 窗口（阶段 3a 验收载体） */
  embeddedOpen: 'embedded:open',
  /** webview guest preload → main：取页面级凭证（一次性票据 + HTTP 门端口）；
      仅 webview 型 guest 可调（ipc/guest.ts 校验 sender） */
  guestCredentials: 'cogent:guest:credentials',
  /** renderer → main：窗口控制（最小化 / 切换最大化 / 关闭）——自绘 header 专用；作用于发起窗口 */
  windowMinimize: 'window:minimize',
  windowMaximizeToggle: 'window:maximize-toggle',
  windowClose: 'window:close',
  /** main → renderer：closeBehavior=ask 时要求弹「关闭窗口时」自绘询问弹窗（无载荷） */
  windowAskClose: 'window:ask-close',
  /** renderer → main：询问弹窗的裁决（payload: WindowCloseAnswer；remember 落盘由
      renderer 经 settings:save 完成，main 只执行动作；cancel = 弹窗关闭/取消） */
  windowConfirmClose: 'window:confirm-close',
  /** renderer → main：弹系统 toast（payload: NotifyToastPayload；条件判定在
      renderer 单一源，main 只展示 —— silent，点击聚焦主窗口） */
  notifyToast: 'notify:toast',
  /** renderer → main：选自定义声音文件（payload: 三类之一；拷进 ~/.cogent/sounds/
      后返回纯文件名，用户取消返回 null） */
  soundPickFile: 'sound:pick-file',
  /** renderer → main：清除自定义声音文件（payload: 三类之一；删 sounds/ 文件） */
  soundClearFile: 'sound:clear-file',
  /** renderer → main：打开系统通知设置页（Win/macOS URI；Linux 无统一入口不注册） */
  openNotificationSettings: 'shell:open-notification-settings',
  /** renderer → main：查系统通知开关快照（Windows 注册表 ToastEnabled；无变更
      事件只能快照，OS 限制）。enabled: false = 系统层已关；null = 查不到
      （非 Windows / 键缺失按默认开 / 查询失败） */
  notifySystemStatus: 'notify:system-status',
  /** main → renderer：最大化状态变化（payload: boolean isMaximized） */
  windowState: 'window:state-changed'
} as const

/** toast 载荷：文案由 renderer 生成（main 无语言上下文，学 zcode 拒绝兜底文案） */
export interface NotifyToastPayload {
  title: string
  body: string
}

/** 提醒的三类事件（声音文件选择/清除与设置字段共用的键） */
export type NotifyKind = 'turn-done' | 'approval' | 'question'

/** 「关闭窗口时」询问弹窗的裁决：action = 用户所选动作（cancel 仅复位询问态）；
    remember = 勾了「不再询问」（cancel 时忽略） */
export interface WindowCloseAnswer {
  action: 'minimize' | 'quit' | 'cancel'
  remember: boolean
}

/** 引擎服务连接状态（诊断用；UI 可据此提示"引擎未就绪"） */
export interface AppStatus {
  state: 'starting' | 'running' | 'stopped' | 'failed'
  /** 引擎实际运行的 Node 版本（握手时上报） */
  nodeVersion: string | null
  /** state=failed 时的原因，供日志/UI 呈现 */
  error: string | null
}

/** guest:credentials 响应：一次性票据（30s，兑换即焚）+ HTTP 门端口 */
export interface GuestCredentialsResult {
  ticket: string
  expiresAt: number
  httpPort: number
  /** 本次签发的档位（demo 页 = write：列会话/发起对话/收事件流） */
  scope: 'readonly' | 'write'
}

/** key 配置状态（credentials:list 响应）：只回布尔位；明文只走 credentials:get 单取 */
export interface ApiKeyStatus {
  providerId: string
  keyConfigured: boolean
}

/**
 * 凭据链路健康状态（credentials:status 响应）。error 非 null = 启动期降级
 * （文件损坏/跨机器 DPAPI 不匹配/safeStorage 不可用）：凭据不注入引擎，
 * 设置页呈现引导用户重输 key（成功写入即自愈）。
 */
export interface CredentialsStatus {
  error: string | null
}

/**
 * 会话级偏好文件形状（settings:get / settings:save 的载荷；盘上 settings.json）。
 * 此前 preload 用 Record<string, unknown> 宽类型，renderer 只能自造镜像且已漂移
 * （漏 activeProviderId）—— 形状在此单点定义，三端同源。
 */
export interface SettingsFile {
  version: 1
  activeModelId?: string
  /** 选中模型的 provider（同名模型跨 provider 消歧，与 activeModelId 成对；旧文件缺省 = 单键语义） */
  activeProviderId?: string
  thinkingLevel?: string
  /** 新会话默认权限（审批交互升级 D6：开关两态 —— 开 = auto、关/缺省 = ask；
      plan 不进默认，plan 是临时切入的工作方式而非开局常态，2026-11-11 拍板） */
  defaultPermissionMode?: 'ask' | 'auto'
  /** 聊天输入框的发送组合键（其余 Enter 组合换行）；缺省 = 'enter'（首发行为） */
  sendShortcut?: 'enter' | 'shift+enter' | 'ctrl+enter'
  /** 关闭最后一个窗口的行为（main 侧 close 拦截消费）：minimize = 隐藏到
      系统托盘（托盘点击恢复/右键退出）、quit = 直接退出、ask = 每次询问；
      缺省 = 'ask'（用户拍板：首启即问一次，「不再询问」把选择固化下来） */
  closeBehavior?: 'minimize' | 'quit' | 'ask'
  /** Chromium 硬件加速开关：false = main 在 app ready 前调
      disableHardwareAcceleration（规避部分显卡/驱动导致的白屏、闪退、渲染
      异常）；缺省 = true（Electron 默认开）。只在启动期消费，改后重启生效 */
  hardwareAcceleration?: boolean
  /** —— 通知与提示音（触发条件 × 呈现方式正交，见 docs/计划/通知与提示音.md）—— */
  /** 轮次完成的提醒条件：always / never / unfocused（缺省，聚焦时不打扰） */
  turnDoneNotify?: 'always' | 'never' | 'unfocused'
  /** 权限请求时提醒（approval.request）；缺省开 */
  approvalNotify?: boolean
  /** 等待回答时提醒（question.asked）；缺省开 */
  questionNotify?: boolean
  /** 呈现方式 · 系统 toast（main 侧 Electron Notification，点击聚焦窗口）；
      缺省关（用户定调声音为主） */
  toastEnabled?: boolean
  /** 呈现方式 · 提示音（renderer 合成/自定义文件）；缺省开 */
  soundEnabled?: boolean
  /** 提示音音量 0–1（合成 GainNode 与文件 Audio.volume 共用）；缺省 0.5 */
  soundVolume?: number
  /** 合成音基频 Hz（400–1200，三类音型按相对模式取值）；缺省 660。
      只影响合成音 —— 自定义文件不做变调（playbackRate 破坏音质） */
  soundPitch?: number
  /** 自定义声音文件（~/.cogent/sounds/ 下纯文件名，三类独立；缺省 = 合成音） */
  turnDoneSoundFile?: string
  approvalSoundFile?: string
  questionSoundFile?: string
  /** 对外 MCP Server（阶段 5a）：enabled = main 在 Host 启动后铸凭据写
      mcp-access.json；allowWrites 决定凭据档位（write = 写组工具注册）。
      文件级配置（手编 settings.json），首发不做设置页 UI */
  externalMcp?: { enabled: boolean; allowWrites: boolean }
}
