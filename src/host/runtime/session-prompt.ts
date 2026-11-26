/**
 * 会话提示词兼容出口与上下文三段 token 粗估。
 * 提示词正本已归口至 `./prompts/`（系统前缀、回合动态段、提醒封装、宿主工具描述），
 * 本文件保留既有导入路径与 `estimateContext` 估算函数。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { getSystemMessageText } from '@earendil-works/pi-ai/utils/text'
import type { ContextEstimate } from '../../protocol'
import { convertToLlmMessages } from './compaction'
import { toolDeclarations } from './tool-meta'

export {
  buildSystemPrompt,
  permissionSectionText,
  planModeSectionText,
  readGitBranch
} from './prompts'

/** 上下文明细三段估算（与 pi clampMaxTokensToContext 同源）。 */
export function estimateContext(messages: AgentMessage[], systemPrompt?: string): ContextEstimate {
  const llmMessages = convertToLlmMessages(messages)
  if (systemPrompt !== undefined) {
    llmMessages.unshift({
      role: 'system',
      content: systemPrompt,
      toolsAdded: toolDeclarations() as never,
      timestamp: 0
    })
  }
  let systemTextTokens = 0
  let toolDefs = 0
  const rest: ReturnType<typeof convertToLlmMessages> = []
  for (const message of llmMessages) {
    if (message.role === 'system') {
      systemTextTokens += estimateTextTokens(getSystemMessageText(message))
      if (message.toolsAdded) toolDefs += estimateTextTokens(JSON.stringify(message.toolsAdded))
      continue
    }
    rest.push(message)
  }
  return {
    systemPrompt: systemTextTokens,
    toolDefs,
    messages: rest.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
    total: estimateContextTokens(llmMessages).tokens
  }
}
