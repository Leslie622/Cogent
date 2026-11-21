/**
 * 聊天数据状态：会话列表、会话桶（消息/清单/运行位/挂起面板态）、动作面。
 * 数据源头是引擎事件流（onEngineEvent，翻译层在 events.ts），store 是事件
 * 与 UI 之间的缓冲；初载（load）拉会话列表，选中会话时按需拉历史消息建桶。
 *
 * 运行态分域（2026-11-10，架构审查修复）：running/lastError/truncated/stopping
 * 一律按 sessionId 分桶（同 console store 的分域手法）。此前是全局单例：
 * 会话 A 流式中切到 B 发消息，A 完成会把全局 running 置 false → B 的停止钮
 * 错变发送；反向则 B 的输入框被 A 的 running 锁死；错误/截断文案也会串会话。
 * 组件侧经 selectors.ts 取活动会话视图。stopping 只表示本窗停止请求窗口，
 * lastRunOutcome 独立保存引擎终态；操作错误不改回合结果。
 *
 * 桶化（2026-11-17 会话状态重构 P1，docs/模块/会话与对话.md）：此前 12 个
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
import { useAttachmentStore } from '@/stores/attachments'
import { unwrapIpcError } from '@/lib/ipc'
import { flattenSegments } from './flatten'
import { createDeltaBatcher } from './delta-batcher'
import type { ApprovalItem, ChatState, PendingApproval, RunOutcome, SessionBucket } from './types'

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
    owner: {},
    outputs: {},
    outputErrors: {},
    messages: [],
    turnOutcomes: {},
    todos: [],
    runtime: {
      running: false,
      stopping: false,
      stopRequestId: null,
      runRequestId: null,
      lastRunOutcome: null,
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

/** 终态属于最后user定义的显示回合；无输出同样记录，同user续写覆盖其最新结果。 */
export function recordTurnOutcome(bucket: SessionBucket, outcome: RunOutcome): SessionBucket['turnOutcomes'] {
  const user = bucket.messages.findLast((item) => item.type === undefined && item.role === 'user')
  if (user === undefined) return bucket.turnOutcomes
  return { ...bucket.turnOutcomes, [user.id]: outcome }
}

export const messageDeltas = createDeltaBatcher((sessionId, deltas) => {
  useChatStore.setState((state) => patchBucket(state, sessionId, (bucket) => {
    const messages = [...bucket.messages]
    for (const { delta, kind } of deltas) {
      const last = messages.at(-1)
      const thinking = kind === 'thinking'
      // 占位 id 一次分配终身不变（id 换名 = 渲染 key 变 = 正文行重挂）；
      // 「是不是活跃占位」由 placeholder 布尔表达，封段只翻布尔不改 id
      if (last !== undefined && last.type === undefined && last.role === 'assistant' && last.placeholder) {
        messages[messages.length - 1] = thinking
          ? { ...last, thinking: (last.thinking ?? '') + delta }
          : { ...last, content: last.content + delta }
      } else {
        messages.push({ id: crypto.randomUUID(), placeholder: true, role: 'assistant', content: thinking ? '' : delta,
          thinking: thinking ? delta : undefined, timestamp: Date.now() })
      }
    }
    return { ...bucket, messages }
  }))
})

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  bySession: {},
  loadError: null,

  // 初载不自动建会话：归档是回收站语义，"活跃列表空"有两种含义 —— 首装，或
  // 用户归档了全部会话（合法终态）。原"列表空就建一个"在后者每次重启都复活
  // 一个幽灵"新会话"（用户归档两个会话后重启"还在"的元凶；且 StrictMode 双
  // 挂载下 load 并发跑两遍会各建一个，盘上留下 13ms 双胞胎）。空列表统一落
  // "新聊天"着陆页，会话只在首条 submit 时物化，导航和项目选择不创建空会话。
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
        useHomeStore.getState().openChat(sessions[0].id)
      }
    } catch (error) {
      set({ loadError: error instanceof Error ? error.message : String(error) })
    }
  },

  selectSession: async (sessionId) => {
    messageDeltas.flushAll()
    set({ activeSessionId: sessionId })
    // 按需拉历史建桶（盘上转录已持久化，切换时重拉一次拿最新；本地缓存优化属后续件）。
    // 展平：段化消息里的 toolCalls → 独立工具卡行（与流式期事件路径同一形状）；
    // todos 字段 = TodoStrip 种子（运行中增量走 todos.updated 事件）
    if (get().bySession[sessionId] === undefined) {
      const { messages, todos } = await window.cogent.engineRequest('session.messages', { sessionId })
      messageDeltas.discard(sessionId)
      set((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: { ...emptyBucket(), messages: flattenSegments(messages), ...(todos !== undefined && { todos }) }
        }
      }))
      const bucket = get().bySession[sessionId]!
      // 产物历史独立水合，不能拖住调用方的openChat/草稿身份切换，造成标题先恢复、发送仍走新聊天。
      void (async () => { try {
        const outputs = await window.cogent.engineRequest('outputs.get', { sessionId })
        set((state) => {
          // 删除/重建会话后，旧历史查询不得复活旧桶；运行时事件比历史快照新时保留事件。
          const current = state.bySession[sessionId]
          if (current === undefined || current.owner !== bucket.owner) return state
          const merged = { ...current.outputs }
          for (const doc of outputs) if ((merged[doc.turnId]?.revision ?? 0) < doc.revision) merged[doc.turnId] = doc
          return patchBucket(state, sessionId, (b) => ({ ...b, outputs: merged }))
        })
      } catch (error) {
        set((state) => state.bySession[sessionId]?.owner !== bucket.owner ? state : patchBucket(state, sessionId, (b) => ({ ...b, outputErrors: { ...b.outputErrors, history: error instanceof Error ? error.message : String(error) } })))
      } })()
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
      ...(useHomeStore.getState().session === home && { activeSessionId: summary.id }),
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

  /** 等 Host 落盘成功再更新标题；只合并命名字段，避免迟到响应撤回其他摘要变更。 */
  rename: async (sessionId, title) => {
    const { summary } = await window.cogent.engineRequest('session.rename', { sessionId, title })
    set((state) => ({
      sessions: state.sessions.map((s) => s.id === sessionId
        ? { ...s, title: summary.title, titleManual: summary.titleManual } : s)
    }))
  },

  /** 置顶/取消（引擎侧落 pinnedAt 并持久化）；同步更新列表内该会话的摘要 */
  setPinned: async (sessionId, pinned) => {
    const { summary } = await window.cogent.engineRequest('session.setPinned', { sessionId, pinned })
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? summary : s))
    }))
  },

  /** 归档/恢复（回收站语义）：引擎 session.list 已滤掉归档会话，归档把摘要
      移出本地列表；恢复重拉 session.list 让会话回主栏（2026-11-20 归档撤销
      toast 落地时收进来 —— 此前"由调用方刷新"，撤销处没有自然的刷新时机；
      不走 load()：它会自动选中首个会话，恢复不该带导航副作用，选中/视图
      还原由撤销发起方决定）。归档**活动**会话时视图才落 kind:'new'
      （须比对 chatId：侧栏可归档任意后台会话，无条件踢视图会把
      正打开的对话误拉到新聊天着陆页） */
  archive: async (sessionId, archived) => {
    await window.cogent.engineRequest('session.archive', { sessionId, archived })
    if (!archived) {
      const sessions = await window.cogent.engineRequest('session.list', {})
      set({ sessions })
      return
    }
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== sessionId),
      activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId
    }))
    const home = useHomeStore.getState().session
    if (home.kind === 'chat' && home.chatId === sessionId) {
      useHomeStore.getState().startNewChat()
    }
  },

  deleteSession: async (sessionId) => {
    await window.cogent.engineRequest('session.delete', { sessionId })
    messageDeltas.discard(sessionId)
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
      useHomeStore.getState().startNewChat()
    }
    await useAttachmentStore.getState().discardChat(sessionId).catch((error: unknown) => {
      set({ loadError: `聊天已删除，但草稿清理失败：${unwrapIpcError(error)}` })
    })
  },

  submit: async (text, model, thinkingLevel, provider, attachments = [], directories = []) => {
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
    messageDeltas.flush(sessionId)
    const runRequestId = Symbol('submit')
    // 乐观上屏用户消息；assistant 回复由引擎事件流驱动
    const userMessage: ChatMessage = {
      id: `u-${crypto.randomUUID()}`,
      role: 'user',
      content: text,
      ...(attachments.length > 0 && { attachments }),
      ...(directories.length > 0 && { directories }),
      timestamp: Date.now()
    }
    set((state) =>
      patchBucket(state, sessionId, (bucket) => ({
        ...bucket,
        messages: [...bucket.messages, userMessage],
        runtime: {
          ...bucket.runtime,
          running: true,
          // 新 run 消费上次结果与停止请求身份，旧 IPC 回调不能再回写这一轮。
          stopping: false,
          stopRequestId: null,
          runRequestId,
          lastRunOutcome: null,
          lastError: null,
          truncated: false
        }
      }))
    )
    // provider 随 model 下发：同名模型被多家目录收录（azure 也收录 deepseek-v4-pro），
    // 只传 id 引擎全局查找有歧义（详见 protocol AgentSubmitParams.provider 注释）
    try {
      await window.cogent.engineRequest('agent.submit', { sessionId, text, model, thinkingLevel, provider,
        ...(attachments.length > 0 && { attachmentIds: attachments.map((a) => a.id) }),
        inputId: userMessage.id,
        ...(directories.length > 0 && { directories }) })
      return sessionId
    } catch (error) {
      // IPC回包晚于终态/新run/删桶时，旧请求没有队列、消息或输入区的回写权。
      if (get().bySession[sessionId]?.runtime.runRequestId !== runRequestId) return false
      messageDeltas.discard(sessionId)
      // renderer→引擎边界（合法设防位）：引擎进程退出/未就绪时 main 拒绝在途请求，
      // 事件流的终态（run.failed）不会来 —— 必须自己收尾运行态，否则输入框永久
      // 锁死。乐观上屏的用户消息一并撤回（没提交成功，留着会在重发时出现双条），
      // 错误落该会话的错误条；rethrow 让调用方（send）回填输入框文本
      useChatStore.setState((state) =>
        patchBucket(state, sessionId, (bucket) => ({
          ...bucket,
          messages: bucket.messages.filter((message) => message.id !== userMessage.id),
          runtime: {
            ...bucket.runtime,
            running: false,
            stopping: false,
            stopRequestId: null,
            runRequestId: null,
            lastRunOutcome: 'failed',
            lastError: unwrapIpcError(error)
          }
        }))
      )
      throw error
    }
  },

  abort: async () => {
    const sessionId = get().activeSessionId
    if (sessionId === null) return
    messageDeltas.flush(sessionId)
    // 终态已经到达时不再产生停止请求；最终结果始终由事件给出。
    if (get().bySession[sessionId]?.runtime.running !== true) return
    const stopRequestId = Symbol('abort')
    set((state) =>
      patchBucket(state, sessionId, (bucket) => ({
        ...bucket,
        runtime: { ...bucket.runtime, stopping: true, stopRequestId }
      }))
    )
    // IPC 是外部边界：拒绝只收本次操作，run 继续等待权威终态。身份随终态、
    // 新 run 或删桶失效，晚到响应不能覆盖新运行，也不能把删掉的桶补回来。
    const settleRequest = (error: string | null): void => {
      set((state) => {
        const bucket = state.bySession[sessionId]
        if (bucket === undefined || bucket.runtime.stopRequestId !== stopRequestId) return state
        return patchBucket(state, sessionId, () => ({
          ...bucket,
          runtime: {
            ...bucket.runtime,
            stopping: false,
            stopRequestId: null,
            lastError: error === null ? bucket.runtime.lastError : error
          }
        }))
      })
    }
    try {
      const { aborted } = await window.cogent.engineRequest('agent.abort', { sessionId })
      if (!aborted) settleRequest(null)
    } catch (error) {
      settleRequest(unwrapIpcError(error))
    }
  },

  continueGeneration: async () => {
    const sessionId = get().activeSessionId
    if (sessionId === null) return
    messageDeltas.flush(sessionId)
    const runRequestId = Symbol('continue')
    // 运行位由本地动作持有（chat 不处理 run.started）；无用户泡 —— 续写
    // 指令由引擎注入并在投影层并入相邻段，这里不往列表里塞任何东西
    set((state) =>
      patchBucket(state, sessionId, (bucket) => ({
        ...bucket,
        runtime: {
          ...bucket.runtime,
          running: true,
          stopping: false,
          stopRequestId: null,
          runRequestId,
          lastRunOutcome: null,
          lastError: null,
          truncated: false
        }
      }))
    )
    try {
      await window.cogent.engineRequest('session.continue', { sessionId })
    } catch (error) {
      if (get().bySession[sessionId]?.runtime.runRequestId !== runRequestId) return
      messageDeltas.discard(sessionId)
      // 引擎侧拒绝（忙/末条非截断）或边界失败：回落运行态，错误落会话错误条
      useChatStore.setState((state) =>
        patchBucket(state, sessionId, (bucket) => ({
          ...bucket,
          turnOutcomes: recordTurnOutcome(bucket, 'failed'),
          runtime: {
            ...bucket.runtime,
            running: false,
            stopping: false,
            stopRequestId: null,
            runRequestId: null,
            lastRunOutcome: 'failed',
            lastError: unwrapIpcError(error)
          }
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
      useChatStore.setState((state) => {
        // 准备链可能在会话删除后才拒绝；操作错误不能把已删桶重新建出来。
        const bucket = state.bySession[sessionId]
        if (bucket === undefined) return state
        return patchBucket(state, sessionId, () => ({
          ...bucket,
          runtime: { ...bucket.runtime, lastError: unwrapIpcError(error) }
        }))
      })
    }
  },

  respondApproval: async (requestId, approved, options) => {
    messageDeltas.flushAll()
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

// 整桶替换、清空和外部快照写入是失效边界；常规事件先 flush，故这里不会吞在途增量。
// 订阅只随模块/store 存活，无 timer；App 的 bind 清理负责队列排空。
useChatStore.subscribe((state, previous) => {
  messageDeltas.discardChanged((sessionId) =>
    state.bySession[sessionId]?.messages !== previous.bySession[sessionId]?.messages
  )
})
