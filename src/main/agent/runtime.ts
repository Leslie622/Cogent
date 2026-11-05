import { Agent, type AgentEvent } from '@earendil-works/pi-agent-core'
import type { AgentStatus } from '../../shared/ipc'
import { models, resolveDefaultModel } from './models'
import { tools } from './tools'

/**
 * Agent 运行时：持有 pi 的 Agent 实例，把 Agent 事件分发给订阅者（IPC 层）。
 * 会话状态（messages / model / tools）都在 Agent 内，未来做多会话时
 * 把这里的单例换成 Map<sessionId, Agent> 即可。
 */

// 产品人设：按产品需要修改。
const SYSTEM_PROMPT = `You are Cogent, a helpful agent.
Answer concisely and directly. Use the available tools when they help.`

let agent: Agent | null = null
const listeners = new Set<(event: AgentEvent) => void>()

function ensureAgent(): Agent {
  if (agent) return agent

  const resolved = resolveDefaultModel()
  if (!resolved) {
    throw new Error(
      'No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or ZAI_API_KEY and restart the app.'
    )
  }

  agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: resolved.model,
      tools
    },
    streamFn: models.streamSimple.bind(models)
  })

  agent.subscribe((event) => {
    for (const listener of listeners) listener(event)
  })

  return agent
}

export function status(): AgentStatus {
  const resolved = resolveDefaultModel()
  if (!resolved) {
    return { configured: false, provider: null, modelId: null, modelLabel: null }
  }
  return {
    configured: true,
    provider: resolved.provider,
    modelId: resolved.model.id,
    modelLabel: resolved.model.name
  }
}

export function subscribe(listener: (event: AgentEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function prompt(text: string): Promise<void> {
  await ensureAgent().prompt(text)
}

export function abort(): void {
  agent?.abort()
}
