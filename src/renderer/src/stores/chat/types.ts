/**
 * chat store 的类型层（2026-11-17 会话状态重构 P2 自 chat.ts 拆出）：
 * 消息流元素联合（内容消息 / 工具卡 / 审批痕迹 / 裁剪副行）、挂起面板载荷、
 * 会话桶（SessionBucket —— 全部 per-session 状态的单一容器）与 ChatState。
 * 纯类型与载荷形状，无逻辑。
 */
import type { ChatMessage, MessageUsage, PermissionMode, SessionSummary, TodoItem } from '@/env.d'
import type { AttachmentRef, DirectoryRef } from '@shared/attachments'
import type { FileReference } from '@shared/files'

/** 引擎 SessionSummary 的 renderer 侧直接镜像（env.d.ts），不再本地重复声明 */
export type { SessionSummary }

/**
 * 工具调用项（消息流里的独立行，工具卡数据源）：
 * 流式期由 tool.started/completed 事件维护；终态/历史由段化消息的 toolCalls
 * 展平生成（flattenSegments）—— 两条来源同一形状，渲染单一（components/ui/tool）。
 */
export interface ToolItem {
  fileRefs?: FileReference[]
  /** = 引擎 callId（事件流与终态配对键，跨 run 唯一） */
  id: string
  /** 判别字段：消息列表元素联合（ChatMessage 无此字段） */
  type: 'tool'
  name: string
  /** ToolKind（read/write/edit/exec/network；呈现用） */
  toolKind: string
  /** 参数一行摘要（引擎生成，如 read("src/index.ts")） */
  summary: string
  status: 'running' | 'ok' | 'error' | 'blocked'
  /** 结果一行摘要；错误/拒绝时为原因 */
  resultSummary?: string
  /** 执行中的流式尾部快照（bash 直播窗；终态由 resultSummary 接管，此字段清空） */
  progress?: string
  /** edit 工具的展示 diff（带行号 +-/ 上下文）；流式（tool.completed 事件）与
   *  历史回查（ToolCallRecord）双来源同形 */
  diff?: string
  /** 执行起/止毫秒（终态/历史路径来自 ToolCallRecord 投影；流式事件路径缺省 ——
   *  聚合行只在终态渲染，恰好只消费有打点的那条来源） */
  startedAt?: number
  endedAt?: number
}

/**
 * 审批痕迹行（审批交互升级 D1：pending 态改走会话桶的 pendingApprovals，
 * 联合里的 approval 类型**只承载终态痕迹** —— 裁决完成时落行，随裁决历史留存；
 * pending 态不再进消息流，呈现迁至对话底部确认面板 ApprovalPanel）。
 * 模型转录里无对应物（引擎侧只是工具结果），run 终态替换时保留。
 */
export interface ApprovalItem {
  /** = 引擎 requestId（approval.respond 的配对键） */
  id: string
  /** 判别字段：消息列表元素联合 */
  type: 'approval'
  toolName: string
  /** ToolKind（呈现用） */
  toolKind: string
  /** 参数一行摘要（引擎生成，与工具卡标题同源） */
  summary: string
  status: 'approved' | 'denied' | 'cancelled'
}

/**
 * 会话级挂起审批（面板数据源，D1）：approval.request 建、裁决/中止收尾。
 * 数组形态 —— pi 并行执行同批工具（多个 write 同轮并发），每个 beforeToolCall
 * 挂起各发一个 approval.request，面板逐条呈现逐条裁决。
 */
export interface PendingApproval {
  requestId: string
  toolName: string
  /** ToolKind（呈现用） */
  toolKind: string
  /** 参数一行摘要（引擎生成，与工具卡标题同源） */
  summary: string
  /** 写类目标在工作区根之外（引擎标记）：面板据此隐藏「始终允许此工作区」
      （规则 = 根内信任记忆，永不覆盖越界；允许并切换为不受影响） */
  outsideRoots?: boolean
}

/**
 * 会话级挂起提问（交互座 4c-2，QuestionPanel 数据源）：question.asked 建、
 * respond/abort/settle 收尾。载荷 = 问题全文（选项/多选位都在，面板直接渲染）。
 */
export interface PendingQuestion {
  requestId: string
  questions: Array<{
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

/** 挂起中的方案审批（交互座 4c-3，PlanPanel 数据源）：plan.requested 建、respond/abort 收尾 */
export interface PendingPlan {
  requestId: string
  plan: string
}

/** L1 prune 的单条账目（副行与 runtime.pruned 配对共用形状） */
export interface PrunedEntry {
  toolCallId: string
  originalChars: number
  prunedChars: number
}

/**
 * L1 prune 副行：一次检查点裁了 N 处工具输出 → 一行
 * 「已裁剪 N 处工具输出」；转录里对应物是改写后的 toolResult（marker 即
 * 痕迹），本行是纯呈现物 —— 历史回查投影不产此行（引擎投影的 toolResult
 * 摘要自带 marker），仅事件路径落。
 */
export interface PrunedItem {
  id: string
  type: 'pruned'
  entries: PrunedEntry[]
  timestamp: number
}

/** 消息列表元素：内容消息（ChatMessage）或工具调用行（ToolItem）或审批卡行
    （ApprovalItem）或裁剪副行（PrunedItem） */
export type MessageItem = ChatMessage | ToolItem | ApprovalItem | PrunedItem

/** 一次执行的最终结果；显示回合可由同一user发起手动续写而更新结果。 */
export type RunOutcome = 'completed' | 'stopped' | 'failed'

/**
 * 会话运行标志（run 生命周期的瞬态）：此前是 7 个 XxxBySession 平行 map，
 * 2026-11-17 桶化并入 —— 删会话 = 删桶一键，编译器保证不再漏清某一项。
 */
export interface SessionRuntime {
  /** 流式中（发送/停止钮切换；分桶防跨会话互踩） */
  running: boolean
  /** 本窗停止请求在途；终态消费后清除，不作为回合结果 */
  stopping: boolean
  /** 本地停止请求身份；晚到的 IPC 响应只能收口自己，不能改写下一次请求或 run */
  stopRequestId: symbol | null
  /** 本次submit/continue调用身份；终态后其迟到拒绝不再拥有错误回写权 */
  runRequestId: symbol | null
  /** 最近一次 run 的权威终态；新 run 清空，历史水合没有该事实 */
  lastRunOutcome: RunOutcome | null
  /** 压缩进行中（compaction.started→completed 窗口）：消息流内状态条呈「正在压缩上下文」 */
  compacting: boolean
  /** 最近一次回复被 token 上限截断（stopReason=length） */
  truncated: boolean
  /** 运行或操作错误文案（会话尾部错误条），操作失败不改变 lastRunOutcome；null = 无 */
  lastError: string | null
  /** 最近一次 L1 prune 账目：completed 折叠条配对呈现「已裁剪 N 处」，取后即清 */
  pruned: PrunedEntry[] | null
  /** run 进行中的轮终实报（context.updated）：指示器实时分子 —— run 终态随
      segments 落账清除，compaction.completed 弃置（旧值让位 tokensAfter 估算） */
  contextLive: MessageUsage | null
}

/**
 * 单会话的 renderer 侧全部状态（桶）：消息流 + 任务清单 + 运行标志 + 三类
 * 挂起面板态。桶由 emptyBucket() 工厂创建（字段恒全，读写免判缺省），
 * 生命周期 = 会话生命周期（selectSession/createSession 建，deleteSession 删）。
 */
export interface SessionBucket {
  /** 消息流（含流式中的 assistant 占位与工具卡行） */
  messages: MessageItem[]
  /** 已加载消息的user.id -> 已知终态；后续提交不能把旧回合重标为完成。 */
  turnOutcomes: Partial<Record<string, RunOutcome>>
  /** 任务清单（交互座 4c，TodoStrip 数据源）：todo_write 全量快照 + 历史种子 */
  todos: TodoItem[]
  runtime: SessionRuntime
  /** 挂起审批（ApprovalPanel 数据源；run 终态兜底清空 —— 引擎侧挂起审批在
      run 终态前必被 resolve，此清是防御不是常态路径） */
  pendingApprovals: PendingApproval[]
  /** 挂起提问（QuestionPanel 数据源）：question.asked 建、respond/abort 收尾 */
  pendingQuestions: PendingQuestion[]
  /** 挂起方案审批（PlanPanel 数据源）：plan.requested 建、respond/abort 收尾 */
  pendingPlans: PendingPlan[]
}

export interface ChatState {
  sessions: SessionSummary[]
  activeSessionId: string | null
  /** sessionId → 会话桶：全部 per-session 状态的唯一家（详见 SessionBucket）。
      Partial = 键缺席的类型事实（项目不开 noUncheckedIndexedAccess，运行时
      可选性由容器形状表达，console.ts 同款）——读侧 `?? emptyBucket()` /
      `?.` 都是真分支，非防御 */
  bySession: Partial<Record<string, SessionBucket>>
  /** 初载失败的原因（引擎不可用等；App 横幅呈现）。null = 正常 */
  loadError: string | null

  /** 初载：拉会话列表并选中最近会话。空列表（首装/全部已归档）不自动建会话，
      落"新聊天"着陆页、发送时由 submit 按需物化 —— 会话只随用户动作产生 */
  load: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  /** 建会话并设为活动，返回新会话 id（submit 按需物化后直取，不回读状态判空） */
  createSession: (params?: {
    cwd?: string
    projectId?: string
    permissionMode?: PermissionMode
    planEnabled?: boolean
  }) => Promise<string>
  /** 会话级权限切换（「完全访问」按钮；三档，计划是独立开关见 setPlanMode） */
  setPermission: (sessionId: string, mode: PermissionMode) => Promise<void>
  /** 计划模式开关（正交于权限档；PlanToggle/菜单开关项调用） */
  setPlanMode: (sessionId: string, enabled: boolean) => Promise<void>
  /** 回答挂起中的 ask_user（交互座 4c-2；QuestionPanel 调用） */
  respondQuestion: (requestId: string, answers: Array<string | string[]>) => Promise<void>
  /** 裁决挂起中的 submit_plan（交互座 4c-3；PlanPanel 调用）：批准 = 关计划开关 */
  respondPlan: (requestId: string, approved: boolean, options?: { message?: string }) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  rename: (sessionId: string, title: string) => Promise<void>
  archive: (sessionId: string, archived: boolean) => Promise<void>
  /** true = 引擎受理；false = 旧调用已失效，输入区不执行成功后续；当次拒绝仍抛错 */
  submit: (text: string, model?: string, thinkingLevel?: string, provider?: string, attachments?: AttachmentRef[], directories?: DirectoryRef[]) => Promise<string | false>
  abort: () => Promise<void>
  /** 审批裁决（专属 IPC 通道）：先收面板/落痕迹行（乐观），引擎侧竞态失败不回滚；
      options.message = 拒绝附言（「告诉模型接下来怎么做」），options.always =
      'workspace' 落工作区级始终允许规则（审批交互升级 D2），options.switchMode
      = 「允许，并切换为」（切会话模式 + 记项目默认，F6 定稿；result.summary
      回写会话列表的模式标记） */
  respondApproval: (
    requestId: string,
    approved: boolean,
    options?: { message?: string; always?: 'workspace'; switchMode?: 'auto' | 'autonomous' }
  ) => Promise<void>
  /** 手动续写（截断动作条）：注入引擎侧续写指令再跑 —— 无用户
      泡（指令消息在引擎投影层并入相邻段），乐观置运行态，事件流照常驱动 */
  continueGeneration: () => Promise<void>
  /** 手动压缩（截断动作条的腾地方向）：session.compact，折叠条/回落由既有
      compaction 事件路径呈现；失败落会话错误条（手动动作要明确结果） */
  compactNow: () => Promise<void>
}
