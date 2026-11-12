/// <reference types="vite/client" />
/**
 * window.cogent 的类型声明（与 electron/preload/index.ts 的 api 形状保持一致）。
 * 不直接 import preload 源码的类型：preload 属 tsconfig.node 工程，renderer 属
 * tsconfig.web —— eslint 的 projectService 解析不了跨工程引用（报 cannot be
 * resolved），改为本地声明窄接口，同时呼应"白名单窄接口"纪律：这里写的就是
 * renderer 能看到的全部能力。preload 侧形状变更时两处同步改。
 *
 * 协议类型（ChatMessage/ModelSummary/SessionSummary 等）从 @shared 不可达（它们在
 * src/protocol，属于引擎协议而非壳契约），故此处按需内联渲染所需的最小形状。
 */
declare global {
  interface Window {
    cogent: {
      /** 查询 Agent 引擎服务连接状态（诊断） */
      getStatus: () => Promise<{
        state: 'starting' | 'running' | 'stopped' | 'failed'
        nodeVersion: string | null
        error: string | null
      }>
      /** 引擎方法代理（method 白名单在 main 侧 ipc/engine.ts 收窄） */
      engineRequest: <M extends EngineMethod>(
        method: M,
        params: EngineMethodParams[M]
      ) => Promise<EngineMethodResult[M]>
      /** 订阅引擎事件流，返回取消订阅函数 */
      onEngineEvent: (callback: (event: EngineEvent) => void) => () => void
      /** 审批裁决（专属通道，不经 engineRequest 通用代理 —— 安全边界独立成路）：
          允许/拒绝引擎挂起中的写类工具调用；options.message = 拒绝附言（「告诉
          模型接下来怎么做」进工具结果给模型），options.always = 'workspace' 落
          工作区级始终允许规则（隐含允许本次） */
      respondApproval: (
        requestId: string,
        approved: boolean,
        options?: { message?: string; always?: 'workspace' }
      ) => Promise<{ ok: true }>
      /** 写入 API key（safeStorage 落盘 + 推引擎；明文只此一路出 renderer） */
      setApiKey: (providerId: string, apiKey: string) => Promise<{ ok: true }>
      /** 删除单条 API key（壳侧落盘移除 + 引擎内存表移除；清 key 的正路） */
      removeApiKey: (providerId: string) => Promise<{ ok: true }>
      /** 读单个 provider 的 key 明文（设置页全量回显；无记录返回空串） */
      getApiKey: (providerId: string) => Promise<string>
      /** 查询 key 配置状态（providerId + keyConfigured 布尔位） */
      listApiKeys: () => Promise<Array<{ providerId: string; keyConfigured: boolean }>>
      /** 凭据链路健康状态（启动期降级的 UI 呈现源；error 为 null = 健康） */
      getCredentialsStatus: () => Promise<{ error: string | null }>
      /** 读自定义 provider 定义（含内置 provider 的 baseUrl 覆盖；定义不含 key） */
      getCustomProviders: () => Promise<CustomProvidersPayload>
      /** 全量写自定义 provider 定义（落盘 + 引擎 running 时推 sync） */
      setCustomProviders: (
        providers: CustomProvidersPayload['providers'],
        overrides: CustomProvidersPayload['overrides']
      ) => Promise<{ ok: true }>
      /** 弹系统目录选择框（创建项目用）；用户取消返回 null */
      pickDirectory: () => Promise<string | null>
      /** 系统默认程序打开路径/目录（目录 = 资源管理器）；成功 null，失败错误串 */
      openPath: (path: string) => Promise<string | null>
      /** 打开（或聚焦已开的）运行时控制台窗口 */
      openConsole: () => Promise<void>
      /** 读会话级偏好（选中模型/思考力度）；形状与 shared/ipc.ts 的 SettingsFile 镜像 */
      getSettings: () => Promise<AppSettingsFile>
      /** 写会话级偏好（字段合并） */
      saveSettings: (partial: Partial<Omit<AppSettingsFile, 'version'>>) => Promise<{ ok: true }>
      /** 窗口控制（自绘 header 专用） */
      minimizeWindow: () => Promise<void>
      toggleMaximizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      /** 订阅最大化状态变化，返回取消订阅函数 */
      onWindowState: (callback: (isMaximized: boolean) => void) => () => void
    }
  }
}

/** 引擎方法名（renderer 可触达的子集；白名单在 main 侧 ipc/engine.ts 收窄 ——
    providers.custom.sync 已退出：自定义 provider 的写路径只有 custom-providers:set） */
export type EngineMethod =
  | 'session.list'
  | 'session.create'
  | 'session.delete'
  | 'session.messages'
  | 'session.setPinned'
  | 'session.archive'
  | 'session.listArchived'
  | 'session.setPermission'
  | 'session.compact'
  | 'session.continue'
  | 'project.list'
  | 'project.create'
  | 'project.rename'
  | 'project.update'
  | 'project.delete'
  | 'project.setPinned'
  | 'agent.submit'
  | 'agent.abort'
  | 'credentials.list'
  | 'models.list'
  | 'inspect.entries'
  | 'inspect.entry'

/**
 * 会话级偏好文件形状（与 shared/ipc.ts SettingsFile 镜像；preload 侧同源导出）。
 * 版本字段由 main 维护，renderer 只读写业务字段。
 */
export interface AppSettingsFile {
  version: 1
  activeModelId?: string
  activeProviderId?: string
  thinkingLevel?: string
  /** 新会话默认权限（开关两态 ask↔auto；plan 不进默认，见 D6 拍板） */
  defaultPermissionMode?: 'ask' | 'auto'
}

/** 会话摘要（与 protocol SessionSummary 镜像；optional 字段=未设置） */
export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  cwd?: string
  projectId?: string
  /** 置顶时间（毫秒）；缺省 = 未置顶 */
  pinnedAt?: number
  /** 归档时间（毫秒）；缺省 = 未归档（回收站语义） */
  archivedAt?: number
  /** 权限模式（缺省 = ask：写类工具先审批；auto = 完全访问；plan = 只读） */
  permissionMode?: PermissionMode
}

/** 会话级权限模式（与 protocol PermissionMode 镜像） */
export type PermissionMode = 'auto' | 'ask' | 'plan' | 'autonomous'

/** 项目摘要（与 protocol ProjectSummary 镜像）：项目 = 目录绑定（多根，首个主根） */
export interface ProjectSummary {
  id: string
  name: string
  cwds: string[]
  createdAt: number
  /** 置顶时间（毫秒）；缺省 = 未置顶 */
  pinnedAt?: number
}

/** 与 protocol/types.ts 对应 method 的参数形状（renderer 侧镜像声明） */
export interface EngineMethodParams {
  'session.list': Record<string, never>
  'session.create': { title?: string; cwd?: string; projectId?: string; permissionMode?: PermissionMode }
  'session.delete': { sessionId: string }
  'session.messages': { sessionId: string }
  'session.setPinned': { sessionId: string; pinned: boolean }
  'session.archive': { sessionId: string; archived: boolean }
  'session.listArchived': Record<string, never>
  'session.setPermission': { sessionId: string; mode: PermissionMode }
  'session.compact': { sessionId: string }
  'session.continue': { sessionId: string }
  'project.list': Record<string, never>
  'project.create': { name: string; cwds: string[] }
  'project.rename': { projectId: string; name: string }
  'project.update': { projectId: string; name: string; cwds: string[] }
  'project.delete': { projectId: string }
  'project.setPinned': { projectId: string; pinned: boolean }
  'agent.submit': { sessionId: string; text: string; model?: string; provider?: string; thinkingLevel?: string }
  'agent.abort': { sessionId: string }
  'credentials.list': Record<string, never>
  'models.list': Record<string, never>
  'inspect.entries': { sessionId: string }
  'inspect.entry': { sessionId: string; seq: number }
}

/** 与 protocol/types.ts 对应 method 的结果形状（renderer 侧镜像声明） */
export interface EngineMethodResult {
  'session.list': SessionSummary[]
  'session.create': SessionSummary
  'session.delete': { deleted: boolean }
  'session.messages': { messages: ChatMessage[] }
  'session.setPinned': { summary: SessionSummary }
  'session.archive': { summary: SessionSummary }
  'session.listArchived': SessionSummary[]
  'session.setPermission': { summary: SessionSummary }
  'session.compact': { tokensBefore: number; tokensAfter: number }
  'session.continue': { ok: true }
  'project.list': ProjectSummary[]
  'project.create': { summary: ProjectSummary }
  'project.rename': { summary: ProjectSummary }
  'project.update': { summary: ProjectSummary }
  'project.delete': { deleted: boolean }
  'project.setPinned': { summary: ProjectSummary }
  'agent.submit': { accepted: true }
  'agent.abort': { aborted: boolean }
  'credentials.list': { providers: ProviderSummary[] }
  'models.list': { models: ModelSummary[]; defaultModel?: { provider: string; id: string } }
  'inspect.entries': { entries: InspectEntrySummary[] }
  'inspect.entry': InspectEntryDetail
}

/**
 * 引擎事件帧：与 protocol RpcEvent 同形（{ jsonrpc, method, params }）。
 * 业务载荷在 params 里 —— 之前误声明成平铺形状，TS 没能拦住消费侧按顶层取字段的
 * bug（'sessionId' in event 永假 → 事件被静默丢弃），类型必须忠实于运行时形状。
 */
export type EngineEvent =
  | { method: 'run.started'; params: { sessionId: string } }
  | {
      method: 'run.completed'
      params: {
        sessionId: string
        message?: ChatMessage
        /** 分段终态（工具循环 text/工具卡交错保真）；优先于 message 消费 */
        messages?: ChatMessage[]
        /** length = 输出被 token 上限截断 */
        stopReason?: string
      }
    }
  | { method: 'run.failed'; params: { sessionId: string; message: string } }
  | {
      method: 'message.delta'
      params: { sessionId: string; messageId: string; delta: string; kind?: 'text' | 'thinking' }
    }
  | { method: 'tool.started'; params: { sessionId: string; callId: string; name: string; kind: string; summary?: string } }
  | { method: 'tool.completed'; params: { sessionId: string; callId: string; isError: boolean; summary: string; diff?: string } }
  | { method: 'tool.progress'; params: { sessionId: string; callId: string; text: string } }
  | { method: 'approval.request'; params: { sessionId: string; requestId: string; toolName: string; kind: string; summary: string } }
  | { method: 'inspect.event'; params: { sessionId: string; entry: InspectEntrySummary } }
  | { method: 'compaction.started'; params: { sessionId: string; reason: 'threshold' | 'manual' } }
  | {
      method: 'compaction.pruned'
      params: {
        sessionId: string
        entries: Array<{ toolCallId: string; originalChars: number; prunedChars: number }>
      }
    }
  | {
      method: 'compaction.completed'
      params: {
        sessionId: string
        reason: 'threshold' | 'manual'
        tokensBefore?: number
        tokensAfter?: number
        summary?: string
        /** 被摘要区末条消息 timestamp（折叠条原位锚点）；失败时缺省 */
        summarizedUntil?: number
        /** 摘要请求的用量（与 protocol 镜像）：摘要不进 run 分段账，折叠条小字呈现 */
        summaryUsage?: MessageUsage
        error?: string
      }
    }

/**
 * 观测条目摘要（与 protocol InspectEntrySummary 镜像）：时间线一行。
 * 四层 kind 分组 = 学习解剖层次（接口/引擎/工具/会话 + 提示词）。
 */
export type InspectEntryKind =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'system.prompt'
  | 'turn.started'
  | 'turn.completed'
  | 'api.request'
  | 'api.response'
  | 'api.stream'
  | 'tool.started'
  | 'tool.completed'

export interface InspectEntrySummary {
  seq: number
  ts: number
  kind: InspectEntryKind
  /** 所属 run 序号（时间线分组） */
  run: number
  title: string
  overview?: Array<{ label: string; value: string }>
  hasDetail: boolean
}

/** 观测条目详情（与 protocol InspectEntryDetail 镜像）：按块分 Tab/分节渲染 */
export interface InspectEntryDetail {
  seq: number
  blocks: Array<{ name: string; format: 'json' | 'text'; content: string }>
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'compaction'
  /**
   * UI 消息联合（stores/chat 的 MessageItem）判别辅助：内容消息恒 undefined，
   * 工具卡行（ToolItem）为 'tool' —— optional undefined 使 `item.type === 'tool'`
   * 能正确窄化联合（协议侧无此字段，纯 renderer 镜像层的判别技巧）
   */
  type?: undefined
  content: string
  /** 思考文本（仅 assistant 且模型开了思考才有；与 protocol ChatMessage.thinking 镜像） */
  thinking?: string
  /** token 用量（仅 assistant；与 protocol ChatMessage.usage 镜像），缺省 = 无数据不渲染统计行 */
  usage?: MessageUsage
  /** 模型耗时毫秒（仅 assistant；与 protocol ChatMessage.durationMs 镜像） */
  durationMs?: number
  /** 产生本回答的模型 id（与 protocol ChatMessage.model 镜像；UI 暂不展示） */
  model?: string
  /** 本条消息发起的工具调用（按发生序；与 protocol ChatMessage.toolCalls 镜像） */
  toolCalls?: ToolCallRecord[]
  /** 压缩元数据（仅 role 'compaction'；与 protocol ChatMessage.compaction 镜像）：
   *  content = checkpoint 摘要全文，折叠条展开可读；summaryUsage = 摘要调用
   *  自身的账（不进回合统计，折叠条小字呈现；旧引擎投影无此字段） */
  compaction?: { tokensBefore: number; tokensAfter?: number; summaryUsage?: MessageUsage }
  timestamp: number
}

/** 工具调用投影（工具卡数据形状；与 protocol ToolCallRecord 镜像） */
export interface ToolCallRecord {
  callId: string
  name: string
  /** 'read' | 'write' | 'edit' | 'exec' | 'network'（与 protocol ToolKind 镜像） */
  kind: string
  /** 参数一行摘要（工具卡标题） */
  summary: string
  status: 'ok' | 'error' | 'blocked'
  /** 结果一行摘要；错误/拒绝时为原因 */
  resultSummary?: string
  /** 执行起/止毫秒（与 protocol 镜像；聚合行「工具时长」区间并集用，缺省跳过） */
  startedAt?: number
  endedAt?: number
  /** edit 工具的展示 diff（与 protocol 镜像；缺省不渲染 diff 块） */
  diff?: string
}

/** 一次回答的 token 用量（与 protocol MessageUsage 镜像；见其字段注释） */
export interface MessageUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 思考 token（output 子集）；provider 未报告该细项时缺省 */
  reasoning?: number
  totalTokens: number
  /** 本次总成本 USD；无定价时缺省 */
  totalCost?: number
  /** 成本是否端点实报；false/缺省 = 目录估价（UI 加 ≈ 前缀） */
  totalCostFromProvider?: boolean
  /** 上下文明细三段估算（粗估口径带 ≈）；引擎未算/旧会话缺省 */
  contextEstimate?: ContextEstimate
}

/** 上下文明细三段估算（与 protocol ContextEstimate 镜像；见其字段注释） */
export interface ContextEstimate {
  systemPrompt: number
  toolDefs: number
  messages: number
  total: number
}

export interface ProviderSummary {
  id: string
  name: string
  keyConfigured: boolean
}

export interface ModelSummary {
  id: string
  name: string
  provider: string
  reasoning: boolean
  /** 该模型真实支持的思考力度档（含 'off'；引擎按 pi 目录判定） */
  thinkingLevels: ThinkingLevelWithOff[]
  contextWindow: number
  maxTokens: number
  /** 是否用户添加（缺省 false = pi 目录原生）；默认模型设置 UI 锁 id */
  userDefined?: boolean
  /** 有效压缩触发阈值占比（完备化 R1，引擎按 model.compaction 与窗口解出）；
      指示器预警线画它，小窗模型显著前移（20K 窗 ≈59%）。缺省回落 0.9 */
  compactionThresholdRatio?: number
}

/**
 * 用户自定义模型定义（与 protocol/types.ts ModelDef 镜像；引擎侧补默认值构建）。
 * pi 输入模态只有 text | image（视频/PDF 无对应字段）。
 * thinkingLevels：支持的思考等级子集（缺省 = 跟随端点默认），引擎据此构建
 * thinkingLevelMap（选中透传 / 未选中 null）。
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 完整档位（含 'off'）：model.thinkingLevels 的元素类型 */
export type ThinkingLevelWithOff = 'off' | ThinkingLevel

export interface ModelDef {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  reasoning?: boolean
  thinkingLevels?: ThinkingLevel[]
  /** 压缩参数覆盖（完备化 R1；缺省走引擎默认 0.9/8192）。设置 UI 在「高级」
      折叠（S7），此处先随协议形状同步 */
  compaction?: CompactionParamsOverride
  /** 思考预算（完备化 R7，token 按档位）：推理模型思考硬钳制，防小窗输出
      预算被吃光。设置 UI 在「高级」折叠 */
  thinkingBudgets?: ThinkingBudgetsOverride
}

/** 思考预算（token 按档位），镜像 protocol/types.ts；xhigh/max 档引擎侧归 high */
export interface ThinkingBudgetsOverride {
  minimal?: number
  low?: number
  medium?: number
  high?: number
}

/** provider 级兼容覆盖（完备化 R7 高级面），镜像 protocol/types.ts；仅 openai
    系方言消费，未设置时引擎按 baseUrl 自动探测 */
export interface ProviderCompatDef {
  thinkingTokenBudgetField?: 'thinking_budget' | 'thinking_budget_tokens' | 'thinking_token_budget'
  supportsThinkingTokenBudget?: boolean
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
}

/** 压缩触发参数的用户覆盖（ModelDef.compaction 的形状，镜像 protocol/types.ts） */
export interface CompactionParamsOverride {
  /** 占比触发线 (0,1]；默认 0.9 */
  thresholdRatio?: number
  /** 绝对余量下限（token）；默认 8192 */
  roomFloorTokens?: number
}

/** 自定义 provider 定义（与 protocol/types.ts CustomProviderDef 镜像；key 走 credentials 单独管理） */
export interface CustomProviderDef {
  /** custom/<slug> 形式 */
  id: string
  name: string
  baseUrl: string
  /** 模型 id 简写列表（与 modelDefs 合并注册，同 id 时 modelDefs 优先） */
  models: string[]
  /** 模型完整定义（带上下文/输出/模态/推理） */
  modelDefs?: ModelDef[]
  /** 端点 API 方言（缺省 openai-completions；anthropic 填根地址、openai 系带 /v1） */
  apiFormat?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /** 禁用模型：不注册进 provider，下拉不出现 */
  disabledModels?: string[]
  /** 整 provider 禁用：保留定义不注册 */
  disabled?: boolean
  /** 端点兼容覆盖（完备化 R7 高级面，仅 openai 系方言消费） */
  compat?: ProviderCompatDef
}

/**
 * 内置 provider 的本地调整（与 protocol/types.ts ProviderOverrideDef 镜像）：
 * baseUrl 空串 = 沿用官方端点；models = 用户新增（与目录并存）；disabledModels = 目录禁用。
 */
export interface ProviderOverrideDef {
  providerId: string
  baseUrl: string
  models?: ModelDef[]
  disabledModels?: string[]
}

export interface CustomProvidersPayload {
  providers: CustomProviderDef[]
  overrides: ProviderOverrideDef[]
}

export {}
