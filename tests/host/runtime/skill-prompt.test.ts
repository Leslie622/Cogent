/**
 * skill-prompt.ts 单元测试（docs/模块/测试.md）—— formatter 的预算模型：
 * 专用 `skill` 工具导语、无 <location> 暴露、whenToUse 合并、单条 250 截断、
 * 总预算降级纯 names-only、条目截断兜底、manualOnly 过滤、XML 转义。
 */
import { describe, expect, it } from 'vitest'
import { buildManualSkillPrompt, formatSkillsSection, type PromptSkillEntry } from '../../../src/host/runtime/skill-prompt'

const skill = (name: string, description: string, extra: Partial<PromptSkillEntry> = {}): PromptSkillEntry => ({
  name,
  description,
  disableModelInvocation: false,
  ...extra
})

describe('formatSkillsSection', () => {
  it('指引调用 skill 工具且不暴露磁盘路径 <location>', () => {
    const section = formatSkillsSection([
      skill('a', '做事甲', { whenToUse: '遇到甲任务时' }),
      skill('b', '做事乙')
    ])
    expect(section).toContain('call the `skill` tool with its exact name')
    expect(section).toContain('<available_skills>')
    expect(section).toContain('  <skill>')
    expect(section).toContain('    <name>a</name>')
    expect(section).toContain('    <description>做事甲 (When to use: 遇到甲任务时)</description>')
    expect(section).not.toContain('<location>')
    expect(section).toContain('</available_skills>')
  })

  it('空集与 manualOnly-only 都返回 null（清段）', () => {
    expect(formatSkillsSection([])).toBeNull()
    expect(formatSkillsSection([skill('m', '手动态', { disableModelInvocation: true })])).toBeNull()
  })

  it('单条 description 超 250 截断（带省略号，总长不超限）', () => {
    const long = 'x'.repeat(300)
    const section = formatSkillsSection([skill('big', long)])
    expect(section).toContain(`<description>${'x'.repeat(249)}…</description>`)
    expect(section).not.toContain('x'.repeat(250))
  })

  it('XML 特殊字符转义', () => {
    const section = formatSkillsSection([skill('esc', '含 <标签> & "引号"')])
    expect(section).toContain('含 &lt;标签&gt; &amp; &quot;引号&quot;')
  })

  it('总预算超限降级纯 names-only（仅保留 <name>）', () => {
    const many = Array.from({ length: 100 }, (_, i) => skill(`s${i}`, `${i}号技能——${'详'.repeat(240)}`))
    const section = formatSkillsSection(many, 20_000)
    expect(section).not.toContain('<description>')
    expect(section).toContain('<name>s0</name>')
    expect(section).toContain('<name>s99</name>')
  })

  it('names-only 仍超预算：截条目 + 省略计数（至少留一枚）', () => {
    const fat = Array.from({ length: 50 }, (_, i) => skill(`very-long-skill-name-number-${i}`, 'd'))
    const section = formatSkillsSection(fat, 700)
    expect(section).not.toBeNull()
    expect(section).toMatch(/<!-- \d+ more skills omitted \(budget 700\) -->/)
    expect(section).toContain('<name>very-long-skill-name-number-0</name>')
    expect(section!.length).toBeLessThanOrEqual(700 + 200)
  })
})

describe('buildManualSkillPrompt', () => {
  it('单技能 + 附带问题：先调 skill 工具再处理用户请求', () => {
    const prompt = buildManualSkillPrompt(['skill-creator'], '你能做什么？')
    expect(prompt).toContain('Use the skill named `skill-creator` for this turn.')
    expect(prompt).toContain('First call the `skill` tool with name `skill-creator` before doing the task.')
    expect(prompt).toContain('User request:\n你能做什么？')
  })

  it('单技能无附带文字：提示直接加载并按技能说明回复', () => {
    const prompt = buildManualSkillPrompt(['skill-creator'], '   ')
    expect(prompt).toContain('No additional user request was provided.')
  })

  it('多技能组合：要求依次调用 skill 工具', () => {
    const prompt = buildManualSkillPrompt(['a', 'b'], '一起处理')
    expect(prompt).toContain('`a`, `b`')
    expect(prompt).toContain('User request:\n一起处理')
  })
})
