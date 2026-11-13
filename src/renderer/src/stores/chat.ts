/**
 * 聊天数据状态：会话列表、各会话消息、流式累积。
 * 数据源头是引擎事件流（onEngineEvent），store 是事件与 UI 之间的缓冲；
 * 初载（load）拉会话列表，选中会话时按需拉历史消息。
 *
 * 运行态分域（2026-11-10，架构审查修复）：running/lastError/truncated/stopping
 * 一律按 sessionId 分域（同 console store 的 runningBySession 手法）。此前是全局
 * 单例：会话 A 流式中切到 B 发消息，A 完成会把全局 running 置 false → B 的停止钮
 * 错变发送；反向则 B 的输入框被 A 的 running 锁死；错误/截断文案也会串会话。
 * 组件侧用 selectRunning / selectStopping / selectLastError / selectTruncated
 * 取活动会话的视图。stopping = 用户点了停止的前置位（回合头条「已停止」与
 * 「出错了」的判别依据，见 docs/计划/回合过程折叠.md D6）。
 */
import { create } from 'zustand'
import type { ChatMessage, PermissionMode, SessionSummary } from '@/env.d'
import { useHomeStore } from '@/stores/home'
import { useEngineStore } from '@/stores/engine'

/**
 * 工具调用项（消息流里的独立行，工具卡数据源）：
 * 流式期由 tool.started/completed 事件维护；终态/历史由段化消息的 toolCalls
 * 展平生成（flattenSegments）—— 两条来源同一形状，渲染单一（components/ui/tool）。
 */
export interface ToolItem {
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
 * 审批痕迹行（审批交互升级 D1：pending 态改走会话级 pendingApprovalBySession，
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
}

/**
 * L1 prune 副行（完备化 R3/D8）：一次检查点裁了 N 处工具输出 → 一行
 * 「已裁剪 N 处工具输出」；转录里对应物是改写后的 toolResult（marker 即
 * 痕迹），本行是纯呈现物 —— 历史回查投影不产此行（引擎投影的 toolResult
 * 摘要自带 marker），仅事件路径落。
 */
export interface PrunedItem {
  id: string
  type: 'pruned'
  entries: Array<{ toolCallId: string; originalChars: number; prunedChars: number }>
  timestamp: number
}

/** 消息列表元素：内容消息（ChatMessage）或工具调用行（ToolItem）或审批卡行
    （ApprovalItem）或裁剪副行（PrunedItem，完备化 R3/D8） */
export type MessageItem = ChatMessage | ToolItem | ApprovalItem | PrunedItem

/**
 * 引擎 IPC 错误剥壳（R10）：ipcRenderer.invoke 对 main 侧拒绝统一包一层
 * "Error invoking remote method 'engine:request': Error: " 前缀（Electron
 * 行为，非协议内容），协议帧的 message 才是给人读的文案 —— lastErrorBySession
 * 直出渲染前剥掉，否则用户看到的是裸 IPC 报文（验收实测）。
 * 2026-11-12 导出：单测直测（docs/计划/测试体系.md D7，仅加 export 不改行为）。
 */
export function unwrapIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/**
 * 段化消息 → 消息流元素展平（终态替换与历史加载共用）：
 * 每段先落它的工具卡（toolCalls 按序），再落消息本体；纯工具段（无正文无思考）
 * 不落消息本体 —— 只留卡，避免空消息占行。
 * 2026-11-12 导出：单测直测（同上）。
 */
export function flattenSegments(segments: ChatMessage[]): MessageItem[] {
  const items: MessageItem[] = []
  for (const segment of segments) {
    for (const call of segment.toolCalls ?? []) {
      items.push({
        id: call.callId,
        type: 'tool',
        name: call.name,
        toolKind: call.kind,
        summary: call.summary,
        status: call.status,
        resultSummary: call.resultSummary,
        diff: call.diff,
        startedAt: call.startedAt,
        endedAt: call.endedAt
      })
    }
    if (segment.content !== '' || segment.thinking !== undefined) {
      items.push({ ...segment, toolCalls: undefined })
    }
  }
  return items
}

/**
 * 终态替换并回：审批痕迹行锚回各自工具卡之前（run.completed 内联逻辑提出，
 * 2026-11-12，行为不变 —— 单测直测）。kept = 替换区里要保留的痕迹行；
 * 配不上（理论上缺卡）退尾部兜底；并行同摘要多卡时按裁决序叠在卡组之前。
 */
export function flatWithApprovals(flat: MessageItem[], kept: ApprovalItem[]): MessageItem[] {
  if (kept.length === 0) return flat
  const anchored = [...flat]
  for (const trace of kept) {
    const at = anchored.findIndex(
      (item) => item.type === 'tool' && item.name === trace.toolName && item.summary === trace.summary
    )
    anchored.splice(at >= 0 ? at : anchored.length, 0, trace)
  }
  return anchored
}

/** 并回行的时间序键：工具卡用执行终点（endedAt ?? startedAt），审批痕迹行无
 *  时间戳（undefined = 比较跳过、位置退化），其余用 timestamp */
function itemTime(item: MessageItem): number | undefined {
  if (item.type === 'tool') return item.endedAt ?? item.startedAt
  if (item.type === 'approval') return undefined
  return item.timestamp
}

/**
 * 终态替换并回：压缩条/裁剪副行按时间序并回替换区（D9 —— 压缩发生在 run
 * 边界/轮间，completed/pruned 事件插进替换区，run.completed 整段替换不得吞掉；
 * run.completed 内联逻辑提出，2026-11-12，行为不变 —— 单测直测）。
 */
export function flatWithCompaction(flat: MessageItem[], kept: Array<ChatMessage | PrunedItem>): MessageItem[] {
  if (kept.length === 0) return flat
  const merged = [...flat]
  for (const extra of kept) {
    let at = -1
    for (let i = 0; i < merged.length; i++) {
      const t = itemTime(merged[i])
      if (t !== undefined && t > extra.timestamp) {
        at = i
        break
      }
    }
    merged.splice(at >= 0 ? at : merged.length, 0, extra)
  }
  return merged
}

/** sessionId → 消息列表（含流式中的 assistant 消息与工具卡行） */
type MessagesBySession = Partial<Record<string, MessageItem[]>>

/** 引擎 SessionSummary 的 renderer 侧直接镜像（env.d.ts），不再本地重复声明 */
export type { SessionSummary }

export interface ChatState {
  sessions: SessionSummary[]
  activeSessionId: string | null
  /** sessionId → 消息列表（含流式中的 assistant 消息） */
  messagesBySession: MessagesBySession
  /** sessionId → 挂起审批（确认面板数据源；run 终态兜底清空 —— 引擎侧挂起
      审批在 run 终态前必被 resolve，此清是防御不是常态路径） */
  pendingApprovalsBySession: Partial<Record<string, PendingApproval[]>>
  /** sessionId → 是否流式中（发送/停止钮切换；分域防跨会话互踩） */
  runningBySession: Partial<Record<string, boolean>>
  /** sessionId → 用户点了停止（run 终态事件消费后清零 —— 回合头条
      「已停止」（保半截正文）与「出错了」（真失败）的判别位） */
  stoppingBySession: Partial<Record<string, boolean>>
  /** sessionId → 最近一次 run.failed 的错误文案（会话尾部错误条） */
  lastErrorBySession: Partial<Record<string, string>>
  /** sessionId → 最近一次回复是否被 token 上限截断（stopReason=length） */
  truncatedBySession: Partial<Record<string, boolean>>
  /** sessionId → 压缩进行中（完备化 D8，compaction.started→completed 窗口）：
      消息流内状态条呈「正在压缩上下文」（Codex 两态形态的前态） */
  compactingBySession: Partial<Record<string, boolean>>
  /** sessionId → 最近一次 L1 prune（完备化 R3）：pruned 副行文案与折叠条同区
      呈现；completed 大手术会重排列表，副行在 completed 后落（时序见事件分支） */
  prunedBySession: Partial<Record<string, Array<{ toolCallId: string; originalChars: number; prunedChars: number }>>>
  /** 初载失败的原因（引擎不可用等；App 横幅呈现）。null = 正常 */
  loadError: string | null

  /** 初载：拉会话列表并选中最近会话。空列表（首装/全部已归档）不自动建会话，
      落"新聊天"着陆页、发送时由 submit 按需物化 —— 会话只随用户动作产生 */
  load: () => Promise<void>
  selectSession: (sessionId: string) => Promise<void>
  /** 建会话并设为活动，返回新会话 id（submit 按需物化后直取，不回读状态判空） */
  createSession: (params?: { cwd?: string; projectId?: string; permissionMode?: PermissionMode }) => Promise<string>
  /** 会话级权限切换（ask ↔ auto；「完全访问」按钮） */
  setPermission: (sessionId: string, mode: PermissionMode) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  archive: (sessionId: string, archived: boolean) => Promise<void>
  submit: (text: string, model?: string, thinkingLevel?: string, provider?: string) => Promise<void>
  abort: () => Promise<void>
  /** 审批裁决（专属 IPC 通道）：先收面板/落痕迹行（乐观），引擎侧竞态失败不回滚；
      options.message = 拒绝附言（「告诉模型接下来怎么做」），options.always =
      'workspace' 落工作区级始终允许规则（审批交互升级 D2） */
  respondApproval: (
    requestId: string,
    approved: boolean,
    options?: { message?: string; always?: 'workspace' }
  ) => Promise<void>
  /** 手动续写（完备化 R6③，截断动作条）：注入引擎侧续写指令再跑 —— 无用户
      泡（指令消息在引擎投影层并入相邻段），乐观置运行态，事件流照常驱动 */
  continueGeneration: () => Promise<void>
  /** 手动压缩（截断动作条的腾地方向）：session.compact，折叠条/回落由既有
      compaction 事件路径呈现；失败落会话错误条（手动动作要明确结果） */
  compactNow: () => Promise<void>
}

/** 活动会话是否流式中（组件订阅用；返回原始值，selector 引用稳定） */
export function selectRunning(state: ChatState): boolean {
  return state.activeSessionId !== null && state.runningBySession[state.activeSessionId] === true
}

/** 活动会话是否处于「已点停止、终态未到」的窗口（回合头条判别用） */
export function selectStopping(state: ChatState): boolean {
  return state.activeSessionId !== null && state.stoppingBySession[state.activeSessionId] === true
}

/** 活动会话的最近错误文案（无 = null） */
export function selectLastError(state: ChatState): string | null {
  if (state.activeSessionId === null) return null
  return state.lastErrorBySession[state.activeSessionId] ?? null
}

/** 活动会话的最近回复是否被截断 */
export function selectTruncated(state: ChatState): boolean {
  return state.activeSessionId !== null && state.truncatedBySession[state.activeSessionId] === true
}

/** 活动会话压缩进行中（完备化 D8：started→completed 窗口的状态条判别位） */
export function selectCompacting(state: ChatState): boolean {
  return state.activeSessionId !== null && state.compactingBySession[state.activeSessionId] === true
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  pendingApprovalsBySession: {},
  runningBySession: {},
  stoppingBySession: {},
  lastErrorBySession: {},
  truncatedBySession: {},
  compactingBySession: {},
  prunedBySession: {},
  loadError: null,

  // 初载不自动建会话：归档是回收站语义，"活跃列表空"有两种含义 —— 首装，或
  // 用户归档了全部会话（合法终态）。原"列表空就建一个"在后者每次重启都复活
  // 一个幽灵"新会话"（用户归档两个会话后重启"还在"的元凶；且 StrictMode 双
  // 挂载下 load 并发跑两遍会各建一个，盘上留下 13ms 双胞胎）。空列表统一落
  // "新聊天"着陆页，会话改由用户动作物化（点新聊天 = startNew，发首条消息
  // = submit 按需建）
  // 失败落 loadError（引擎不可用时 App 横幅呈现 + 重试），不再裸抛成
  // unhandled rejection
  load: async () => {
    try {
      const sessions = await window.cogent.engineRequest('session.list', {})
      set({ sessions, loadError: null })
      if (get().activeSessionId === null && sessions.length > 0) {
        await get().selectSession(sessions[0].id)
        // 视图态对齐（修"重启后已有内容的会话还挂着信息区"）：load 自动选中了
        // 最近会话，home store 若还停在默认 kind:'new'，就会出现"对话内容 +
        // 选择项目信息条"同屏的错排 —— 选中即 chat 态
        useHomeStore.setState({ session: { kind: 'chat', chatId: sessions[0].id } })
      }
    } catch (error) {
      set({ loadError: error instanceof Error ? error.message : String(error) })
    }
  },

  selectSession: async (sessionId) => {
    set({ activeSessionId: sessionId })
    // 按需拉历史（盘上转录已持久化，切换时重拉一次拿最新；本地缓存优化属后续件）。
    // 展平：段化消息里的 toolCalls → 独立工具卡行（与流式期事件路径同一形状）
    if (get().messagesBySession[sessionId] === undefined) {
      const { messages } = await window.cogent.engineRequest('session.messages', { sessionId })
      set((state) => ({ messagesBySession: { ...state.messagesBySession, [sessionId]: flattenSegments(messages) } }))
    }
  },

  createSession: async (params) => {
    // 权限模式随物化落定（审批交互升级第 3 步）：显式 params > 新聊天暂存位 >
    // 设置页「默认权限」（engine store；ask 缺省语义与协议/引擎一致）
    const home = useHomeStore.getState().session
    // 链尾 engine store 字段非 optional，链必有值 → 直接落（等值覆盖 params 的
    // 同名字段，语义 = 显式选择优先已由 ?? 链前段保证）
    const permissionMode =
      params?.permissionMode ??
      (home.kind === 'new' ? home.permissionMode : undefined) ??
      useEngineStore.getState().defaultPermissionMode
    const summary = await window.cogent.engineRequest('session.create', {
      ...params,
      permissionMode
    })
    set((state) => ({
      sessions: [{ ...summary }, ...state.sessions],
      activeSessionId: summary.id,
      messagesBySession: { ...state.messagesBySession, [summary.id]: [] }
    }))
    return summary.id
  },

  /** 会话级权限切换（「完全访问」按钮）：引擎 beforeToolCall 每次判定读活值，
      运行中切换即生效；摘要同步回列表（按钮态与信息呈现的数据源） */
  setPermission: async (sessionId, mode) => {
    const { summary } = await window.cogent.engineRequest('session.setPermission', { sessionId, mode })
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? summary : s))
    }))
  },

  /** 置顶/取消（引擎侧落 pinnedAt 并持久化）；同步更新列表内该会话的摘要 */
  setPinned: async (sessionId, pinned) => {
    const { summary } = await window.cogent.engineRequest('session.setPinned', { sessionId, pinned })
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? summary : s))
    }))
  },

  /** 归档/恢复（回收站语义）：引擎 session.list 已滤掉归档会话，本地把摘要移出
      列表（恢复动作在设置页归档视图，archive(chatId,false) 后经 load 语义回到
      主列表——这里恢复时不强拉列表，由调用方刷新）。归档**活动**会话时视图才落
      kind:'new'（须比对 chatId：侧栏可归档任意后台会话，无条件踢视图会把
      正打开的对话误拉到新聊天着陆页） */
  archive: async (sessionId, archived) => {
    await window.cogent.engineRequest('session.archive', { sessionId, archived })
    set((state) => ({
      sessions: archived ? state.sessions.filter((s) => s.id !== sessionId) : state.sessions,
      activeSessionId:
        archived && state.activeSessionId === sessionId ? null : state.activeSessionId
    }))
    const home = useHomeStore.getState().session
    if (archived && home.kind === 'chat' && home.chatId === sessionId) {
      useHomeStore.setState({ session: { kind: 'new' } })
    }
  },

  deleteSession: async (sessionId) => {
    await window.cogent.engineRequest('session.delete', { sessionId })
    const wasActive = get().activeSessionId === sessionId
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId)
      const messagesBySession = { ...state.messagesBySession }
      delete messagesBySession[sessionId]
      const pendingApprovalsBySession = { ...state.pendingApprovalsBySession }
      delete pendingApprovalsBySession[sessionId]
      const runningBySession = { ...state.runningBySession }
      delete runningBySession[sessionId]
      const stoppingBySession = { ...state.stoppingBySession }
      delete stoppingBySession[sessionId]
      const lastErrorBySession = { ...state.lastErrorBySession }
      delete lastErrorBySession[sessionId]
      const truncatedBySession = { ...state.truncatedBySession }
      delete truncatedBySession[sessionId]
      const compactingBySession = { ...state.compactingBySession }
      delete compactingBySession[sessionId]
      const prunedBySession = { ...state.prunedBySession }
      delete prunedBySession[sessionId]
      return {
        sessions,
        messagesBySession,
        pendingApprovalsBySession,
        runningBySession,
        stoppingBySession,
        lastErrorBySession,
        truncatedBySession,
        compactingBySession,
        prunedBySession,
        // 删除活动会话与归档同款落点：视图落"新聊天"（不再自动跳 sessions[0] ——
        // 旧行为不触发 selectSession，目标会话消息未拉取会白屏）
        activeSessionId: wasActive ? null : state.activeSessionId
      }
    })
    const home = useHomeStore.getState().session
    if (wasActive && home.kind === 'chat' && home.chatId === sessionId) {
      useHomeStore.setState({ session: { kind: 'new' } })
    }
  },

  submit: async (text, model, thinkingLevel, provider) => {
    // 无活动会话时按需物化：空列表着陆页（首装/全部归档后重启）直接发送。
    // 此前 activeSessionId 为 null 静默 return = 丢消息。projectId 取新聊天
    // 视图态 —— 会话与项目的绑定只在 session.create 时可定（同 ProjectPicker
    // 的串归属边界），chat 视图态不会有"活动会话为空"（archive/delete 已换落）
    const home = useHomeStore.getState().session
    const sessionId =
      get().activeSessionId ??
      (await get().createSession(
        home.kind === 'new' && home.projectId !== undefined ? { projectId: home.projectId } : undefined
      ))
    // 乐观上屏用户消息；assistant 回复由引擎事件流驱动
    const userMessage: ChatMessage = {
      id: `u-${crypto.randomUUID()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    }
    set((state) => ({
      runningBySession: { ...state.runningBySession, [sessionId]: true },
      // 上一回合若停在「已停止」，新 run 开启即回落正常（停止位随 run 消费）
      stoppingBySession: { ...state.stoppingBySession, [sessionId]: false },
      lastErrorBySession: { ...state.lastErrorBySession, [sessionId]: undefined },
      truncatedBySession: { ...state.truncatedBySession, [sessionId]: undefined },
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: [...(state.messagesBySession[sessionId] ?? []), userMessage]
      }
    }))
    // provider 随 model 下发：同名模型被多家目录收录（azure 也收录 deepseek-v4-pro），
    // 只传 id 引擎全局查找有歧义（详见 protocol AgentSubmitParams.provider 注释）
    try {
      await window.cogent.engineRequest('agent.submit', { sessionId, text, model, thinkingLevel, provider })
    } catch (error) {
      // renderer→引擎边界（合法设防位）：引擎进程退出/未就绪时 main 拒绝在途请求，
      // 事件流的终态（run.failed）不会来 —— 必须自己收尾运行态，否则输入框永久
      // 锁死。乐观上屏的用户消息一并撤回（没提交成功，留着会在重发时出现双条），
      // 错误落该会话的错误条；rethrow 让调用方（send）回填输入框文本
      useChatStore.setState((state) => ({
        runningBySession: { ...state.runningBySession, [sessionId]: false },
        lastErrorBySession: {
          ...state.lastErrorBySession,
          [sessionId]: unwrapIpcError(error)
        },
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: (state.messagesBySession[sessionId] ?? []).slice(0, -1)
        }
      }))
      throw error
    }
  },

  abort: async () => {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    // 先置停止位再发 abort：run.failed 事件回来看这位区分「已停止」（半截正文
    // 封存保留、清错误条）与「出错了」（真失败，错误条照旧）—— D6
    set((state) => ({ stoppingBySession: { ...state.stoppingBySession, [sessionId]: true } }))
    await window.cogent.engineRequest('agent.abort', { sessionId })
  },

  continueGeneration: async () => {
    const sessionId = get().activeSessionId
    if (sessionId === null) return
    // 乐观置运行态（事件流的 run.started 随后到，双保险）；无用户泡 —— 续写
    // 指令由引擎注入并在投影层并入相邻段，这里不往列表里塞任何东西
    set((state) => ({
      runningBySession: { ...state.runningBySession, [sessionId]: true },
      truncatedBySession: { ...state.truncatedBySession, [sessionId]: undefined }
    }))
    try {
      await window.cogent.engineRequest('session.continue', { sessionId })
    } catch (error) {
      // 引擎侧拒绝（忙/末条非截断）或边界失败：回落运行态，错误落会话错误条
      useChatStore.setState((state) => ({
        runningBySession: { ...state.runningBySession, [sessionId]: false },
        lastErrorBySession: {
          ...state.lastErrorBySession,
          [sessionId]: unwrapIpcError(error)
        }
      }))
    }
  },

  compactNow: async () => {
    const sessionId = get().activeSessionId
    if (sessionId === null) return
    try {
      await window.cogent.engineRequest('session.compact', { sessionId })
      // 成功的折叠条/回落走既有 compaction 事件路径（completed 做列表手术）
    } catch (error) {
      // 无可压缩/引擎拒绝：手动动作要明确结果 —— 落会话错误条
      useChatStore.setState((state) => ({
        lastErrorBySession: {
          ...state.lastErrorBySession,
          [sessionId]: unwrapIpcError(error)
        }
      }))
    }
  },

  respondApproval: async (requestId, approved, options) => {
    // 乐观收面板 + 落痕迹行：requestId 全局唯一但不知落在哪个会话（多窗口广播
    // 下非活动窗口也可能裁决），全表线性扫 —— 审批是人手点击级低频路径。
    // 痕迹行插到对应工具卡**之前**（时序：先裁决、后执行 —— 卡虽因
    // tool_execution_start 先行而早就在列表里，但叙述上「已允许 → 完成」才不
    // 颠倒因果；与 run.completed 终态重锚同方向）；配不上（理论缺卡）退末尾
    useChatStore.setState((state) => {
      const pendingApprovalsBySession = { ...state.pendingApprovalsBySession }
      const messagesBySession = { ...state.messagesBySession }
      let sessionId: string | undefined
      let settled: PendingApproval | undefined
      for (const [sid, list] of Object.entries(pendingApprovalsBySession)) {
        const hit = list?.find((p) => p.requestId === requestId)
        if (hit !== undefined) {
          sessionId = sid
          settled = hit
          pendingApprovalsBySession[sid] = list!.filter((p) => p.requestId !== requestId)
          break
        }
      }
      if (sessionId !== undefined && settled !== undefined) {
        // status 用带注解中间变量锚定字面量联合（同 tool.completed 手法）：
        // spread 字面量不参与上下文类型，直接内联会被展宽成 string
        const status: ApprovalItem['status'] = approved ? 'approved' : 'denied'
        const trace: ApprovalItem = { ...settled, id: requestId, type: 'approval', status }
        const list = [...(messagesBySession[sessionId] ?? [])]
        // 挂起中的审批：目标卡必为 running（beforeToolCall 阻塞执行，完成事件
        // 在 resolve 之后才可能到）；按 名+摘要 配对（与工具卡同源 TOOL_METAS.summarize）
        const at = list.findIndex(
          (m) =>
            m.type === 'tool' && m.status === 'running' && m.name === settled.toolName && m.summary === settled.summary
        )
        list.splice(at >= 0 ? at : list.length, 0, trace)
        messagesBySession[sessionId] = list
      }
      return { pendingApprovalsBySession, messagesBySession }
    })
    // renderer→引擎边界（合法设防位）：引擎拒识 requestId（中止竞态收口在前 /
    // 重复点击）时抛 InvalidParams —— 痕迹行不回滚，终局以 run 终态事件为准
    await window.cogent.respondApproval(requestId, approved, options).catch(() => {})
  }
}))

/**
 * 引擎事件订阅：App 挂载时接一次，把事件流转译为 store 更新。
 * 放在 store 文件里保持"事件 → 状态"的转译集中一处，组件只读状态。
 * 帧形状 = env.d.ts 的 EngineEvent 判别联合：switch(method) 自然窄化 params，
 * 不做 as + typeof 抽查 —— 那会把联合拆成 untyped record，类型系统从此拦不住
 * 取错字段（当初形状 bug 的成因，见约定.md §1.2-7）。
 */
export function bindEngineEvents(): () => void {
  return window.cogent.onEngineEvent((event) => {
    switch (event.method) {
      case 'message.delta': {
        const { sessionId, delta, kind } = event.params
        const isThinking = kind === 'thinking'
        // 函数式更新：delta 是逐 token 高频路径，不依赖"回调间无并发更新"的
        // 隐式前提（开头快照 + 非函数式 set 在事件合帧时会读到 stale state）
        useChatStore.setState((state) => {
          const messages = state.messagesBySession[sessionId] ?? []
          // 流式累积进最后一条 assistant 消息；首条 delta 时占位消息尚不存在，先建。
          // kind 分流：thinking 进思考缓冲、text 进正文（同一条消息的两路，引擎保证同 messageId）
          const last = messages.at(-1)
          // 判别先过 type（联合窄化），再校验占位身份 —— 工具卡行（type 'tool'）
          // 后到的 delta 要另起占位（封段接力见 tool.started 分支）
          const next =
            last !== undefined && last.type === undefined && last.role === 'assistant' && last.id === 'streaming'
              ? [
                  ...messages.slice(0, -1),
                  isThinking
                    ? { ...last, thinking: (last.thinking ?? '') + delta }
                    : { ...last, content: last.content + delta }
                ]
              : [
                  ...messages,
                  {
                    id: 'streaming',
                    role: 'assistant' as const,
                    content: isThinking ? '' : delta,
                    thinking: isThinking ? delta : undefined,
                    timestamp: Date.now()
                  }
                ]
          return { messagesBySession: { ...state.messagesBySession, [sessionId]: next } }
        })
        return
      }
      case 'tool.started': {
        const { sessionId, callId, name, kind, summary } = event.params
        useChatStore.setState((state) => {
          const messages = state.messagesBySession[sessionId] ?? []
          // 封段接力：模型先出文字再调工具时，占位（id 'streaming'）改名为 live-*
          // 定格在本位 —— 后续轮次的 delta 会另起占位，文字与工具卡交错不失真
          const last = messages.at(-1)
          const sealed =
            last !== undefined && last.type === undefined && last.id === 'streaming' && last.role === 'assistant'
              ? [...messages.slice(0, -1), { ...last, id: `live-${crypto.randomUUID()}` }]
              : messages
          const item: ToolItem = {
            id: callId,
            type: 'tool',
            name,
            toolKind: kind,
            summary: summary ?? `${name}()`,
            status: 'running'
          }
          return {
            messagesBySession: { ...state.messagesBySession, [sessionId]: [...sealed, item] }
          }
        })
        return
      }
      case 'tool.completed': {
        const { sessionId, callId, isError, summary, diff } = event.params
        useChatStore.setState((state) => {
          const messages = state.messagesBySession[sessionId]
          if (messages === undefined) return state
          // 带注解的中间变量锚定字面量联合：spread 字面量的属性会被 TS 展宽成
          // string（带 spread 的对象字面量不参与上下文类型），断言写法又会被
          // no-unnecessary-type-assertion 拦 —— 变量注解是两边都干净的形式
          const nextStatus: ToolItem['status'] = isError ? 'error' : 'ok'
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: messages.map((m): MessageItem =>
                m.type === 'tool' && m.id === callId
                  ? { ...m, status: nextStatus, resultSummary: summary, diff, progress: undefined }
                  : m
              )
            }
          }
        })
        return
      }
      case 'tool.progress': {
        // bash 等长时工具的流式尾部快照（整段替换非增量）：只更新 running 项
        const { sessionId, callId, text } = event.params
        useChatStore.setState((state) => {
          const messages = state.messagesBySession[sessionId]
          if (messages === undefined) return state
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: messages.map((m): MessageItem =>
                m.type === 'tool' && m.id === callId && m.status === 'running'
                  ? { ...m, progress: text }
                  : m
              )
            }
          }
        })
        return
      }
      case 'approval.request': {
        const { sessionId, requestId, toolName, kind, summary } = event.params
        useChatStore.setState((state) => {
          // D1：pending 不进消息流 —— 会话级状态，确认面板（ApprovalPanel）
          // 是唯一呈现位；数组追加（并行写工具会并发多个请求）
          const list = state.pendingApprovalsBySession[sessionId] ?? []
          return {
            pendingApprovalsBySession: {
              ...state.pendingApprovalsBySession,
              [sessionId]: [...list, { requestId, toolName, toolKind: kind, summary }]
            }
          }
        })
        return
      }
      case 'compaction.started': {
        // 压缩进行中（完备化 D8）：置状态条判别位，completed 分支清零。自动路
        // 发生在 run 事件间隙（submit 前 / 工具轮间），状态条与流式占位并存
        const { sessionId } = event.params
        useChatStore.setState((state) => ({
          compactingBySession: { ...state.compactingBySession, [sessionId]: true }
        }))
        return
      }
      case 'compaction.pruned': {
        // L1 裁剪落账（完备化 R3/D8，D9 起独立呈现）：副行**立即追加**到列表
        // 尾（当前流内的过程行）—— L1 单独够（无后续 completed）时它就是本次
        // 裁剪的全部呈现；同一检查点若跟进 L2（completed），completed 手术会
        // 撤下独立行、随折叠条配对重插，不双份。entries 同时记 prunedBySession
        // 供 completed 配对（取后即清）
        const { sessionId, entries } = event.params
        if (entries.length === 0) return
        const timestamp = Date.now()
        useChatStore.setState((state) => ({
          prunedBySession: { ...state.prunedBySession, [sessionId]: entries },
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: [
              ...(state.messagesBySession[sessionId] ?? []),
              { id: `compaction-pruned-${timestamp}`, type: 'pruned', entries, timestamp }
            ]
          }
        }))
        return
      }
      case 'compaction.completed': {
        // 压缩完成：在压缩发生位置（被摘要区末条之后）**原位插入**折叠条，
        // 旧消息不删（D9 保留式呈现，Codex 形态 —— 历史不因压缩消失，标记
        // 行停在自己发生的地方）。引擎转录同形（影子区保留 + 标记条原位），
        // 历史回查投影天然一致；事件载荷已含折叠条全部数据（summary/前后
        // token/锚点/摘要用量），手术零往返，无"重拉历史"竞态
        const { sessionId, error, tokensBefore, tokensAfter, summary, summarizedUntil, summaryUsage } = event.params
        // 无论成败清「压缩中」位（失败也结束窗口）
        useChatStore.setState((state) => ({
          compactingBySession: { ...state.compactingBySession, [sessionId]: undefined }
        }))
        if (error !== undefined || summarizedUntil === undefined) return // 失败路：自动已降级继续、手动走方法错误帧
        useChatStore.setState((state) => {
          const local = state.messagesBySession[sessionId]
          if (local === undefined) return state
          const timestamp = Date.now()
          const pruned = state.prunedBySession[sessionId]
          const prunedBySession = { ...state.prunedBySession }
          delete prunedBySession[sessionId]
          let cleaned = local
          // 撤下同检查点的独立副行（pruned 事件先行追加、恒为列表**末条**
          // pruned）：entries 深比较命中才撤 —— 早前 L1-alone 检查点的独立
          // 行是历史痕迹，保留；配对行随 bar 插入，不双份
          if (pruned !== undefined && pruned.length > 0) {
            for (let i = local.length - 1; i >= 0; i--) {
              // 先落局部再判别（元素访问不参与窄化，同 run.completed 的 lastUser 扫描）
              const item = local[i]
              if (item.type !== 'pruned') continue
              if (JSON.stringify(item.entries) === JSON.stringify(pruned)) {
                cleaned = local.filter((_, j) => j !== i)
              }
              break // 只看末条 pruned
            }
          }
          // D9 呈现位 = 时间序：插在「压缩时刻之前已存在的最后一条内容」之后
          // —— 即「正在压缩上下文…」状态条当时所在的位置（Codex 形态：标记
          // 行嵌在压缩打断流的地方），而非引擎转录的切点（切点是影子区/活区
          // 语义边界，落在那里 = 标记行跑到保留区 20K 之前的旧消息堆里，验收
          // 实测"留痕跳到上面去了"）。时间取法：内容消息 timestamp、工具卡
          // 打点、审批痕迹行无时间戳采用右邻（与卡同进退）
          let upcomingTime: number | undefined
          let insertAt = -1
          for (let i = cleaned.length - 1; i >= 0; i--) {
            const item = cleaned[i]
            let t: number | undefined
            if (item.type === 'tool') t = item.endedAt ?? item.startedAt
            else if (item.type === 'approval') t = upcomingTime
            else t = item.timestamp
            if (t !== undefined) upcomingTime = t
            if (t !== undefined && t <= timestamp) {
              insertAt = i
              break
            }
          }
          const bar: ChatMessage = {
            // 唯一 id：保留式下多次压缩多条折叠条并存（历史回查投影用 c-N
            // 位置 id，两路径不撞）
            id: `compaction-bar-${timestamp}`,
            role: 'compaction',
            content: summary ?? '',
            compaction: { tokensBefore: tokensBefore ?? 0, tokensAfter, summaryUsage },
            timestamp
          }
          // L1 prune 副行（完备化 R3/D8）：随折叠条同区配对呈现「已裁剪 N 处
          // 工具输出」，取后即清（下次裁剪再来）
          const head: MessageItem[] = [bar]
          if (pruned !== undefined && pruned.length > 0) {
            head.push({
              id: `compaction-pruned-${timestamp}`,
              type: 'pruned',
              entries: pruned,
              timestamp
            })
          }
          const at = insertAt + 1
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: [...cleaned.slice(0, at), ...head, ...cleaned.slice(at)]
            },
            prunedBySession
          }
        })
        return
      }
      case 'run.completed': {
        const { sessionId, message, messages, stopReason } = event.params
        useChatStore.setState((state) => {
          const list = state.messagesBySession[sessionId]
          if (list === undefined) return state
          // 终态整段替换：定位本次 run 的边界（列表里最后一条用户消息），
          // 其后的流式占位/封段/工具卡全部换成引擎分段终态（messages 优先，
          // 老引擎无 messages 时退回聚合 message 单段 —— 同一展平路径）
          const segments = messages ?? (message !== undefined ? [message] : [])
          let lastUser = -1
          for (let i = list.length - 1; i >= 0; i--) {
            // 先落局部再判别：元素访问（list[i]）不参与窄化，点号链才行
            const item = list[i]
            if (item.type === undefined && item.role === 'user') {
              lastUser = i
              break
            }
          }
          // 审批痕迹行是用户裁决痕迹（转录里无对应物）：终态替换保留，但**锚回
          // 各自工具卡之前**（详见 flatWithApprovals 注释 —— 逻辑已提出为模块级
          // 导出函数，行为不变）
          const keptApprovals: ApprovalItem[] =
            lastUser >= 0 ? list.slice(lastUser + 1).filter((m): m is ApprovalItem => m.type === 'approval') : []
          // 压缩条/裁剪副行不是 run 的产物（D9：压缩发生在 run 边界/轮间，
          // completed/pruned 事件插进替换区）：终态替换不得吞掉 —— 按时间序
          // 并回替换区（详见 flatWithCompaction 注释）。审批锚回在其后组合，
          // 卡匹配不受影响
          const keptCompaction = (
            lastUser >= 0
              ? list
                  .slice(lastUser + 1)
                  .filter((m) => m.type === 'pruned' || (m.type === undefined && m.role === 'compaction'))
              : []
          ) as Array<ChatMessage | PrunedItem> // 谓词保证形状，联合收窄用断言（filter 不做类型谓词）
          const finalMessages =
            lastUser >= 0
              ? [
                  ...list.slice(0, lastUser + 1),
                  ...flatWithApprovals(flatWithCompaction(flattenSegments(segments), keptCompaction), keptApprovals)
                ]
              : list
          // 面板兜底清空（常态路径裁决时已收；防御 run 终态与裁决竞态的残留）
          const { [sessionId]: _cleared, ...pendingRest } = state.pendingApprovalsBySession
          return {
            runningBySession: { ...state.runningBySession, [sessionId]: false },
            // abort raced 完成（完成先到）：停止位一并消费
            stoppingBySession: { ...state.stoppingBySession, [sessionId]: false },
            truncatedBySession: { ...state.truncatedBySession, [sessionId]: stopReason === 'length' },
            messagesBySession: { ...state.messagesBySession, [sessionId]: finalMessages },
            pendingApprovalsBySession: pendingRest,
            // 首条消息后标题已在引擎侧生成；updatedAt 顺带推进（排序口径）
            sessions: state.sessions.map((session) =>
              session.id === sessionId ? { ...session, updatedAt: Date.now() } : session
            )
          }
        })
        void refreshSessionTitle()
        return
      }
      case 'run.failed': {
        const { sessionId, message } = event.params
        useChatStore.setState((state) => {
          // 停止位前置判别（D6）：用户点的停止 → 「已停止」不是错误（半截正文
          // 封存保留、错误条清掉，回合头条表达状态）；真失败 → 错误条照旧
          const wasStopped = state.stoppingBySession[sessionId] === true
          const base = {
            runningBySession: { ...state.runningBySession, [sessionId]: false },
            stoppingBySession: { ...state.stoppingBySession, [sessionId]: false },
            truncatedBySession: { ...state.truncatedBySession, [sessionId]: false },
            lastErrorBySession: wasStopped
              ? { ...state.lastErrorBySession, [sessionId]: undefined }
              : { ...state.lastErrorBySession, [sessionId]: message }
          }
          const list = state.messagesBySession[sessionId]
          if (list === undefined) return base
          return {
            ...base,
            messagesBySession: {
              ...state.messagesBySession,
              // 失败收尾：中止 = 半截占位改名封存（同 tool.started 的封段接力，
              // 已出文本留在消息流）；真失败 = 占位移除（既有口径）。
              // 挂在 run 里的工具卡若还 running（打断在工具处）标 blocked；挂起中
              // 的审批（会话级面板态）收面板 + 落 cancelled 痕迹行（引擎侧
              // signal 已 resolve block）—— 不留永久等待面板/痕迹缺口
              [sessionId]: [
                ...list
                  .map((m) =>
                    m.type === undefined && m.id === 'streaming' && wasStopped
                      ? { ...m, id: `live-${crypto.randomUUID()}` }
                      : m
                  )
                  .filter((m) => m.id !== 'streaming')
                  .map((m) =>
                    m.type === 'tool' && m.status === 'running'
                      ? { ...m, status: 'blocked' as const }
                      : m
                  ),
                ...(state.pendingApprovalsBySession[sessionId] ?? []).map(
                  (p): ApprovalItem => ({ ...p, id: p.requestId, type: 'approval', status: 'cancelled' })
                )
              ]
            },
            pendingApprovalsBySession: { ...state.pendingApprovalsBySession, [sessionId]: [] }
          }
        })
        return
      }
      default:
        return
    }
  })
}

/** run.completed 后回查一次会话列表，让"首条消息生成标题"反映到侧栏 */
async function refreshSessionTitle(): Promise<void> {
  const sessions = await window.cogent.engineRequest('session.list', {})
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      const fresh = sessions.find((s) => s.id === session.id)
      return fresh ? { ...session, title: fresh.title, updatedAt: fresh.updatedAt } : session
    })
  }))
}
