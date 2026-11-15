/**
 * 技能清单 formatter（阶段 4b，docs/计划/技能座实现.md §3.2）—— 系统提示
 * skills 段的内容源（段由 pi-session-factory 的 before_agent_start 钩子
 * 每回合活算，见 factory）。
 *
 * 形状镜像 pi `formatSkillsForPrompt`（reference/pi/.../core/skills.ts:
 * 358-388：英文导语 + `<available_skills>` XML，只给 name/description/
 * location —— 正文靠 read 工具自取 = 渐进加载）。pi 原版无预算控制，
 * 预算模型取 zcode（core/context/sections/skills.ts:8-9,50-57）：
 * - 单条 description 恒截断 250 chars（zcode MAX_DESCRIPTION_CHARS 同款）；
 * - 段总长超 20k chars 降级 names-only（描述全去；location 是 read 入口，
 *   必须保留 —— zcode 的 Skill tool 按 name 调用故可全去，此处不可）；
 * - 降级后仍超预算再截条目数 + 省略计数（路径爆炸的兜底档，zcode 无）。
 *
 * 空集返回 null —— 调用方以 sections.skills = null 清除该段（空墓碑语义，
 * dsh hot-refresh.md:22 同效：全部技能消失时显式撤下旧清单）。
 */
import type { Skill } from '@earendil-works/pi-coding-agent'

const MAX_DESCRIPTION_CHARS = 250
const DEFAULT_SECTION_BUDGET = 20_000

/** pi skills.ts:390-397 同款 XML 转义（形状镜像的一部分，保持一致） */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** pi 导语（skills.ts:365-375 逐行镜像；read 是 Cogent 声明的工具） */
function headerLines(): string[] {
  return [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    ''
  ]
}

/** 单条技能的 XML 行（namesOnly 档去 description，location 恒保留） */
function entryLines(skill: Skill, namesOnly: boolean): string[] {
  const lines = ['  <skill>', `    <name>${escapeXml(skill.name)}</name>`]
  if (!namesOnly) {
    const description =
      skill.description.length > MAX_DESCRIPTION_CHARS
        ? `${skill.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
        : skill.description
    lines.push(`    <description>${escapeXml(description)}</description>`)
  }
  lines.push(`    <location>${escapeXml(skill.filePath)}</location>`, '  </skill>')
  return lines
}

function render(skills: Skill[], namesOnly: boolean): string {
  const lines = [...headerLines(), '<available_skills>']
  for (const skill of skills) lines.push(...entryLines(skill, namesOnly))
  lines.push('</available_skills>')
  return lines.join('\n')
}

/**
 * 全量渲染（预算内）→ names-only 降级 → 条目截断兜底；manualOnly
 * （disable-model-invocation）技能不进清单（pi skills.ts:359 同滤）。
 */
export function formatSkillsSection(skills: Skill[], budget: number = DEFAULT_SECTION_BUDGET): string | null {
  const visible = skills.filter((s) => !s.disableModelInvocation)
  if (visible.length === 0) return null

  const full = render(visible, false)
  if (full.length <= budget) return full

  const namesOnly = render(visible, true)
  if (namesOnly.length <= budget) return namesOnly

  // names-only 仍超：保前缀条目 + 省略计数注释收尾；至少留一枚
  // （单条 names-only 就超预算时整段超一点也认，总比空清单好）
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
