/**
 * 技能清单 formatter（docs/计划/技能座升级实现.md §3.2）—— 系统提示
 * skills 段的内容源（段由 pi-session-factory 的 before_agent_start 钩子
 * 每回合活算）。
 *
 * 专用 `skill` 工具落地后的清单升级：
 * - 导语明确指引模型调用 `skill` 工具按名加载（不再提示用 read 硬读路径）；
 * - 移除 `<location>` 暴露，省 token 且收敛盘面路径泄露；
 * - 支持可选 `whenToUse` 合并展示，单条描述恒截断 250 chars；
 * - 20k 总预算：超限降级纯 `names-only`（仅 `<name>`），再超截条目 + 省略计数；
 * - 空集返回 null —— 调用方以缺键/空墓碑撤下该段。
 */
import type { Skill } from '@earendil-works/pi-coding-agent'

const MAX_DESCRIPTION_CHARS = 250
const DEFAULT_SECTION_BUDGET = 20_000

/** 供清单展示的技能摘要（兼容 pi Skill 与 SkillStore 扩展元信息） */
export type PromptSkillEntry = Pick<Skill, 'name' | 'description' | 'disableModelInvocation'> & {
  whenToUse?: string
}

/** XML 特殊字符转义 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 导语：指引模型通过专用 `skill` 工具加载技能 */
function headerLines(): string[] {
  return [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    'When a task matches a skill description, call the `skill` tool with its exact name before proceeding.',
    "Resolve relative paths mentioned inside a loaded skill against the skill's base directory.",
    ''
  ]
}

/** 合并 description 与可选 whenToUse 并执行 250 字符截断 */
function formatDescription(skill: PromptSkillEntry): string {
  const when = skill.whenToUse?.trim()
  const combined =
    when !== undefined && when.length > 0 && !skill.description.includes(when)
      ? `${skill.description} (When to use: ${when})`
      : skill.description
  return combined.length > MAX_DESCRIPTION_CHARS
    ? `${combined.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : combined
}

/** 单条技能的 XML 行（namesOnly 档仅保留 name，极省预算） */
function entryLines(skill: PromptSkillEntry, namesOnly: boolean): string[] {
  const lines = ['  <skill>', `    <name>${escapeXml(skill.name)}</name>`]
  if (!namesOnly) {
    lines.push(`    <description>${escapeXml(formatDescription(skill))}</description>`)
  }
  lines.push('  </skill>')
  return lines
}

function render(skills: PromptSkillEntry[], namesOnly: boolean): string {
  const lines = [...headerLines(), '<available_skills>']
  for (const skill of skills) lines.push(...entryLines(skill, namesOnly))
  lines.push('</available_skills>')
  return lines.join('\n')
}

/**
 * 全量渲染（预算内）→ names-only 降级 → 条目截断兜底；
 * `disableModelInvocation` 技能不进清单（仅允许用户显式调用）。
 */
export function formatSkillsSection(skills: PromptSkillEntry[], budget: number = DEFAULT_SECTION_BUDGET): string | null {
  const visible = skills.filter((s) => !s.disableModelInvocation)
  if (visible.length === 0) return null

  const full = render(visible, false)
  if (full.length <= budget) return full

  const namesOnly = render(visible, true)
  if (namesOnly.length <= budget) return namesOnly

  let kept: string[] = []
  for (let i = 0; i < visible.length; i++) {
    const entry = entryLines(visible[i], true)
    const withNote = [
      ...headerLines(),
      '<available_skills>',
      ...kept,
      ...entry,
      '</available_skills>',
      `  <!-- ${visible.length - i - 1} more skills omitted (budget ${budget}) -->`
    ].join('\n')
    if (withNote.length > budget && i > 0) {
      return [
        ...headerLines(),
        '<available_skills>',
        ...kept,
        '</available_skills>',
        `  <!-- ${visible.length - i} more skills omitted (budget ${budget}) -->`
      ].join('\n')
    }
    kept = [...kept, ...entry]
  }
  return [...headerLines(), '<available_skills>', ...kept, '</available_skills>'].join('\n')
}

/**
 * 用户显式点名技能（`$skill` 实体或 `/skill:name args`）的回合提示词组装（对标 zcode `buildManualSkillPrompt`）：
 * 统一引导模型先调用专用 `skill` 工具加载正文，再结合用户正文执行，确保：
 * 1. 手动触发与模型自主触发共享同一条 `skill` 工具调用链与 UI 技能卡；
 * 2. 附带简短问题（如「你能做什么？」）时模型注意力牢牢锚定在刚加载的技能上，不会答偏。
 */
export function buildManualSkillPrompt(skillNames: readonly string[], taskText: string): string {
  const trimmed = taskText.trim()
  const useLine =
    skillNames.length === 1
      ? `Use the skill named \`${skillNames[0]}\` for this turn.`
      : `Use these skills for this turn: ${skillNames.map((n) => `\`${n}\``).join(', ')}.`
  const callLine =
    skillNames.length === 1
      ? `First call the \`skill\` tool with name \`${skillNames[0]}\` before doing the task.`
      : `First call the \`skill\` tool for each of these skills (${skillNames.map((n) => `\`${n}\``).join(', ')}) before doing the task.`
  const taskBlock =
    trimmed.length > 0
      ? `User request:\n${trimmed}`
      : 'No additional user request was provided. Load the skill and respond according to its instructions.'
  return [
    useLine,
    callLine,
    'After the skill content is loaded, follow its instructions and continue.',
    '',
    taskBlock
  ].join('\n')
}
