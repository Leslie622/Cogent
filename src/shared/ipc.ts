import type { AgentEvent } from '@earendil-works/pi-agent-core'

/**
 * IPC 契约：channel 名与载荷类型在这里定义，main / preload / renderer 三端共用。
 * 只允许出现类型与常量，禁止引入任何运行时依赖。
 */

export const IPC = {
  /** renderer → main：查询 Agent 配置状态 */
  agentStatus: 'agent:status',
  /** renderer → main：发送一条用户消息，触发一轮 agent run */
  agentPrompt: 'agent:prompt',
  /** renderer → main：中止当前 run */
  agentAbort: 'agent:abort',
  /** main → renderer：Agent 事件流（pi AgentEvent 透传） */
  agentEvent: 'agent:event'
} as const

export interface AgentStatus {
  /** 是否已有可用的 Provider 凭据 */
  configured: boolean
  provider: string | null
  modelId: string | null
  modelLabel: string | null
}

/** main 进程转发给 renderer 的 pi Agent 事件（可 JSON 序列化） */
export type AgentEventPayload = AgentEvent
