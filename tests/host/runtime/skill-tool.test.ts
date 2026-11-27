/**
 * skill-tool.ts 与 SkillStore.loadForExecution 单元测试：
 * 专用 skill 工具执行、disable-model-invocation 拦截、100KB 字节截断、
 * 附属资源列举与通用变量替换。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SKILL_BYTES, SkillStore } from '../../../src/host/runtime/skill-store'
import { createSkillTool, skillToolDeclaration, summarizeSkillArgs } from '../../../src/host/runtime/skill-tool'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cogent-skill-tool-'))
  dirs.push(dir)
  return dir
}

describe('skill-tool & loadForExecution', () => {
  it('工具声明与参数摘要符合预期', () => {
    const decl = skillToolDeclaration()
    expect(decl.name).toBe('skill')
    expect(decl.description).toContain('<available_skills>')
    expect(summarizeSkillArgs({ name: 'commit-check' })).toBe('skill(commit-check)')
    expect(summarizeSkillArgs({})).toBe('skill()')
  })

  it('通过 skill 工具加载正文、替换路径变量、附带资源清单并拦截 manualOnly', async () => {
    const root = newDir()
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const store = new SkillStore(root, join(root, 'agents'))

    store.save(
      'user',
      undefined,
      'deploy-check',
      '部署检查',
      '运行脚本：python ${CLAUDE_SKILL_DIR}/scripts/run.py --target $1 --proj ${COGENT_PROJECT_DIR}'
    )
    mkdirSync(join(root, 'skills', 'deploy-check', 'scripts'), { recursive: true })
    writeFileSync(join(root, 'skills', 'deploy-check', 'scripts', 'run.py'), 'print("ok")\n')

    store.save('user', undefined, 'manual-only', '仅手动技能', '手动正文', { manualOnly: true })

    const tool = createSkillTool({
      load: (name, args) =>
        store.loadForExecution(name, {
          cwdOrRoots: [ws],
          projectDir: ws,
          sessionId: 'sess-1',
          args,
          requireModelInvocable: true
        })
    })

    const res = await tool.execute('call-1', { name: 'deploy-check', args: 'staging' }, undefined, undefined, {} as never)
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    expect(text).toContain('<skill_content name="deploy-check">')
    expect(text).toContain(`python ${join(root, 'skills', 'deploy-check')}/scripts/run.py --target staging --proj ${ws}`)
    expect(text).toContain('Bundled files:')
    expect(text).toContain('- scripts/run.py')
    expect(text).toContain('</skill_content>')

    // 模型调用路径严禁加载 disable-model-invocation 技能
    await expect(
      tool.execute('call-2', { name: 'manual-only' }, undefined, undefined, {} as never)
    ).rejects.toThrow(/仅手动调用/)
  })

  it('超 100KB 正文按 UTF-8 字节边界安全截断并附截断提示', () => {
    const root = newDir()
    const store = new SkillStore(root, join(root, 'agents'))
    // 多字节中文重复超出 100KB
    const huge = '中'.repeat(Math.ceil(MAX_SKILL_BYTES / 2))
    store.save('user', undefined, 'huge-skill', '大技能', huge)

    const loaded = store.loadForExecution('huge-skill', { requireModelInvocable: true })
    expect(loaded.truncated).toBe(true)
    expect(loaded.content).toContain('[Skill content truncated]')
    expect(loaded.content).not.toContain('\uFFFD')
  })
})
