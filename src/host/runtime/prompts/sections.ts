/**
 * 回合动态系统段装配（提示词工程第一层动态面，docs/计划/提示词工程实现.md）。
 *
 * 顺序纪律（保护 Prefix Cache）：
 * 稳定段在前、高频变化段在后：
 * cogent_outputs → skills → cogent_permission → cogent_plan_active → cogent_plan → cogent_todos。
 * 这样在 `supportsMidConvoSystemMessages: false` 的端点经 pi 折叠回首条 system 消息时，
 * 高频更新的 `cogent_todos` 仅影响系统提示词最尾部。
 */
import type { PermissionMode, TodoItem } from '../../../protocol'

/** 权限模式通告段：三档全设正向文案，切换即替换。 */
export function permissionSectionText(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
      return '当前会话处于完全访问模式：所有工具调用直接执行，无需用户逐次确认。'
    case 'autonomous':
      return '当前会话处于自主模式：文件写入直接执行（不限工作区）；命令执行仍需用户确认。'
    default:
      return '当前会话处于变更前确认模式：文件写入和命令执行会先请求用户批准，可按需正常调用工具。'
  }
}

/** 成品交付段：精简产品语义 + 静默执行约束，去除内部实现术语。 */
export function outputsSectionText(): string {
  return (
    '仅当本轮产出需要单独以文件卡片交给用户的成品文件（如文档、报告、表格、图片、压缩包等）时，' +
    '在最终回复前静默调用 report_outputs 列出完整清单（Markdown 相对依赖一并列入，[] 可撤回全部）。' +
    '普通源码修改、参考阅读或纯聊天不必调用；切勿在回复正文中提及是否已申报或交付状态。'
  )
}

/** 计划模式段（开关开启时注入、关闭即撤段）：只读约束与调研→submit_plan 闭环。 */
export function planModeSectionText(): string {
  return (
    '当前会话开启了计划模式（只读）：文件写入与命令执行会被拒绝，只能读取文件、搜索和列目录，不要尝试调用写类或执行类工具。\n' +
    '工作流：先用只读工具完成调研，必要时用 ask_user 澄清关键疑点；调研充分后调用 submit_plan 提交实现计划等待批准。'
  )
}

export interface DynamicSectionsInput {
  permissionMode: PermissionMode
  planEnabled: boolean
  skillsSection: string | null
  todosSection: string | null
  planSection: string | null
}

/**
 * 构造 before_agent_start 的具名段表（值 null 表示撤段）。
 * 保持从稳定到易变的确定性键序。
 */
export function buildDynamicSections(input: DynamicSectionsInput): Record<string, string | null> {
  return {
    cogent_outputs: outputsSectionText(),
    skills: input.skillsSection,
    cogent_permission: permissionSectionText(input.permissionMode),
    cogent_plan_active: input.planEnabled ? planModeSectionText() : null,
    cogent_plan: input.planSection,
    cogent_todos: input.todosSection
  }
}

/** 动态段标准顺序（供单测与可观测性对照）。 */
export const DYNAMIC_SECTION_ORDER = [
  'cogent_outputs',
  'skills',
  'cogent_permission',
  'cogent_plan_active',
  'cogent_plan',
  'cogent_todos'
] as const

/** 按与 pi `buildSystemPromptSections` 同口径拼出带动态段的系统提示词（供惰性估算回落）。 */
export function renderPromptWithSections(basePrompt: string, cwd: string, sections: Record<string, string | null>): string {
  const parts = [basePrompt, `<cwd>\n${cwd.replace(/\\/g, '/')}\n</cwd>`]
  for (const [name, content] of Object.entries(sections)) {
    if (content !== null && content !== '') {
      parts.push(`<${name}>\n${content}\n</${name}>`)
    }
  }
  return parts.join('\n\n')
}

export type { TodoItem }
