/**
 * skill-store.ts 单元测试（docs/模块/测试.md）—— store 的纯逻辑面：
 * 发现合并（同名 project 胜 + 冲突诊断）、两级启停求值、save/delete 守卫、
 * 损坏状态文件诊断、/skill: 活展开。与 tests/integration/skills.test.ts 的
 * 黑盒端到端（真实装配 + 段热刷新 + read 渐进加载）互补。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillStore } from './skill-store'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const newRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cogent-skill-store-'))
  roots.push(dir)
  return dir
}

/** 手放一枚技能（不经 save —— 模拟用户手写/拷贝的文件） */
const placeSkill = (dir: string, name: string, description: string, body = '正文'): void => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

describe('SkillStore', () => {
  it('save → list 往返：frontmatter 由引擎生成（盘上断言）+ 摘要字段', () => {
    const root = newRoot()
    const store = new SkillStore(root)
    store.save('user', undefined, 'commit-check', '提交前检查清单', '1. 跑测试')
    const onDisk = readFileSync(join(root, 'skills', 'commit-check', 'SKILL.md'), 'utf8')
    expect(onDisk).toBe('---\nname: "commit-check"\ndescription: "提交前检查清单"\n---\n\n1. 跑测试\n')
    const { skills, errors } = store.list()
    expect(errors).toEqual([])
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'commit-check',
      description: '提交前检查清单',
      scope: 'user',
      manualOnly: false,
      enabled: true,
      userDisabled: false
    })
    expect(skills[0].path).toBe(join(root, 'skills', 'commit-check', 'SKILL.md'))
  })

  it('同名冲突：project 胜出 + 冲突诊断（zcode nearest-wins）', () => {
    const root = newRoot()
    const ws = join(root, 'ws')
    mkdirSync(join(ws, '.cogent', 'skills'), { recursive: true })
    placeSkill(join(root, 'skills'), 'dup', 'user 版')
    placeSkill(join(ws, '.cogent', 'skills'), 'dup', 'project 版')
    const store = new SkillStore(root)
    const { skills, errors } = store.list(ws)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('dup')
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ scope: 'project', description: 'project 版' })
  })

  it('两级启停求值：user 禁 / project 覆盖禁 / project 重启用 / inherit 回落', () => {
    const root = newRoot()
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const store = new SkillStore(root)
    store.save('user', undefined, 'a', 'user 技能', '')
    store.save('user', undefined, 'b', '被项目禁的 user 技能', '')
    store.save('user', undefined, 'c', '被 user 禁又被项目启的技能', '')

    // user 禁 a：snapshot 过滤 + list 亮状态
    store.setEnabled('user', undefined, 'a', 'disabled')
    expect(store.snapshot(ws).skills.map((s) => s.name)).toEqual(['b', 'c'])
    const listed = store.list(ws)
    expect(listed.skills.find((s) => s.name === 'a')).toMatchObject({ enabled: false, userDisabled: true })

    // project 禁 b（覆盖 user 名单求值）
    store.setEnabled('project', ws, 'b', 'disabled')
    // project 重启用 c（user 已禁，近者胜）
    store.setEnabled('user', undefined, 'c', 'disabled')
    store.setEnabled('project', ws, 'c', 'enabled')
    expect(store.snapshot(ws).skills.map((s) => s.name)).toEqual(['c'])
    const merged = store.list(ws)
    expect(merged.skills.find((s) => s.name === 'b')).toMatchObject({ enabled: false, override: false })
    expect(merged.skills.find((s) => s.name === 'c')).toMatchObject({ enabled: true, userDisabled: true, override: true })

    // inherit：清除 c 的项目覆盖 → 回落 user 名单（禁）
    store.setEnabled('project', ws, 'c', 'inherit')
    expect(store.snapshot(ws).skills).toEqual([])
  })

  it('save/delete 守卫：非法名（含路径逃逸形状）/ 空描述 / 不存在删除', () => {
    const root = newRoot()
    const store = new SkillStore(root)
    expect(() => store.save('user', undefined, '../escape', 'd', 'b')).toThrow(/名字|name|连字符|小写/)
    expect(() => store.save('user', undefined, 'UPPER', 'd', 'b')).toThrow()
    expect(() => store.save('user', undefined, 'ok', '  ', 'b')).toThrow(/description/)
    expect(() => store.save('project', undefined, 'ok', 'd', 'b')).toThrow(/cwd/)
    expect(() => store.delete('user', undefined, 'missing')).toThrow(/不存在/)
    // project 档缺 cwd 同样拒绝
    expect(() => store.setEnabled('project', undefined, 'x', 'disabled')).toThrow(/cwd|不存在/)
  })

  it('delete 清理同级状态 + user 档 inherit 拒绝', () => {
    const root = newRoot()
    const store = new SkillStore(root)
    store.save('user', undefined, 'gone', 'd', '')
    store.setEnabled('user', undefined, 'gone', 'disabled')
    expect(() => store.setEnabled('user', undefined, 'gone', 'inherit')).toThrow(/inherit/)
    store.delete('user', undefined, 'gone')
    // 名单同步清理（重写同名技能后默认启用）
    store.save('user', undefined, 'gone', 'd', '')
    expect(store.list().skills[0].enabled).toBe(true)
  })

  it('损坏状态文件与坏 frontmatter：诊断带回，求值不炸', () => {
    const root = newRoot()
    writeFileSync(join(root, 'skills.json'), '{bad json')
    placeSkill(join(root, 'skills'), 'broken', 'd')
    // 坏 YAML frontmatter（name 是半个数组字面量 → yaml 解析报错）
    mkdirSync(join(root, 'skills', 'badyaml'), { recursive: true })
    writeFileSync(join(root, 'skills', 'badyaml', 'SKILL.md'), '---\nname: [broken\n---\n\n正文\n')
    const store = new SkillStore(root)
    const { skills, errors } = store.list()
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.some((e) => e.includes('skills.json'))).toBe(true)
    // 合法技能不受影响
    expect(skills.map((s) => s.name)).toContain('broken')
  })

  it('/skill: 活展开：命中展开（形状镜像 pi）/ manualOnly 可展开 / 禁用与未命中原样', () => {
    const root = newRoot()
    const store = new SkillStore(root)
    store.save('user', undefined, 'guide', '怎么做事', '第一步…第二步…')
    const expanded = store.expandSkillCommand('/skill:guide 做某事', join(root, 'ws'))
    expect(expanded).toContain('<skill name="guide"')
    expect(expanded).toContain('References are relative to')
    expect(expanded).toContain('第一步…第二步…')
    expect(expanded.endsWith('做某事')).toBe(true)
    // 纯调用无 args：块结尾
    expect(store.expandSkillCommand('/skill:guide').endsWith('</skill>')).toBe(true)
    // 未命中 + 无前缀：原样
    expect(store.expandSkillCommand('/skill:nope x')).toBe('/skill:nope x')
    expect(store.expandSkillCommand('普通消息')).toBe('普通消息')
    // 禁用 = 视为不存在
    store.setEnabled('user', undefined, 'guide', 'disabled')
    expect(store.expandSkillCommand('/skill:guide')).toBe('/skill:guide')
    // manualOnly（frontmatter 声明）仍可手动展开 —— 这正是它存在的意义
    store.setEnabled('user', undefined, 'guide', 'enabled')
    mkdirSync(join(root, 'skills', 'manual'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'manual', 'SKILL.md'),
      '---\nname: manual\ndescription: d\ndisable-model-invocation: true\n---\n\n手动态正文\n'
    )
    expect(store.expandSkillCommand('/skill:manual')).toContain('手动态正文')
  })
})
