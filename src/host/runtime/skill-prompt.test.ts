/**
 * skill-prompt.ts 单元测试（docs/模块/测试.md）—— formatter 的预算模型：
 * pi XML 形状镜像、单条 250 截断、总预算降级 names-only、条目截断兜底、
 * manualOnly 过滤、XML 转义。
 */
import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { formatSkillsSection } from './skill-prompt'

const skill = (name: string, description: string, extra: Partial<Skill> = {}): Skill => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
  sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: 'user' }),
  disableModelInvocation: false,
  ...extra
})

describe('formatSkillsSection', () => {
  it('形状镜像 pi formatSkillsForPrompt：导语 + <available_skills> XML', () => {
    const section = formatSkillsSection([skill('a', '做事甲'), skill('b', '做事乙')])
    expect(section).toContain('The following skills provide specialized instructions for specific tasks.')
    expect(section).toContain('<available_skills>')
    expect(section).toContain('  <skill>')
    expect(section).toContain('    <name>a</name>')
    expect(section).toContain('    <description>做事甲</description>')
    expect(section).toContain('    <location>/skills/a/SKILL.md</location>')
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

  it('XML 特殊字符转义（形状与 pi 一致）', () => {
    const section = formatSkillsSection([skill('esc', '含 <标签> & "引号"')])
    expect(section).toContain('含 &lt;标签&gt; &amp; &quot;引号&quot;')
  })

  it('总预算超限降级 names-only（description 全去，location 保留）', () => {
    // 60 枚 × 约 350 chars description ≈ 21k > 20k 预算
    const many = Array.from({ length: 60 }, (_, i) => skill(`s${i}`, `${i}号技能——${'详'.repeat(330)}`))
    const section = formatSkillsSection(many, 20_000)
    expect(section).not.toContain('<description>')
    expect(section).toContain('<name>s0</name>')
    expect(section).toContain('<location>/skills/s0/SKILL.md</location>')
  })

  it('names-only 仍超预算：截条目 + 省略计数（至少留一枚）', () => {
    // 长路径技能：names-only 也超小预算
    const fat = Array.from({ length: 30 }, (_, i) => skill(`s${i}`, 'd', {
      filePath: `/very/long/${'p'.repeat(60)}/dir${i}/SKILL.md`
    }))
    const section = formatSkillsSection(fat, 700)
    expect(section).not.toBeNull()
    expect(section).toMatch(/<!-- \d+ more skills omitted \(budget 700\) -->/)
    // 至少一枚保留
    expect(section).toContain('<name>s0</name>')
    expect(section!.length).toBeLessThanOrEqual(700 + 200) // 兜底档允许留一枚略超
  })
})
