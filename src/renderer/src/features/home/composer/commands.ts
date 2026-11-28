/**
 * 内置 `/` 命令注册表、会话态门控与提交校验（纯逻辑，零 UI 依赖）。
 * 纪律：
 * - 所有实体仅来自面板选中产生的 Draft.entities，绝不对纯文本做 `$xxx` 或 `/xxx` 隐藏解析；
 * - 只能单独发送的命令（/compact、/continue）禁止与技能实体、附件或前置正文混发。
 */
import type { SkillSummary } from '@/env.d'
import type { McpPromptInfo, McpPromptRef, McpResourceInfo, McpResourceRef } from '@shared/mcp'
import {
  ENTITY_SENTINEL,
  composerEntityText,
  type ComposerEntity,
  type ComposerSuggestionItem,
  type SlashCommandDef
} from './types'

export interface CommandAvailabilityContext {
  isExistingSession: boolean
  hasMessages: boolean
  running: boolean
  compacting: boolean
  truncated: boolean
  hasWorkspace: boolean
}

const COMPACT_INSTRUCTIONS_MAX_CHARS = 2_000

const COMMAND_DEFS: readonly (SlashCommandDef & { available: (ctx: CommandAvailabilityContext) => boolean })[] = [
  {
    id: 'cmd:plan',
    label: '/plan',
    description: '开启计划模式，先出方案审批再动手修改',
    keywords: ['plan', '计划', '计划模式'],
    execution: { kind: 'action', action: 'plan' },
    available: () => true
  },
  {
    id: 'cmd:compact',
    label: '/compact',
    description: '手动压缩当前会话上下文，可附带保留重点说明',
    argumentHint: '[保留重点]',
    standaloneOnly: true,
    keywords: ['compact', '压缩', '整理上下文', '总结上下文'],
    execution: { kind: 'standalone', name: 'compact', acceptsArgs: true },
    available: (ctx) => ctx.isExistingSession && ctx.hasMessages && !ctx.running && !ctx.compacting
  },
  {
    id: 'cmd:continue',
    label: '/continue',
    description: '从上次因长度截断的位置继续生成',
    standaloneOnly: true,
    keywords: ['continue', '续写', '继续生成'],
    execution: { kind: 'standalone', name: 'continue', acceptsArgs: false },
    available: (ctx) => ctx.isExistingSession && ctx.truncated && !ctx.running
  },
  {
    id: 'cmd:init',
    label: '/init',
    description: '检查当前工作区并创建或更新 AGENTS.md 指南',
    argumentHint: '[补充要求]',
    keywords: ['init', '初始化', 'agents', 'AGENTS.md'],
    execution: { kind: 'prompt', name: 'init' },
    available: (ctx) => ctx.hasWorkspace
  },
  {
    id: 'cmd:new',
    label: '/new',
    description: '开启一个新聊天草稿',
    keywords: ['new', 'clear', '新聊天', '新建会话', '清空'],
    execution: { kind: 'action', action: 'new' },
    available: () => true
  },
  {
    id: 'cmd:mode-ask',
    label: '/mode ask',
    description: '切换权限为「写操作前询问」',
    keywords: ['mode', 'permission', 'ask', '权限', '询问'],
    execution: { kind: 'action', action: 'mode-ask' },
    available: () => true
  },
  {
    id: 'cmd:mode-auto',
    label: '/mode auto',
    description: '切换权限为「完全访问」',
    keywords: ['mode', 'permission', 'auto', '权限', '完全访问', '自动'],
    execution: { kind: 'action', action: 'mode-auto' },
    available: () => true
  },
  {
    id: 'cmd:mode-autonomous',
    label: '/mode autonomous',
    description: '切换权限为「自主模式」',
    keywords: ['mode', 'permission', 'autonomous', '权限', '自主'],
    execution: { kind: 'action', action: 'mode-autonomous' },
    available: () => true
  },
  {
    id: 'cmd:rename',
    label: '/rename',
    description: '重命名当前会话标题',
    keywords: ['rename', 'name', '重命名', '标题'],
    execution: { kind: 'action', action: 'rename' },
    available: (ctx) => ctx.isExistingSession && !ctx.running
  },
  {
    id: 'cmd:settings',
    label: '/settings',
    description: '打开应用设置页',
    keywords: ['settings', '设置', '偏好'],
    execution: { kind: 'action', action: 'settings' },
    available: () => true
  }
]

export function buildCommandSuggestions(ctx: CommandAvailabilityContext): ComposerSuggestionItem[] {
  return COMMAND_DEFS.filter((def) => def.available(ctx)).map((def) => ({
    id: def.id,
    group: 'command',
    label: def.label,
    description: def.description,
    badge: def.standaloneOnly ? '单独发送' : def.execution.kind === 'action' ? '快捷操作' : undefined,
    argumentHint: def.argumentHint,
    keywords: def.keywords,
    payload: { kind: 'command', command: def }
  }))
}

export function buildSkillSuggestions(skills: readonly SkillSummary[]): ComposerSuggestionItem[] {
  return skills
    .filter((skill) => skill.enabled && skill.userInvocable !== false)
    .map((skill) => ({
      id: `skill:${skill.scope}:${skill.name}`,
      group: 'skill',
      label: skill.name,
      description: skill.description,
      badge:
        skill.scope === 'bundled'
          ? '内置'
          : skill.eco
            ? '生态'
            : skill.scope === 'project'
              ? '项目'
              : '用户',
      ...(skill.argumentHint !== undefined && { argumentHint: skill.argumentHint }),
      keywords: [
        skill.name,
        skill.description,
        ...(skill.whenToUse !== undefined ? [skill.whenToUse] : []),
        'skill',
        '技能'
      ],
      payload: {
        kind: 'skill',
        name: skill.name,
        scope: skill.scope,
        ...(skill.eco === true && { eco: true })
      }
    }))
}

export function buildMcpResourceSuggestions(resources: readonly McpResourceInfo[]): ComposerSuggestionItem[] {
  return resources.map(resource => ({
    id: `mcp-resource:${resource.server}:${resource.uri}`, group: 'mcp-resource',
    label: `@${resource.server}:${resource.name}`, description: resource.description ?? resource.uri,
    badge: resource.server, keywords: [resource.name, resource.server, resource.uri, 'MCP', '资源'],
    payload: { kind: 'mcp-resource', name: resource.name, server: resource.server, uri: resource.uri }
  }))
}

export function buildMcpPromptSuggestions(prompts: readonly McpPromptInfo[]): ComposerSuggestionItem[] {
  return prompts.map(prompt => ({
    id: `mcp-prompt:${prompt.server}:${prompt.name}`, group: 'mcp-prompt',
    label: `/mcp:${prompt.server}:${prompt.name}`, description: prompt.description ?? '',
    badge: prompt.server, keywords: [prompt.name, prompt.server, 'MCP', '提示词'],
    ...(prompt.arguments !== undefined && { argumentHint: prompt.arguments.map(argument => argument.required ? `<${argument.name}>` : `[${argument.name}]`).join(' ') }),
    payload: { kind: 'mcp-prompt', prompt }
  }))
}

export type PreparedSubmission =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'standalone'; name: 'compact'; instructions?: string }
  | { kind: 'standalone'; name: 'continue' }
  | { kind: 'message'; text: string; skills: string[]; command?: { name: 'init' }; mcpResources?: McpResourceRef[]; mcpPrompts?: McpPromptRef[] }

/**
 * 解析输入区草稿（含 `\uFFFC` 哨兵的 text + 有序 entities）并校验独占命令约束。
 * 纯文本中的 `$foo` 或 `/compact` 不会出现在 entities 中，因此一律走普通消息发送。
 */
export function prepareComposerSubmission(
  rawText: string,
  entities: readonly ComposerEntity[],
  attachmentCount: number
): PreparedSubmission {
  const standaloneEntities = entities.filter(
    (entity): entity is Extract<ComposerEntity, { kind: 'command' }> =>
      entity.kind === 'command' && entity.mode === 'standalone'
  )

  if (standaloneEntities.length > 0) {
    const target = standaloneEntities[0]
    if (entities.length > 1 || attachmentCount > 0) {
      return {
        kind: 'error',
        message: `/${target.name} 只能单独发送，不支持与技能、其他命令或附件混合使用`
      }
    }
    const sentinelIndex = rawText.indexOf(ENTITY_SENTINEL)
    const before = sentinelIndex === -1 ? '' : rawText.slice(0, sentinelIndex).trim()
    const after = sentinelIndex === -1 ? rawText.trim() : rawText.slice(sentinelIndex + 1).trim()
    if (before.length > 0) {
      return {
        kind: 'error',
        message: `/${target.name} 必须位于输入开头并单独发送`
      }
    }
    if (target.name === 'continue') {
      if (after.length > 0) {
        return { kind: 'error', message: '/continue 不接受额外参数，请单独发送' }
      }
      return { kind: 'standalone', name: 'continue' }
    }
    if (after.length > COMPACT_INSTRUCTIONS_MAX_CHARS) {
      return {
        kind: 'error',
        message: `/compact 的压缩说明不能超过 ${COMPACT_INSTRUCTIONS_MAX_CHARS} 字符`
      }
    }
    return {
      kind: 'standalone',
      name: 'compact',
      ...(after.length > 0 && { instructions: after })
    }
  }

  const promptCommands = entities.filter(
    (entity): entity is Extract<ComposerEntity, { kind: 'command' }> =>
      entity.kind === 'command' && entity.mode === 'prompt'
  )
  if (promptCommands.length > 1) {
    return { kind: 'error', message: '单条消息最多只能包含一个命令实体' }
  }

  const skills = [
    ...new Set(
      entities
        .filter((entity): entity is Extract<ComposerEntity, { kind: 'skill' }> => entity.kind === 'skill')
        .map((entity) => entity.name)
    )
  ]
  const mcpResources = entities.filter((entity): entity is Extract<ComposerEntity, { kind: 'mcp-resource' }> => entity.kind === 'mcp-resource')
    .map(({ server, uri }) => ({ server, uri }))
  const mcpPrompts = entities.filter((entity): entity is Extract<ComposerEntity, { kind: 'mcp-prompt' }> => entity.kind === 'mcp-prompt')
    .map(({ server, name, arguments: args }) => ({ server, name, ...(args !== undefined && { arguments: args }) }))
  let entityIndex = 0
  const cleanText = rawText.replaceAll(ENTITY_SENTINEL, () => {
    const entity = entities.at(entityIndex++)
    return entity?.kind === 'mcp-resource' || entity?.kind === 'mcp-prompt' ? composerEntityText(entity) : ''
  }).trim()
  const firstPrompt = promptCommands.at(0)
  const command = firstPrompt !== undefined ? { name: firstPrompt.name as 'init' } : undefined

  if (cleanText.length === 0 && skills.length === 0 && command === undefined && attachmentCount === 0) {
    return { kind: 'empty' }
  }

  return {
    kind: 'message',
    text: cleanText,
    skills,
    ...(mcpResources.length > 0 && { mcpResources }),
    ...(mcpPrompts.length > 0 && { mcpPrompts }),
    ...(command !== undefined && { command })
  }
}
