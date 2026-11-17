/**
 * 聊天数据状态：会话列表、会话桶（消息/清单/运行位/挂起面板态）、动作面。
 * 数据源头是引擎事件流（onEngineEvent，翻译层在 events.ts），store 是事件
 * 与 UI 之间的缓冲；初载（load）拉会话列表，选中会话时按需拉历史消息建桶。
 *
 * 运行态分域（2026-11-10，架构审查修复）：running/lastError/truncated/stopping
 * 一律按 sessionId 分桶（同 console store 的分域手法）。此前是全局单例：
 * 会话 A 流式中切到 B 发消息，A 完成会把全局 running 置 false → B 的停止钮
 * 错变发送；反向则 B 的输入框被 A 的 running 锁死；错误/截断文案也会串会话。
 * 组件侧用 selectRunning / selectStopping / selectLastError / selectTruncated
 * （selectors.ts）取活动会话的视图。stopping = 用户点了停止的前置位
 * （回合头条「已停止」与「出错了」的判别依据，见 docs/计划/回合过程折叠.md D6）。
 *
 * 桶化（2026-11-17 会话状态重构 P1，docs/计划/会话状态重构.md）：此前 12 个
 * XxxBySession 平行 map，deleteSession 手抄逐项清除、编译器不兜底；现并为
 * 单一 bySession 桶 —— 删会话 = 删一键。对照 zcode 的 workspace 分桶
 * （zcodeSessionStoreTypes.ts:237）；zcode 自认"桶无删除路径"（内存诊断
 * 记账），本处以单键删除从结构上杜绝。
 */
import { create } from 'zustand'
import type { ChatMessage, PermissionMode } from '@/env.d'
import { useHomeStore } from '@/stores/home'
import { useEngineStore } from '@/stores/engine'
import { useProjectStore } from '@/stores/project'
import { unwrapIpcError } from '@/lib/ipc'
import { flattenSegments } from './flatten'
import type { ApprovalItem, ChatState, PendingApproval, SessionBucket } from './types'

/**
 * 项目级默认权限模式（F6「允许，并切换为」落位）：projectId 直配，否则 cwd
 * 前缀落进某项目 cwds（与引擎 projectByIdOrCwd 同口径）。路径归一 = 小写 +
 * 斜杠统一（renderer 无 node:path；比对语义与引擎 resolve+sep 等价 —— 都只
 * 防 `work` 误配 `work-x`）。未设置/无归属返回 undefined（链上回落全局默认）
 */
export function projectDefaultMode(projectId?: string, cwd?: string): PermissionMode | undefined {
  const projects = useProjectStore.getState().projects
  if (projects.length === 0) return undefined
  const hit =
    projectId !== undefined
      ? projects.find((p) => p.id === projectId)
      : cwd === undefined
        ? undefined
        : projects.find((p) => {
            const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
            return p.cwds.some((root) => {
              const r = root.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
              return normalized === r || normalized.startsWith(`${r}/`)
            })
          })
  return hit?.defaultPermissionMode
}

/**
 * 会话桶工厂（对照 zcode createDefaultWorkspaceState）：字段恒全，读写免判
 * 缺省；事件到达未建桶的会话（后台会话广播等）经 `?? emptyBucket()` 落键。
 */
export function emptyBucket(): SessionBucket {
  return {
    messages: [],
    todos: [],
    runtime: {
      running: false,
      stopping: false,
      compacting: false,
      truncated: false,
      lastError: null,
      pruned: null,
      contextLive: null
    },
    pendingApprovals: [],
    pendingQuestions: [],
    pendingPlans: []
  }
}

/** 桶内局部更新（读侧兜底建桶）的公共形状：返回整张 bySession 新表。
    store 动作与事件层（events.ts）共用的唯一写入姿势 */
export function patchBucket(
  state: ChatState,
  sessionId: string,
  patch: (bucket: SessionBucket) => SessionBucket
): Pick<ChatState, 'bySession'> {
  const bucket = state.bySession[sessionId] ?? emptyBucket()
  return { bySession: { ...state.bySession, [sessionId]: patch(bucket) } }
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  bySession: {},
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
    // 按需拉历史建桶（盘上转录已持久化，切换时重拉一次拿最新；本地缓存优化属后续件）。
    // 展平：段化消息里的 toolCalls → 独立工具卡行（与流式期事件路径同一形状）；
    // todos 字段 = TodoStrip 种子（运行中增量走 todos.updated 事件）
    if (get().bySession[sessionId] === undefined) {
      const { messages, todos } = await window.cogent.engineRequest('session.messages', { sessionId })
      set((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: { ...emptyBucket(), messages: flattenSegments(messages), ...(todos !== undefined && { todos }) }
        }
      }))
    }
  },

  createSession: async (params) => {
    // 权限模式随物化落定（审批交互升级第 3 步 + F6 项目默认）：显式 params >
    // 新聊天暂存位 > **项目默认**（「允许，并切换为」落位，zcode 同款：同一
    // 项目的新会话沿用）> 设置页「默认权限」（engine store；ask 缺省语义与
    // 协议/引擎一致）。项目匹配与引擎 projectIdOf 同口径：projectId 直配，
    // 否则 cwd 前缀落进某项目 cwds
    const home = useHomeStore.getState().session
    // 链尾 engine store 字段非 optional，链必有值 → 直接落（等值覆盖 params 的
    // 同名字段，语义 = 显式选择优先已由 ?? 链前段保证）
    const permissionMode =
      params?.permissionMode ??
      (home.kind === 'new' ? home.permissionMode : undefined) ??
      projectDefaultMode(params?.projectId, params?.cwd) ??
      useEngineStore.getState().defaultPermissionMode
    const summary = await window.cogent.engineRequest('session.create', {
      ...params,
      permissionMode,
      // new 态计划开关暂存位（PlanToggle/菜单开关项写入 home store）随物化带上
      planEnabled: params?.planEnabled ?? (home.kind === 'new' ? home.planEnabled : undefined)
    })
    set((state) => ({
      sessions: [{ ...summary }, ...state.sessions],
      activeSessionId: summary.id,
      bySession: { ...state.bySession, [summary.id]: emptyBucket() }
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
      const bySession = { ...state.bySession }
      // 单键删除：消息/清单/运行位/三类挂起面板态全随桶走 —— 桶化的目的
      // （此前 12 个平行 map 逐项手抄清除，编译器不兜底，漏一项即泄漏）
      delete bySession[sessionId]
      return {
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        bySession,
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
    // 会话物化条件：**新聊天视图态优先于 activeSessionId**。
    // startNewChat 只翻视图态不清 activeSessionId —— 只看 id 会把"新聊天"里的
    // 首条消息落进残留的旧会话（权限暂存位随之被绕过：新聊天切自主，发消息后
    // 菜单跳回旧会话的 ask）。kind:'new' 强制物化（createSession 消费视图态的
    // projectId 与 permissionMode）；chat 态下 activeSessionId 为 null（空列表
    // 着陆页直发，此前是静默 return 丢消息）才兜底建。
    const home = useHomeStore.getState().session
    const sessionId =
      home.kind === 'new'
        ? await get().createSession(home.projectId !== undefined ? { projectId: home.projectId } : undefined)
        : (get().activeSessionId ?? (await get().createSession(undefined)))
    // 乐观上屏用户消息；assistant 回复由引擎事件流驱动
    const userMessage: ChatMessage = {
      id: `u-${crypto.randomUUID()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    }
    set((state) =>
      patchBucket(state, sessionId, (bucket) => ({
        ...bucket,
        messages: [...bucket.messages, userMessage],
        runtime: {
          ...bucket.runtime,
          running: true,
          // 上一回合若停在「已停止」，新 run 开启即回落正常（停止位随 run 消费）
          stopping: false,
          lastError: null,
          truncated: false
        }
      }))
    )
    // provider 随 model 下发：同名模型被多家目录收录（azure 也收录 deepseek-v4-pro），
    // 只传 id 引擎全局查找有歧义（详见 protocol AgentSubmitParams.provider 注释）
    try {
      await window.cogent.engineRequest('agent.submit', { sessionId, text, model, thinkingLevel, provider })
    } catch (error) {
      // renderer→引擎边界（合法设防位）：引擎进程退出/未就绪时 main 拒绝在途请求，
      // 事件流的终态（run.failed）不会来 —— 必须自己收尾运行态，否则输入框永久
      // 锁死。乐观上屏的用户消息一并撤回（没提交成功，留着会在重发时出现双条），
      // 错误落该会话的错误条；rethrow 让调用方（send）回填输入框文本
      useChatStore.setState((state) =>
        patchBucket(state, sessionId, (bucket) => ({
          ...bucket,
          messages: bucket.messages.slice(0, -1),
          runtime: { ...bucket.runtime, running: false, lastError: unwrapIpcError(error) }
        }))
      )
      throw error
    }
  },

  abort: async () => {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    // 先置停止位再发 abort：run.failed 事件回来看这位区分「已停止」（半截正文
    // 封存保留、清错误条）与「出错了」（真失败，错误条照旧）—— D6
    set((state) =>
      patchBucket(state, sessionId, (bucket) => ({
        ...bucket,
        runtime: { ...bucket.runtime, stopping: true }
      }))
    )
    await window.cogent.engineRequest('agent.abort', { sessionId })
  },

  continueGeneration: async () => {
    const sessionId = get().activeSessionId
    if (sessionId === null) return
    // 乐观置运行态（事件流的 run.started 随后到，双保险）；无用户泡 —— 续写
    // 指令由引擎注入并在投影层并入相邻段，这里不往列表里塞任何东西
    set((state) =>
      patchBucket(state, sessionId, (bucket) => ({
        ...bucket,
        runtime: { ...bucket.runtime, running: true, truncated: false }
      }))
    )
    try {
      await window.cogent.engineRequest('session.continue', { sessionId })
    } catch (error) {
      // 引擎侧拒绝（忙/末条非截断）或边界失败：回落运行态，错误落会话错误条
      useChatStore.setState((state) =>
        patchBucket(state, sessionId, (bucket) => ({
          ...bucket,
          runtime: { ...bucket.runtime, running: false, lastError: unwrapIpcError(error) }
        }))
      )
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
      useChatStore.setState((state) =>
        patchBucket(state, sessionId, (bucket) => ({
          ...bucket,
          runtime: { ...bucket.runtime, lastError: unwrapIpcError(error) }
        }))
      )
    }
  },

  respondApproval: async (requestId, approved, options) => {
    // 乐观收面板 + 落痕迹行：requestId 全局唯一但不知落在哪个会话（多窗口广播
    // 下非活动窗口也可能裁决），全表线性扫 —— 审批是人手点击级低频路径。
    // 痕迹行插到对应工具卡**之前**（时序：先裁决、后执行 —— 卡虽因
    // tool_execution_start 先行而早就在列表里，但叙述上「已允许 → 完成」才不
    // 颠倒因果；与 run.completed 终态重锚同方向）；配不上（理论缺卡）退末尾
    useChatStore.setState((state) => {
      const bySession = { ...state.bySession }
      let settled: PendingApproval | undefined
      let sessionId: string | undefined
      // 目标桶随扫描捕获（Partial 索引读回是 T | undefined，循环里刚写入的事
      // 实 TS 关联不上 —— 持引用比回查再判省一次设防）
      let target: SessionBucket | undefined
      // Object.entries 对 Partial 的值类型掺 undefined（键在场值必在，TS 的已知盲区），
      // 断言收窄（同 flatten.replaceRunTerminal 的 keptCompaction 手法）；
      // respondQuestion/respondPlan 同款扫描共用此形状
      for (const [sid, bucket] of Object.entries(bySession) as Array<[string, SessionBucket]>) {
        const hit = bucket.pendingApprovals.find((p) => p.requestId === requestId)
        if (hit !== undefined) {
          sessionId = sid
          settled = hit
          target = { ...bucket, pendingApprovals: bucket.pendingApprovals.filter((p) => p.requestId !== requestId) }
          bySession[sid] = target
          break
        }
      }
      if (sessionId !== undefined && settled !== undefined && target !== undefined) {
        // status 用带注解中间变量锚定字面量联合（同 tool.completed 手法）：
        // spread 字面量不参与上下文类型，直接内联会被展宽成 string
        const status: ApprovalItem['status'] = approved ? 'approved' : 'denied'
        const trace: ApprovalItem = { ...settled, id: requestId, type: 'approval', status }
        // 挂起中的审批：目标卡必为 running（beforeToolCall 阻塞执行，完成事件
        // 在 resolve 之后才可能到）；按 名+摘要 配对（与工具卡同源 TOOL_METAS.summarize）
        const list = [...target.messages]
        const at = list.findIndex(
          (m) =>
            m.type === 'tool' && m.status === 'running' && m.name === settled.toolName && m.summary === settled.summary
        )
        list.splice(at >= 0 ? at : list.length, 0, trace)
        bySession[sessionId] = { ...target, messages: list }
      }
      return { bySession }
    })
    // renderer→引擎边界（合法设防位）：引擎拒识 requestId（中止竞态收口在前 /
    // 重复点击）时抛 InvalidParams —— 痕迹行不回滚，终局以 run 终态事件为准。
    // switchMode 场景引擎带回切换后的会话摘要 → 同步列表里的模式标记
    const result = await window.cogent.respondApproval(requestId, approved, options).catch(() => undefined)
    if (result?.summary !== undefined) {
      const summary = result.summary
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) => (s.id === summary.id ? summary : s))
      }))
    }
  },

  /** 回答挂起中的 ask_user（交互座 4c-2）：先本地清挂起（乐观，engine 拒识
      requestId = 中止竞态在前，终局以 run 终态事件为准），再走专属通道 */
  respondQuestion: async (requestId, answers) => {
    useChatStore.setState((state) => {
      const bySession = { ...state.bySession }
      for (const [sid, bucket] of Object.entries(bySession) as Array<[string, SessionBucket]>) {
        if (bucket.pendingQuestions.some((p) => p.requestId === requestId)) {
          bySession[sid] = { ...bucket, pendingQuestions: bucket.pendingQuestions.filter((p) => p.requestId !== requestId) }
          break
        }
      }
      return { bySession }
    })
    await window.cogent.respondQuestion(requestId, answers).catch(() => undefined)
  },

  /** 计划模式开关（正交开关）：与 setPermission 同款 —— 引擎判定读活值，
      运行中切换即生效；摘要经 session.summaryChanged 广播回列表（RPC 返回值
      同步一份，双路幂等） */
  setPlanMode: async (sessionId, enabled) => {
    const { summary } = await window.cogent.engineRequest('session.setPlanMode', { sessionId, enabled })
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? summary : s))
    }))
  },

  /** 裁决挂起中的 submit_plan（交互座 4c-3）：先本地清挂起（同 respondQuestion
      乐观语义）；批准后引擎关计划开关并带回摘要 → 同步列表 */
  respondPlan: async (requestId, approved, options) => {
    useChatStore.setState((state) => {
      const bySession = { ...state.bySession }
      for (const [sid, bucket] of Object.entries(bySession) as Array<[string, SessionBucket]>) {
        if (bucket.pendingPlans.some((p) => p.requestId === requestId)) {
          bySession[sid] = { ...bucket, pendingPlans: bucket.pendingPlans.filter((p) => p.requestId !== requestId) }
          break
        }
      }
      return { bySession }
    })
    const result = await window.cogent
      .respondPlan(requestId, approved, options)
      .catch(() => undefined)
    if (result?.summary !== undefined) {
      const summary = result.summary
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) => (s.id === summary.id ? summary : s))
      }))
    }
  }
}))
