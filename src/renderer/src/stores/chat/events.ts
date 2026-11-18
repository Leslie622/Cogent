/**
 * 引擎事件订阅：App 挂载时接一次（bindEngineEvents），把事件流转译为
 * chat store 的会话桶更新 —— "事件 → 状态"的转译集中一处，组件只读状态
 * （2026-11-17 会话状态重构 P2 自 chat.ts 拆出，分支逻辑不变、写入形状
 * 桶化，见 docs/模块/会话与对话.md 的 owner + 事件顺序图）。
 * 帧形状 = env.d.ts 的 EngineEvent 判别联合：switch(method) 自然窄化 params，
 * 不做 as + typeof 抽查 —— 那会把联合拆成 untyped record，类型系统从此拦不住
 * 取错字段（当初形状 bug 的成因，见约定.md §1.2-7）。
 */
import { replaceRunTerminal } from './flatten'
import { emptyBucket, messageDeltas, patchBucket, recordTurnOutcome, useChatStore } from './store'
import { notifyEvent } from '@/lib/notify'
import { useEngineStore } from '@/stores/engine'
import type { ChatMessage } from '@/env.d'
import type { ApprovalItem, MessageItem, SessionBucket, SessionRuntime, ToolItem } from './types'

export function bindEngineEvents(): () => void {
  const unsubscribe = window.cogent.onEngineEvent((event) => {
    if (event.method === 'message.delta') {
      messageDeltas.enqueue(event.params)
      return
    }
    // 非连续 delta 不跨事件合并；摘要没有 sessionId，使用其明确的摘要身份。
    if ('sessionId' in event.params) messageDeltas.flush(event.params.sessionId)
    else if (event.method === 'session.summaryChanged') messageDeltas.flush(event.params.summary.id)
    switch (event.method) {
      case 'tool.started': {
        const { sessionId, callId, name, kind, summary } = event.params
        useChatStore.setState((state) =>
          patchBucket(state, sessionId, (bucket) => {
            // 封段接力：模型先出文字再调工具时，活跃占位翻 placeholder 定格在本位
            // —— id 不变（id 换名 = 渲染 key 变 = 正文行重挂，见计划/正文衔接连续性
            // 修复）；后续轮次的 delta 会另起占位，文字与工具卡交错不失真
            const messages = bucket.messages
            const last = messages.at(-1)
            const sealed =
              last !== undefined && last.type === undefined && last.role === 'assistant' && last.placeholder
                ? [...messages.slice(0, -1), { ...last, placeholder: false }]
                : messages
            const item: ToolItem = {
              id: callId,
              type: 'tool',
              name,
              toolKind: kind,
              summary: summary ?? `${name}()`,
              status: 'running'
            }
            return { ...bucket, messages: [...sealed, item] }
          })
        )
        return
      }
      case 'tool.completed': {
        const { sessionId, callId, isError, summary, diff } = event.params
        useChatStore.setState((state) => {
          const bucket = state.bySession[sessionId]
          if (bucket === undefined) return state
          // 带注解的中间变量锚定字面量联合：spread 字面量的属性会被 TS 展宽成
          // string（带 spread 的对象字面量不参与上下文类型），断言写法又会被
          // no-unnecessary-type-assertion 拦 —— 变量注解是两边都干净的形式
          const nextStatus: ToolItem['status'] = isError ? 'error' : 'ok'
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...bucket,
                messages: bucket.messages.map((m): MessageItem =>
                  m.type === 'tool' && m.id === callId
                    ? { ...m, status: nextStatus, resultSummary: summary, diff, progress: undefined }
                    : m
                )
              }
            }
          }
        })
        return
      }
      case 'tool.progress': {
        // bash 等长时工具的流式尾部快照（整段替换非增量）：只更新 running 项
        const { sessionId, callId, text } = event.params
        useChatStore.setState((state) => {
          const bucket = state.bySession[sessionId]
          if (bucket === undefined) return state
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...bucket,
                messages: bucket.messages.map((m): MessageItem =>
                  m.type === 'tool' && m.id === callId && m.status === 'running'
                    ? { ...m, progress: text }
                    : m
                )
              }
            }
          }
        })
        return
      }
      case 'approval.request': {
        const { sessionId, requestId, toolName, kind, summary, outsideRoots } = event.params
        useChatStore.setState((state) =>
          // D1：pending 不进消息流 —— 会话桶的挂起位，确认面板（ApprovalPanel）
          // 是唯一呈现位；数组追加（并行写工具会并发多个请求）
          patchBucket(state, sessionId, (bucket) => ({
            ...bucket,
            pendingApprovals: [
              ...bucket.pendingApprovals,
              { requestId, toolName, toolKind: kind, summary, ...(outsideRoots === true && { outsideRoots: true }) }
            ]
          }))
        )
        notifyEvent('approval', useEngineStore.getState().notify)
        return
      }
      case 'todos.updated': {
        // 快照语义整段替换（全量替换的清单没有增量合并问题）；空清单也写 ——
        // 清空是用户可见状态（TodoStrip 收起）
        const { sessionId, todos } = event.params
        useChatStore.setState((state) =>
          patchBucket(state, sessionId, (bucket) => ({ ...bucket, todos }))
        )
        return
      }
      case 'question.asked': {
        const { sessionId, requestId, questions } = event.params
        useChatStore.setState((state) =>
          patchBucket(state, sessionId, (bucket) => ({
            ...bucket,
            pendingQuestions: [...bucket.pendingQuestions, { requestId, questions }]
          }))
        )
        notifyEvent('question', useEngineStore.getState().notify)
        return
      }
      case 'plan.requested': {
        const { sessionId, requestId, plan } = event.params
        useChatStore.setState((state) =>
          patchBucket(state, sessionId, (bucket) => ({
            ...bucket,
            pendingPlans: [...bucket.pendingPlans, { requestId, plan }]
          }))
        )
        return
      }
      case 'session.summaryChanged': {
        // 摘要广播：重命名、档位/计划开关变化 → 替换列表项与相关显示。
        // RPC 返回值更新是同款形状的另一条路（用户主动路径），两路幂等
        const { summary } = event.params
        useChatStore.setState((state) => ({
          sessions: state.sessions.map((s) => (s.id === summary.id ? summary : s))
        }))
        return
      }
      case 'compaction.started': {
        // 压缩进行中（完备化 D8）：置状态条判别位，completed 分支回落。
        // 自动路发生在 run 事件间隙（submit 前 / 工具轮间），状态条与流式占位并存
        const { sessionId } = event.params
        useChatStore.setState((state) =>
          patchBucket(state, sessionId, (bucket) => ({
            ...bucket,
            runtime: { ...bucket.runtime, compacting: true }
          }))
        )
        return
      }
      case 'compaction.pruned': {
        // L1 裁剪落账：副行**立即追加**到列表
        // 尾（当前流内的过程行）—— L1 单独够（无后续 completed）时它就是本次
        // 裁剪的全部呈现；同一检查点若跟进 L2（completed），completed 手术会
        // 撤下独立行、随折叠条配对重插，不双份。账目同时记 runtime.pruned
        // 供 completed 配对（取后即清）
        const { sessionId, entries } = event.params
        if (entries.length === 0) return
        const timestamp = Date.now()
        useChatStore.setState((state) =>
          patchBucket(state, sessionId, (bucket) => ({
            ...bucket,
            runtime: { ...bucket.runtime, pruned: entries },
            messages: [
              ...bucket.messages,
              { id: `compaction-pruned-${timestamp}`, type: 'pruned', entries, timestamp }
            ]
          }))
        )
        return
      }
      case 'compaction.completed': {
        // 压缩完成：在压缩发生位置（被摘要区末条之后）**原位插入**折叠条，
        // 旧消息不删（D9 保留式呈现，Codex 形态 —— 历史不因压缩消失，标记
        // 行停在自己发生的地方）。引擎转录同形（影子区保留 + 标记条原位），
        // 历史回查投影天然一致；事件载荷已含折叠条全部数据（summary/前后
        // token/锚点/摘要用量），手术零往返，无"重拉历史"竞态
        const { sessionId, error, tokensBefore, tokensAfter, summary, summarizedUntil, summaryUsage } = event.params
        // 无论成败清「压缩中」位（失败也结束窗口）；同时弃置轮终 live 值 ——
        // 它是压缩前的旧账，指示器分子切压缩后 tokensAfter 估算（≈ 口径）。
        // 桶不存在 = 该会话无本地状态（后台广播），无可清也无需建桶
        useChatStore.setState((state) => {
          const bucket = state.bySession[sessionId]
          if (bucket === undefined) return state
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...bucket,
                runtime: { ...bucket.runtime, compacting: false, contextLive: null }
              }
            }
          }
        })
        if (error !== undefined || summarizedUntil === undefined) return // 失败路：自动已降级继续、手动走方法错误帧
        useChatStore.setState((state) => {
          const bucket = state.bySession[sessionId]
          if (bucket === undefined) return state
          const timestamp = Date.now()
          const pruned = bucket.runtime.pruned
          let cleaned = bucket.messages
          // 撤下同检查点的独立副行（pruned 事件先行追加、恒为列表**末条**
          // pruned）：entries 深比较命中才撤 —— 早前 L1-alone 检查点的独立
          // 行是历史痕迹，保留；配对行随 bar 插入，不双份
          if (pruned !== null && pruned.length > 0) {
            for (let i = cleaned.length - 1; i >= 0; i--) {
              // 先落局部再判别（元素访问不参与窄化，同 run.completed 的 lastUser 扫描）
              const item = cleaned[i]
              if (item.type !== 'pruned') continue
              if (JSON.stringify(item.entries) === JSON.stringify(pruned)) {
                cleaned = cleaned.filter((_, j) => j !== i)
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
            compactionInRun: bucket.runtime.running,
            content: summary ?? '',
            compaction: { tokensBefore: tokensBefore ?? 0, tokensAfter, summaryUsage },
            timestamp
          }
          // L1 prune 副行：随折叠条同区配对呈现「已裁剪 N 处
          // 工具输出」，取后即清（下次裁剪再来）
          const head: MessageItem[] = [bar]
          if (pruned !== null && pruned.length > 0) {
            head.push({
              id: `compaction-pruned-${timestamp}`,
              type: 'pruned',
              entries: pruned,
              timestamp
            })
          }
          const at = insertAt + 1
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...bucket,
                messages: [...cleaned.slice(0, at), ...head, ...cleaned.slice(at)],
                runtime: { ...bucket.runtime, pruned: null }
              }
            }
          }
        })
        return
      }
      case 'context.updated': {
        // 轮终实报：指示器 run 内实时分子 —— 事件序即时间序，
        // 后轮覆盖前轮；run 终态/压缩时清除（见各分支）
        const { sessionId, usage } = event.params
        useChatStore.setState((state) =>
          patchBucket(state, sessionId, (bucket) => ({
            ...bucket,
            runtime: { ...bucket.runtime, contextLive: usage }
          }))
        )
        return
      }
      case 'run.completed': {
        const { sessionId, message, messages, stopReason } = event.params
        useChatStore.setState((state) => {
          const bucket = state.bySession[sessionId]
          if (bucket === undefined) return state
          // 终态整段替换（messages 优先，老引擎退回聚合 message 单段）
          const segments = messages ?? (message !== undefined ? [message] : [])
          const finalMessages = replaceRunTerminal(bucket.messages, segments)
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...bucket,
                messages: finalMessages,
                turnOutcomes: recordTurnOutcome(bucket, 'completed'),
                // 面板兜底清空（常态路径裁决时已收；防御 run 终态与裁决竞态的残留）
                pendingApprovals: [],
                runtime: {
                  ...bucket.runtime,
                  running: false,
                  // abort raced 完成（完成先到）：停止位一并消费
                  stopping: false,
                  stopRequestId: null,
                  runRequestId: null,
                  lastRunOutcome: 'completed',
                  lastError: null,
                  truncated: stopReason === 'length',
                  // 轮终 live 值随终态清除（segments 内 usage 为准）
                  contextLive: null
                }
              }
            },
            // 首条消息后标题已在引擎侧生成；updatedAt 顺带推进（排序口径）
            sessions: state.sessions.map((session) =>
              session.id === sessionId ? { ...session, updatedAt: Date.now() } : session
            )
          }
        })
        void refreshSessionTitle()
        notifyEvent('turn-done', useEngineStore.getState().notify)
        return
      }
      case 'run.failed': {
        const { sessionId, message, messages, reason } = event.params
        useChatStore.setState((state) => {
          const existing = state.bySession[sessionId]
          // 引擎终态才是停止事实；本窗点过停止不代表错误一定由停止造成。
          const wasStopped = reason === 'aborted'
          // 运行位复位对无桶会话也成立（多窗口广播：另一窗的会话在本窗失败，
          // 本窗无桶也落复位，防残留 running）。live 值随终态清除：有 messages
          // 时 usage 已落 segments；无时也不留旧值蒙指示器（终态后分子回落
          // 末条落盘 usage）。复位桶/reset 桶用局部引用组装（Partial 索引读回
          // 是 T | undefined，回查 base.bySession[sessionId] 会让 TS 掺进
          // undefined 形状）
          const reset = existing ?? emptyBucket()
          const resetRuntime: SessionRuntime = {
            ...reset.runtime,
            running: false,
            stopping: false,
            stopRequestId: null,
            runRequestId: null,
            lastRunOutcome: wasStopped ? 'stopped' : 'failed',
            truncated: false,
            contextLive: null,
            lastError: wasStopped ? null : message
          }
          const failedBase: SessionBucket = {
            ...reset,
            runtime: resetRuntime,
            turnOutcomes: recordTurnOutcome(reset, wasStopped ? 'stopped' : 'failed')
          }
          const base = { bySession: { ...state.bySession, [sessionId]: failedBase } }
          if (existing === undefined) return base // 无本地消息：只复位运行位（原判定同款）
          const list = existing.messages
          // pi 中止也会 turn_end；Host 快照已经含封存尾段，不能再拼本地占位。
          // 空数组同样是权威结果；字段缺席才走下面的旧事件收尾。
          if (messages !== undefined) {
            const replaced = replaceRunTerminal(list, messages)
            // 挂起中的审批（会话桶面板态）收面板 + 落 cancelled 痕迹行（引擎侧
            // signal 已 resolve block）—— 不留永久等待面板/痕迹缺口
            return {
              ...base,
              bySession: {
                ...base.bySession,
                [sessionId]: {
                  ...failedBase,
                  messages: [
                    ...replaced,
                    ...existing.pendingApprovals.map(
                      (p): ApprovalItem => ({ ...p, id: p.requestId, type: 'approval', status: 'cancelled' })
                    )
                  ],
                  pendingApprovals: []
                }
              }
            }
          }
          return {
            ...base,
            bySession: {
              ...base.bySession,
              [sessionId]: {
                ...failedBase,
                // 失败收尾（引擎无分段 —— 首请求即失败等）：中止 = 半截占位翻
                // placeholder 封存（id 不变，同 tool.started 的封段接力，已出文本
                // 留在消息流）；真失败 = 占位移除（既有口径）。挂在 run 里的
                // 工具卡若还 running（打断在工具处）标 blocked
                messages: [
                  ...list
                    .flatMap((m): MessageItem[] => {
                      if (m.type !== undefined || m.role !== 'assistant' || !m.placeholder) return [m]
                      return wasStopped ? [{ ...m, placeholder: false }] : []
                    })
                    .map((m) => (m.type === 'tool' && m.status === 'running' ? { ...m, status: 'blocked' as const } : m)),
                  ...existing.pendingApprovals.map(
                    (p): ApprovalItem => ({ ...p, id: p.requestId, type: 'approval', status: 'cancelled' })
                  )
                ],
                pendingApprovals: []
              }
            }
          }
        })
        // 失败提醒（failed 变体文案）；aborted 不提醒 —— 用户自己停的，知道结果
        if (reason !== 'aborted') {
          notifyEvent('turn-done', useEngineStore.getState().notify, true)
        }
        return
      }
      default:
        return
    }
  })
  return () => {
    unsubscribe()
    messageDeltas.flushAll()
  }
}

/** run.completed 后回查一次会话列表，让"首条消息生成标题"反映到侧栏 */
async function refreshSessionTitle(): Promise<void> {
  const previous = useChatStore.getState().sessions
  const sessions = await window.cogent.engineRequest('session.list', {})
  useChatStore.setState((state) => ({
    sessions: state.sessions.map((session) => {
      // 回查期间的重命名等摘要更新优先，旧列表响应不能覆盖后来操作。
      if (previous.find((s) => s.id === session.id) !== session) return session
      const fresh = sessions.find((s) => s.id === session.id)
      return fresh ? { ...session, title: fresh.title, updatedAt: fresh.updatedAt } : session
    })
  }))
}
