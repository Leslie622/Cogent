/**
 * skill-store.ts 单元测试（docs/模块/测试.md）—— store 的纯逻辑面：
 * 发现合并（同名 project 胜 + 冲突诊断）、两级启停求值、save/delete 守卫、
 * 损坏状态文件诊断、/skill: 活展开。与 tests/integration/skills.test.ts 的
 * 黑盒端到端（真实装配 + 段热刷新 + read 渐进加载）互补。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillStore } from '../../../src/host/runtime/skill-store'

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
    const store = new SkillStore(root, join(root, 'agents'))
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
    const store = new SkillStore(root, join(root, 'agents'))
    const { skills, errors } = store.list(ws)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('dup')
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      scope: 'project',
      description: 'project 版'
    })
    expect(skills[0].diagnostics).toHaveLength(1)
    expect(skills[0].diagnostics?.[0]?.severity).toBe('warning')
    expect(skills[0].diagnostics?.[0]?.message).toContain('已覆盖低优先级同名技能')
  })

  it('生态兼容目录：.agents/skills 两级发现 + eco 标记 + 同名自有目录胜', () => {
    const root = newRoot()
    const ws = join(root, 'ws')
    const store = new SkillStore(root, join(root, 'agents'))
    // 两级生态目录各一枚（zcode 等工具装的形状）
    placeSkill(join(root, 'agents', 'skills'), 'zcode-tool', '生态工具')
    placeSkill(join(ws, '.agents', 'skills'), 'proj-eco', '项目生态')
    // 同名三级竞争：同级别 .cogent 胜 .agents；级别优先（项目生态胜用户自有）
    placeSkill(join(root, 'agents', 'skills'), 'dup', '生态版')
    placeSkill(join(root, 'skills'), 'dup', '自有版')
    placeSkill(join(ws, '.agents', 'skills'), 'cross', '项目生态')
    placeSkill(join(root, 'skills'), 'cross', '用户自有')
    const { skills, errors } = store.list(ws)
    const byName = new Map(skills.map((s) => [s.name, s]))
    expect(byName.get('zcode-tool')).toMatchObject({ eco: true, scope: 'user', enabled: true })
    expect(byName.get('proj-eco')).toMatchObject({ eco: true, scope: 'project' })
    // 同名自有胜（无 eco 标记 = 胜者按 filePath 判，不误标）
    expect(byName.get('dup')).toMatchObject({ description: '自有版' })
    expect(byName.get('dup')?.eco).toBeUndefined()
    // 级别优先：项目生态版胜用户自有版
    expect(byName.get('cross')).toMatchObject({ description: '项目生态', eco: true })
    // 被覆盖的生态版也进冲突诊断（dup：自有胜生态；cross：项目生态胜用户自有）
    expect(errors.filter((e) => e.includes('同名冲突'))).toHaveLength(2)
  })

  it('生态技能可按名启停与 /skill: 展开（只读发现语义）', () => {
    const root = newRoot()
    const store = new SkillStore(root, join(root, 'agents'))
    placeSkill(join(root, 'agents', 'skills'), 'eco-tool', '生态工具', '生态正文')
    // 进清单（snapshot）且可手动展开
    expect(store.snapshot().skills.map((s) => s.name)).toEqual(['eco-tool'])
    expect(store.expandSkillCommand('/skill:eco-tool 去做')).toContain('生态正文')
    // 按名启停走同一状态文件（禁用 = 清单消失 + 展开视为不存在）
    store.setEnabled('user', undefined, 'eco-tool', 'disabled')
    expect(store.snapshot().skills).toEqual([])
    expect(store.expandSkillCommand('/skill:eco-tool')).toBe('/skill:eco-tool')
    // 删除不可达（写路径只在 .cogent，生态目录没有该名 → 显式报不存在）
    expect(() => store.delete('user', undefined, 'eco-tool')).toThrow(/不存在/)
  })

  it('两级启停求值：user 禁 / project 覆盖禁 / project 重启用 / inherit 回落', () => {
    const root = newRoot()
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const store = new SkillStore(root, join(root, 'agents'))
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
    const store = new SkillStore(root, join(root, 'agents'))
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
    const store = new SkillStore(root, join(root, 'agents'))
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
    const store = new SkillStore(root, join(root, 'agents'))
    const { skills, errors, stateErrors } = store.list()
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.some((e) => e.includes('skills.json'))).toBe(true)
    expect(stateErrors?.some((e) => e.includes('skills.json'))).toBe(true)
    // 合法技能不受影响；坏 YAML 技能以不可用行内错误呈现且默认不启用、不进运行时快照
    expect(skills.find((s) => s.name === 'broken')).toMatchObject({ enabled: true })
    const badYaml = skills.find((s) => s.name === 'badyaml')
    expect(badYaml).toMatchObject({
      invalid: true,
      enabled: false,
      editable: false
    })
    expect(badYaml?.diagnostics).toHaveLength(1)
    expect(badYaml?.diagnostics?.[0]?.severity).toBe('error')
    expect(badYaml?.diagnostics?.[0]?.message).toContain('解析失败')
    expect(store.snapshot().skills.map((s) => s.name)).toEqual(['broken'])
  })

  it('行内警告与不可用错误：非法名仍可用且可启停删除，缺描述默认不启用并可修复/删除', () => {
    const root = newRoot()
    mkdirSync(join(root, 'skills', 'PDF助手'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'PDF助手', 'SKILL.md'),
      '---\nname: "PDF助手"\ndescription: "处理 PDF 文档"\n---\n\nPDF 正文\n'
    )
    mkdirSync(join(root, 'skills', 'test-broken'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'test-broken', 'SKILL.md'),
      '---\nname: test-broken\n---\n\n待补充描述的正文\n'
    )

    const store = new SkillStore(root, join(root, 'agents'))
    const listed = store.list()
    const pdfSkill = listed.skills.find((s) => s.name === 'PDF助手')
    const brokenSkill = listed.skills.find((s) => s.name === 'test-broken')

    expect(pdfSkill).toMatchObject({
      enabled: true,
      editable: false
    })
    expect(pdfSkill?.diagnostics).toHaveLength(1)
    expect(pdfSkill?.diagnostics?.[0]?.severity).toBe('warning')
    expect(pdfSkill?.diagnostics?.[0]?.message).toContain('名称含不支持的字符')
    expect(pdfSkill?.invalid).toBeUndefined()

    expect(brokenSkill).toMatchObject({
      invalid: true,
      enabled: false,
      editable: true
    })
    expect(brokenSkill?.diagnostics).toHaveLength(1)
    expect(brokenSkill?.diagnostics?.[0]?.severity).toBe('error')
    expect(brokenSkill?.diagnostics?.[0]?.message).toContain('缺少必填的 description')
    // 运行时快照只含可用技能，不含缺 description 的不可用技能
    expect(store.snapshot().skills.map((s) => s.name)).toEqual(['PDF助手'])

    // 警告技能可启停、可读、可定位目录、可删除
    store.setEnabled('user', undefined, 'PDF助手', 'disabled')
    expect(store.list().skills.find((s) => s.name === 'PDF助手')?.enabled).toBe(false)
    expect(store.read('user', undefined, 'PDF助手').body).toBe('PDF 正文')
    expect(store.revealDir('user', undefined, 'PDF助手')).toContain('PDF助手')
    store.delete('user', undefined, 'PDF助手')
    expect(store.list().skills.some((s) => s.name === 'PDF助手')).toBe(false)

    // 不可用技能禁止启用，但支持读取补齐修复或直接删除
    expect(() => store.setEnabled('user', undefined, 'test-broken', 'enabled')).toThrow(/不存在|不可启用/)
    expect(store.read('user', undefined, 'test-broken')).toMatchObject({
      description: '',
      body: '待补充描述的正文'
    })
    store.save('user', undefined, 'test-broken', '已补齐的描述', '待补充描述的正文')
    const fixed = store.list().skills.find((s) => s.name === 'test-broken')
    expect(fixed).toMatchObject({ enabled: true })
    expect(fixed?.invalid).toBeUndefined()
    expect(fixed?.diagnostics).toBeUndefined()

    // 坏 YAML 的不可用技能也支持直接从 store 删除
    mkdirSync(join(root, 'skills', 'badyaml'), { recursive: true })
    writeFileSync(join(root, 'skills', 'badyaml', 'SKILL.md'), '---\nname: [broken\n---\n\n正文\n')
    expect(store.list().skills.find((s) => s.name === 'badyaml')?.invalid).toBe(true)
    store.delete('user', undefined, 'badyaml')
    expect(store.list().skills.some((s) => s.name === 'badyaml')).toBe(false)
  })

  it('/skill: 活展开：统一走 <skill_content> 与变量替换 / manualOnly 可展开 / 禁用与未命中原样', () => {
    const root = newRoot()
    const store = new SkillStore(root, join(root, 'agents'))
    store.save('user', undefined, 'guide', '怎么做事', '第一步…目录=${COGENT_SKILL_DIR}…参数=$ARGUMENTS')
    const expanded = store.expandSkillCommand('/skill:guide 做某事', join(root, 'ws'))
    expect(expanded).toContain('<skill_content name="guide">')
    expect(expanded).toContain('Base directory for this skill:')
    expect(expanded).toContain(`目录=${join(root, 'skills', 'guide')}`)
    expect(expanded).toContain('参数=做某事')
    // 纯调用无 args：块结尾
    expect(store.expandSkillCommand('/skill:guide').endsWith('</skill_content>')).toBe(true)
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

  it('expandSkillsByName：按名活展开多枚技能；禁用或不存在显式报错', () => {
    const root = newRoot()
    const ws = join(root, 'ws')
    const store = new SkillStore(root, join(root, 'agents'))
    store.save('user', undefined, 'alpha', '技能 A', '正文 A')
    store.save('user', undefined, 'beta', '技能 B', '正文 B')
    const blocks = store.expandSkillsByName(['alpha', 'beta'], [ws])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('<skill_content name="alpha">')
    expect(blocks[0]).toContain('正文 A')
    expect(blocks[1]).toContain('<skill_content name="beta">')
    expect(blocks[1]).toContain('正文 B')

    store.setEnabled('user', undefined, 'beta', 'disabled')
    expect(() => store.expandSkillsByName(['beta'], [ws])).toThrow(/不存在或已禁用/)
    expect(() => store.expandSkillsByName(['missing'], [ws])).toThrow(/不存在或已禁用/)
  })

  it('7 级优先级：bundled 垫底、.claude 兼容、monorepo 祖先向上扫至 .git 根', () => {
    const root = newRoot()
    const bundled = join(root, 'bundled')
    const claude = join(root, 'claude')
    const repo = join(root, 'repo')
    const sub = join(repo, 'packages', 'app')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })

    placeSkill(bundled, 'shared', 'bundled 版')
    placeSkill(bundled, 'only-bundled', '纯内置技能')
    placeSkill(join(claude, 'skills'), 'claude-user', '用户 claude')
    placeSkill(join(repo, '.cogent', 'skills'), 'ancestor', '仓库根技能')
    placeSkill(join(repo, '.claude', 'skills'), 'shared', '仓库 claude 版')
    placeSkill(join(sub, '.cogent', 'skills'), 'shared', '子包 cogent 版')

    const store = new SkillStore(root, join(root, 'agents'), { claudeRoot: claude, bundledDir: bundled })
    const listed = store.list(sub)
    const byName = new Map(listed.skills.map((s) => [s.name, s]))

    expect(byName.get('only-bundled')).toMatchObject({ scope: 'bundled', origin: 'bundled', readonly: true, enabled: true })
    expect(byName.get('claude-user')).toMatchObject({ scope: 'user', origin: 'claude', eco: true, readonly: true })
    expect(byName.get('ancestor')).toMatchObject({ scope: 'project', origin: 'cogent', description: '仓库根技能' })
    expect(byName.get('shared')).toMatchObject({ scope: 'project', origin: 'cogent', description: '子包 cogent 版' })
    expect(() => store.delete('bundled', undefined, 'only-bundled')).toThrow(/不可删除/)
  })

  it('save 无损保留既有 frontmatter 扩展字段，且支持高级字段读写', () => {
    const root = newRoot()
    const store = new SkillStore(root, join(root, 'agents'))
    mkdirSync(join(root, 'skills', 'rich'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'rich', 'SKILL.md'),
      [
        '---',
        'name: rich',
        'description: 旧描述',
        'license: Apache-2.0',
        'compatibility: Node >= 22',
        'allowed-tools: Read Bash(git diff *)',
        'context: fork',
        'metadata:',
        '  author: team-a',
        '---',
        '',
        '旧正文'
      ].join('\n')
    )

    const before = store.read('user', undefined, 'rich')
    expect(before).toMatchObject({
      license: 'Apache-2.0',
      compatibility: 'Node >= 22',
      allowedTools: ['Read', 'Bash(git diff *)'],
      unsupportedRuntime: 'context-fork'
    })

    // 通过 save 编辑描述、正文和高级开关后，license / allowed-tools / context / metadata 全部无损保留
    store.save('user', undefined, 'rich', '新描述', '新正文', {
      whenToUse: '审查代码时',
      manualOnly: true,
      userInvocable: false,
      argumentHint: '[路径]'
    })
    const after = store.read('user', undefined, 'rich')
    expect(after).toMatchObject({
      description: '新描述',
      body: '新正文',
      whenToUse: '审查代码时',
      manualOnly: true,
      userInvocable: false,
      argumentHint: '[路径]',
      license: 'Apache-2.0',
      compatibility: 'Node >= 22',
      allowedTools: ['Read', 'Bash(git diff *)'],
      unsupportedRuntime: 'context-fork'
    })
    const raw = readFileSync(join(root, 'skills', 'rich', 'SKILL.md'), 'utf8')
    expect(raw).toContain('author: "team-a"')
  })

  it('导入导出闭环：目录与 zip 导入、导出 .zip、冲突保护、以及 zip 路径穿越拒绝', () => {
    const root = newRoot()
    const store = new SkillStore(root, join(root, 'agents'))

    // 1. 构造待导入目录（含附属脚本）
    const srcDir = join(root, 'import-src', 'pack-skill')
    mkdirSync(join(srcDir, 'scripts'), { recursive: true })
    writeFileSync(join(srcDir, 'SKILL.md'), '---\nname: pack-skill\ndescription: 打包技能\n---\n\n正文内容\n')
    writeFileSync(join(srcDir, 'scripts', 'helper.sh'), 'echo hi\n')

    const dirRes = store.importFromPath('user', undefined, srcDir)
    expect(dirRes).toEqual({ imported: ['pack-skill'], skipped: [] })
    expect(store.read('user', undefined, 'pack-skill').resourceFiles).toEqual(['scripts/helper.sh'])

    // 2. 同名默认不覆盖报错，overwrite=true 允许覆盖
    expect(() => store.importFromPath('user', undefined, srcDir, false)).toThrow(/覆盖导入/)
    expect(store.importFromPath('user', undefined, srcDir, true).imported).toEqual(['pack-skill'])

    // 3. 导出为 .zip，再导入到另一个项目作用域
    const exportedZip = join(root, 'pack-skill.zip')
    store.exportToZip('user', undefined, 'pack-skill', exportedZip)
    const ws = join(root, 'ws-export')
    mkdirSync(ws, { recursive: true })
    const zipRes = store.importFromPath('project', ws, exportedZip)
    expect(zipRes).toEqual({ imported: ['pack-skill'], skipped: [] })
    expect(store.read('project', ws, 'pack-skill').resourceFiles).toEqual(['scripts/helper.sh'])

    // 4. 恶意路径穿越 zip 必须拒绝
    const evilZip = join(root, 'evil.zip')
    writeFileSync(
      evilZip,
      zipSync({
        '../escape/SKILL.md': new TextEncoder().encode('---\nname: evil\ndescription: bad\n---\n\nx')
      })
    )
    expect(() => store.importFromPath('user', undefined, evilZip)).toThrow(/非法路径/)
  })
})
