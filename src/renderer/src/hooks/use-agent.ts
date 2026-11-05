import { useCallback, useEffect, useState } from 'react'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AgentStatus } from '@shared/ipc'
import { cogent } from '@/lib/ipc'

/**
 * 渲染层 Agent 状态机：订阅主进程转发过来的 pi AgentEvent 流，
 * 把事件流折叠成可直接渲染的会话条目（消息 / 工具调用）。
 */

export interface MessageItem {
  kind: 'message'
  key: string
  role: 'user' | 'assistant'
  text: string
  thinking: string
  streaming: boolean
  errorMessage?: string
}

export interface ToolItem {
  kind: 'tool'
  key: string
  name: string
  status: 'running' | 'done'
  summary: string
}

export type ChatItem = MessageItem | ToolItem

interface BlockLike {
  type?: string
  text?: string
  thinking?: string
}

function asBlocks(content: unknown): BlockLike[] {
  return Array.isArray(content) ? (content.filter((b) => !!b && typeof b === 'object') as BlockLike[]) : []
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  return asBlocks(content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

function extractThinking(content: unknown): string {
  return asBlocks(content)
    .filter((b) => b.type === 'thinking')
    .map((b) => b.thinking ?? '')
    .join('')
}

function summarizeResult(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const text = extractText((result as { content?: unknown }).content).trim()
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

function applyEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
  switch (event.type) {
    case 'message_start': {
      const { message } = event
      if (message.role === 'user') {
        return [
          ...items,
          {
            kind: 'message',
            key: crypto.randomUUID(),
            role: 'user',
            text: extractText(message.content),
            thinking: '',
            streaming: false
          }
        ]
      }
      if (message.role === 'assistant') {
        return [
          ...items,
          { kind: 'message', key: crypto.randomUUID(), role: 'assistant', text: '', thinking: '', streaming: true }
        ]
      }
      // toolResult 等角色的结果由工具条目展示，不重复渲染
      return items
    }

    case 'message_update': {
      // assistant 流式更新始终作用于最后一条流式 assistant 消息
      return items.map((item, index) =>
        index === items.length - 1 && item.kind === 'message' && item.role === 'assistant' && item.streaming
          ? {
              ...item,
              text: extractText(event.message.content),
              thinking: extractThinking(event.message.content)
            }
          : item
      )
    }

    case 'message_end': {
      const { message } = event
      if (message.role !== 'assistant') return items
      return items.map((item, index) => {
        if (index !== items.length - 1 || item.kind !== 'message' || item.role !== 'assistant') return item
        const errorMessage = message.stopReason === 'error' ? message.errorMessage ?? '生成失败' : undefined
        return { ...item, streaming: false, errorMessage }
      })
    }

    case 'tool_execution_start': {
      return [
        ...items,
        { kind: 'tool', key: event.toolCallId, name: event.toolName, status: 'running', summary: '' }
      ]
    }

    case 'tool_execution_update': {
      return items
    }

    case 'tool_execution_end': {
      const summary = summarizeResult(event.result)
      return items.map((item) =>
        item.kind === 'tool' && item.key === event.toolCallId ? { ...item, status: 'done', summary } : item
      )
    }

    case 'agent_end': {
      // 兜底：异常中断时把仍在流式中的条目收敛为完成态
      return items.map((item) => (item.kind === 'message' && item.streaming ? { ...item, streaming: false } : item))
    }

    default:
      return items
  }
}

export function useAgent() {
  const [items, setItems] = useState<ChatItem[]>([])
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    cogent
      .status()
      .then((value) => {
        if (mounted) setStatus(value)
      })
      .catch((reason: unknown) => {
        if (mounted) setError(String(reason))
      })

    const unsubscribe = cogent.onAgentEvent((event) => {
      if (!mounted) return
      if (event.type === 'agent_start') setRunning(true)
      else if (event.type === 'agent_end') setRunning(false)
      setItems((prev) => applyEvent(prev, event))
    })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const send = useCallback(async (text: string) => {
    setError(null)
    try {
      await cogent.send(text)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const abort = useCallback(() => {
    void cogent.abort()
  }, [])

  return { items, status, running, error, send, abort }
}
