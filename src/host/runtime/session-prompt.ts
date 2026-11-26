/**
 * 会话提示词兼容出口与上下文多维 token 粗估。
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

export interface ToolDeclLike {
  name: string
  description?: string
  parameters?: unknown
}

const SKILLS_TAG_PATTERN = /<skills>[\s\S]*?<\/skills>/g

/** 上下文明细多维估算（与 pi clampMaxTokensToContext 同源，兼容既有 3 段并细拆技能/MCP/工具输出）。 */
export function estimateContext(
  messages: AgentMessage[],
  systemPrompt?: string,
  activeTools?: readonly ToolDeclLike[]
): ContextEstimate {
  const llmMessages = [...convertToLlmMessages(messages)]
  const toolsList: readonly ToolDeclLike[] = activeTools !== undefined && activeTools.length > 0 ? activeTools : toolDeclarations()
  if (systemPrompt !== undefined) {
    llmMessages.unshift({
      role: 'system',
      content: systemPrompt,
      toolsAdded: toolsList as never,
      timestamp: 0
    })
  }
  let systemTextTokens = 0
  let skillsTokens = 0
  let toolDefs = 0
  let mcpToolTokens = 0
  const rest: ReturnType<typeof convertToLlmMessages> = []
  for (const message of llmMessages) {
    if (message.role === 'system') {
      const fullText = getSystemMessageText(message)
      const skillMatches = fullText.match(SKILLS_TAG_PATTERN)
      if (skillMatches !== null) {
        const skillText = skillMatches.join('\n')
        const skillEst = estimateTextTokens(skillText)
        skillsTokens += skillEst
        systemTextTokens += Math.max(0, estimateTextTokens(fullText) - skillEst)
      } else {
        systemTextTokens += estimateTextTokens(fullText)
      }
      if (message.toolsAdded) {
        const added = message.toolsAdded as readonly ToolDeclLike[]
        const totalToolsEst = estimateTextTokens(JSON.stringify(added))
        toolDefs += totalToolsEst
        const mcpOnly = added.filter((t) => t.name.startsWith('mcp__'))
        if (mcpOnly.length > 0) {
          mcpToolTokens += Math.min(totalToolsEst, estimateTextTokens(JSON.stringify(mcpOnly)))
        }
      }
      continue
    }
    rest.push(message)
  }
  let dialogueTokens = 0
  let toolResultTokens = 0
  for (const m of rest) {
    const est = estimateMessageTokens(m)
    if (m.role === 'toolResult') toolResultTokens += est
    else dialogueTokens += est
  }
  return {
    systemPrompt: systemTextTokens + skillsTokens,
    toolDefs,
    messages: dialogueTokens + toolResultTokens,
    total: estimateContextTokens(llmMessages).tokens,
    skills: skillsTokens,
    mcpTools: mcpToolTokens,
    toolResults: toolResultTokens
  }
}
