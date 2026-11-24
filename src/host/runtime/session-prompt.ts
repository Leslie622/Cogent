/**
 * 会话提示词装配与上下文估算：系统提示词、权限/计划模式段、Git 分支探测与三段 token 粗估。
 * 从 session.ts 拆出以隔离提示词文案和 pi-ai 估算辅助。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { getSystemMessageText } from '@earendil-works/pi-ai/utils/text'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextEstimate, PermissionMode } from '../../protocol'
import { convertToLlmMessages } from './compaction'
import { SHELL_TOOL_NAME, toolDeclarations } from './tool-meta'

/** AGENTS.md 只读加载的长度上限（字符）——巨型指令文件不吃满上下文 */
const AGENTS_MD_MAX_CHARS = 16_000

/** git 当前分支：解析 <cwd>/.git/HEAD 的 ref: refs/heads/<branch>；非仓库/异常返回 null */
export function readGitBranch(cwd: string): string | null {
  try {
    const head = join(cwd, '.git', 'HEAD')
    if (!existsSync(head)) return null
    const content = readFileSync(head, 'utf-8').trim()
    const match = /^ref: refs\/heads\/(.+)$/.exec(content)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * 系统提示词装配：基础人设 + 工作区声明（多目录，首个为主根）+ 环境块 + 各根 AGENTS.md + 工具使用段。
 */
export function buildSystemPrompt(boundRoots: string[], toolRoots: string[]): string {
  let prompt = 'You are Cogent, a helpful desktop agent.'

  if (boundRoots.length > 0) {
    const declared =
      boundRoots.length === 1
        ? boundRoots[0]
        : `${boundRoots.map((r, i) => `${i + 1}. ${r}`).join('\n')}（首个为主根）`
    prompt += `\n\n# 工作区\n你在用户的本地工作区中工作：${declared}` +
      '\n用户消息里的相对路径（文件/目录）都相对这些根目录解析；未指明时优先主根。'

    prompt += `\n\n# 环境\n- 平台: ${process.platform}`
    for (const root of boundRoots) {
      const branch = readGitBranch(root)
      prompt += `\n- 工作区: ${root}${branch !== null ? `（Git 分支: ${branch}）` : ''}`
    }

    for (const root of boundRoots) {
      const agentsFile = join(root, 'AGENTS.md')
      if (!existsSync(agentsFile)) continue
      try {
        const content = readFileSync(agentsFile, 'utf-8')
        const trimmed = content.length > AGENTS_MD_MAX_CHARS
          ? `${content.slice(0, AGENTS_MD_MAX_CHARS)}\n\n[AGENTS.md 已截断]`
          : content
        const label =
          boundRoots.length > 1 ? `工作区指令（${root} 的 AGENTS.md）` : '工作区指令（AGENTS.md）'
        prompt += `\n\n# ${label}\n${trimmed}`
      } catch (error) {
        process.stderr.write(`[host] AGENTS.md 读取失败（跳过 ${root}）: ${(error as Error).message}\n`)
      }
    }
  }

  const bound = boundRoots.length > 0
  const base =
    bound
      ? '相对路径相对工作区主根解析'
      : `相对路径相对用户主目录（${toolRoots[0]}）解析`
  prompt +=
    '\n\n# 工具\n' +
    '你可以调用工具：read（读单个文件，大文件用 offset/limit 分段读）、find（按通配模式找文件）、' +
    'grep（按正则全文搜索，可带上下文行）、ls（列目录一层内容）、' +
    'write（整文件写入，执行前可能需要用户批准）、' +
    'edit（对已有文件做精确文本替换，执行前可能需要用户批准）、' +
    `${SHELL_TOOL_NAME}（执行 shell 命令，工作目录${bound ? '为工作区主根' : '为用户主目录'}，执行前可能需要用户批准）。` +
    '先用 ls/find/grep 定位、再用 read 读内容；修改已有文件优先 edit（带上下文精确匹配），' +
    '整文件新建或重写才用 write。\n' +
    `${base}；读取的绝对路径不限位置；工作区外的写入可能需要用户批准后执行。`
  return prompt
}

/** 权限模式通告段：三档全设正向文案，经 before_agent_start 注入 cogent_permission section。 */
export function permissionSectionText(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
      return '当前会话处于完全访问模式：所有工具调用直接执行，无需用户逐次确认。'
    case 'autonomous':
      return '当前会话处于自主模式：文件写直接执行（不限工作区）；命令执行仍需用户确认。'
    default:
      return '当前会话处于变更前确认模式：文件写入和命令执行会先请求用户批准，你可以正常尝试调用需要的工具。'
  }
}

/** 计划模式段（开关开启时注入、关闭即撤段）：只读约束 + 调研→submit_plan 工作流。 */
export function planModeSectionText(): string {
  return (
    '当前会话开启了计划模式（只读）：文件写入与命令执行会被拒绝，只能读取文件、搜索和列目录。不要尝试调用写类或执行类工具。\n' +
    '工作流：先用只读工具完成调研；遇到需要用户拍板的疑点用 ask_user 澄清；' +
    '调研充分后调 submit_plan 提交实现计划并等待批准。' +
    '不要用普通文本或 ask_user 问「这个方案可以吗」—— 那正是 submit_plan 的职责。'
  )
}

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
