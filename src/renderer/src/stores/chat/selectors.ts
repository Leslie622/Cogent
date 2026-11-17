/**
 * chat store 的组件订阅 selector 层（2026-11-17 会话状态重构 P2 拆出）：
 * 活动会话的运行位/错误位视图。签名与语义保持桶化前不变 —— 组件经
 * useChatStore(selectRunning) 订阅，内部读桶。
 * EMPTY_MESSAGES：无桶/空桶回退的模块级稳定引用（约定 1.2-8 —— 选择器里
 * `?? []` 字面量每次快照都是新数组，useSyncExternalStore 判定 store 恒变，
 * 挂载即 Maximum update depth exceeded）；此前 HomeChat 与 ContextIndicator
 * 各持一份本地副本，随拆分收敛为单一出处。
 */
import type { ChatState, MessageItem, SessionRuntime } from './types'

/** 空消息列表回退（见文件头：引用稳定是硬要求） */
export const EMPTY_MESSAGES: MessageItem[] = []

/** 活动会话是否流式中（组件订阅用；返回原始值，selector 引用稳定） */
export function selectRunning(state: ChatState): boolean {
  return state.bySession[state.activeSessionId ?? '']?.runtime.running === true
}

/** 活动会话是否处于本窗停止请求窗口；不代表最终已停止 */
export function selectStopping(state: ChatState): boolean {
  return state.bySession[state.activeSessionId ?? '']?.runtime.stopping === true
}

/** 回合头消费最终结果，独立于停止按钮和操作错误 */
export function selectLastRunOutcome(state: ChatState): SessionRuntime['lastRunOutcome'] {
  return state.bySession[state.activeSessionId ?? '']?.runtime.lastRunOutcome ?? null
}

/** 活动会话的最近错误文案（无 = null） */
export function selectLastError(state: ChatState): string | null {
  return state.bySession[state.activeSessionId ?? '']?.runtime.lastError ?? null
}

/** 活动会话的最近回复是否被截断 */
export function selectTruncated(state: ChatState): boolean {
  return state.bySession[state.activeSessionId ?? '']?.runtime.truncated === true
}

/** 活动会话压缩进行中（完备化 D8：started→completed 窗口的状态条判别位） */
export function selectCompacting(state: ChatState): boolean {
  return state.bySession[state.activeSessionId ?? '']?.runtime.compacting === true
}
