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
      /** 写入 API key（safeStorage 落盘 + 推引擎；明文只此一路出 renderer） */
      setApiKey: (providerId: string, apiKey: string) => Promise<{ ok: true }>
      /** 读单个 provider 的 key 明文（设置页全量回显；无记录返回空串） */
      getApiKey: (providerId: string) => Promise<string>
      /** 查询 key 配置状态（providerId + keyConfigured 布尔位） */
      listApiKeys: () => Promise<Array<{ providerId: string; keyConfigured: boolean }>>
      /** 读自定义 provider 定义（含内置 provider 的 baseUrl 覆盖；定义不含 key） */
      getCustomProviders: () => Promise<CustomProvidersPayload>
      /** 全量写自定义 provider 定义（落盘 + 引擎 running 时推 sync） */
      setCustomProviders: (
        providers: CustomProvidersPayload['providers'],
        overrides: CustomProvidersPayload['overrides']
      ) => Promise<{ ok: true }>
      /** 弹系统目录选择框（创建项目用）；用户取消返回 null */
      pickDirectory: () => Promise<string | null>
      /** 读会话级偏好（选中模型/思考力度）；无文件返回 {} */
      getSettings: () => Promise<{ activeModelId?: string; thinkingLevel?: import('@/env.d').ThinkingLevel }>
      /** 写会话级偏好（字段合并） */
      saveSettings: (partial: { activeModelId?: string; thinkingLevel?: string }) => Promise<{ ok: true }>
      /** 窗口控制（自绘 header 专用） */
      minimizeWindow: () => Promise<void>
      toggleMaximizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      /** 订阅最大化状态变化，返回取消订阅函数 */
      onWindowState: (callback: (isMaximized: boolean) => void) => () => void
    }
  }
}

/** 引擎方法名（renderer 可触达的子集；全量见 src/protocol/types.ts ProtocolMethods） */
export type EngineMethod =
  | 'session.list'
  | 'session.create'
  | 'session.delete'
  | 'session.messages'
  | 'session.setPinned'
  | 'session.archive'
  | 'session.listArchived'
  | 'project.list'
  | 'project.create'
  | 'project.rename'
  | 'project.delete'
  | 'project.setPinned'
  | 'agent.submit'
  | 'agent.abort'
  | 'credentials.list'
  | 'models.list'
  | 'providers.custom.sync'

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
}

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
  'session.create': { title?: string; cwd?: string; projectId?: string }
  'session.delete': { sessionId: string }
  'session.messages': { sessionId: string }
  'session.setPinned': { sessionId: string; pinned: boolean }
  'session.archive': { sessionId: string; archived: boolean }
  'session.listArchived': Record<string, never>
  'project.list': Record<string, never>
  'project.create': { name: string; cwds: string[] }
  'project.rename': { projectId: string; name: string }
  'project.delete': { projectId: string }
  'project.setPinned': { projectId: string; pinned: boolean }
  'agent.submit': { sessionId: string; text: string; model?: string; provider?: string; thinkingLevel?: string }
  'agent.abort': { sessionId: string }
  'credentials.list': Record<string, never>
  'models.list': Record<string, never>
  'providers.custom.sync': {
    providers: CustomProviderDef[]
    overrides: Array<{ providerId: string; baseUrl: string }>
  }
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
  'project.list': ProjectSummary[]
  'project.create': { summary: ProjectSummary }
  'project.rename': { summary: ProjectSummary }
  'project.delete': { deleted: boolean }
  'project.setPinned': { summary: ProjectSummary }
  'agent.submit': { accepted: true }
  'agent.abort': { aborted: boolean }
  'credentials.list': { providers: ProviderSummary[] }
  'models.list': { models: ModelSummary[] }
  'providers.custom.sync': { synced: number }
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
      params: { sessionId: string; message?: ChatMessage; /** length = 输出被 token 上限截断 */ stopReason?: string }
    }
  | { method: 'run.failed'; params: { sessionId: string; message: string } }
  | {
      method: 'message.delta'
      params: { sessionId: string; messageId: string; delta: string; kind?: 'text' | 'thinking' }
    }
  | { method: 'tool.started'; params: { sessionId: string; callId: string; name: string; kind: string } }
  | { method: 'tool.completed'; params: { sessionId: string; callId: string; isError: boolean; summary: string } }
  | { method: 'approval.request'; params: { sessionId: string; requestId: string; toolName: string; kind: string; summary: string } }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 思考文本（仅 assistant 且模型开了思考才有；与 protocol ChatMessage.thinking 镜像） */
  thinking?: string
  /** token 用量（仅 assistant；与 protocol ChatMessage.usage 镜像），缺省 = 无数据不渲染统计行 */
  usage?: MessageUsage
  /** 模型耗时毫秒（仅 assistant；与 protocol ChatMessage.durationMs 镜像） */
  durationMs?: number
  /** 产生本回答的模型 id（与 protocol ChatMessage.model 镜像；UI 暂不展示） */
  model?: string
  timestamp: number
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
  /** 端点 API 方言（缺省 openai-completions；anthropic 时 baseUrl 填根地址） */
  apiFormat?: 'openai-completions' | 'anthropic-messages'
  /** 禁用模型：不注册进 provider，下拉不出现 */
  disabledModels?: string[]
  /** 整 provider 禁用：保留定义不注册 */
  disabled?: boolean
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
