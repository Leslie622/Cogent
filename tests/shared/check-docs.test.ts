/** 文档检查会进 CI，自身失效就是静默放行；用夹具确认它认得真实错误且不误伤示例。 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'

const cli = resolve('scripts/check-docs.mjs')
const created: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cogent-docs-'))
  created.push(root)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return root
}

function check(root: string) {
  return spawnSync(process.execPath, [cli, root], { encoding: 'utf8' })
}

// 夹具里的章节引用用变量拼出，否则本文件会被文档检查当成真实引用。
const mark = '§'

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('真实链接、锚点与章节引用通过，围栏、行内代码与本地参照里的链接不检查', () => {
  const root = fixture({
    'AGENTS.md': [
      '# 入口',
      '',
      `见[约定](docs/约定.md#2-协议)与[笔记](docs/笔记.md)和[方案](docs/计划/方案.md)。`,
      '',
      '```md',
      '[示例](./不存在.md)',
      '```',
      '',
      '行内 `[示例](./也没有.md)` 不是链接。参照仓未克隆时[出处](reference/upstream/README.md#L3) 也放行。',
      ''
    ].join('\n'),
    'docs/约定.md': '# 约定\n\n## 2. 协议\n\n正文。\n',
    'docs/计划/方案.md': `# 方案\n\n这是不属于约定.md ${mark}2，另见 ../约定.md ${mark}2。\n`,
    'docs/笔记.md': '# 笔记\n\n## 细节\n\n[约定](约定.md#2-协议) · [源码](../src/a.ts#L4)\n',
    'src/a.ts': `/** 见 docs/约定.md ${mark}2 与 约定 ${mark}2。 */\nexport const a = 1\n// 1\n// 2\n`
  })
  const result = check(root)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('4 个文档，5 个链接，4 处章节引用')
})

it('死链、坏锚点、越界行号、不可达文档与失效章节引用各自报错', () => {
  const root = fixture({
    'AGENTS.md': '# 入口\n\n[坏锚点](docs/约定.md#不存在) · [死链](docs/没有.md) · [越界行](src/a.ts#L99)\n',
    'docs/约定.md': '# 约定\n\n## 1. 边界\n',
    'docs/孤岛.md': '# 没有入口链接到这里\n',
    'src/a.ts': `/** 见 docs/约定.md ${mark}9 和 docs/缺失.md ${mark}1。 */\nexport const a = 1\n`
  })
  const result = check(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('锚点不存在：docs/约定.md#不存在')
  expect(result.stderr).toContain('链接目标不存在：docs/没有.md')
  expect(result.stderr).toContain('行号超出文件：src/a.ts#L99')
  expect(result.stderr).toContain('没有入口可达：docs/孤岛.md')
  expect(result.stderr).toContain(`章节不存在：约定.md ${mark}9`)
  expect(result.stderr).toContain(`引用的文档不存在：缺失.md ${mark}1`)
})

it('行数超出预算只提示，不判失败', () => {
  const root = fixture({
    'AGENTS.md': '[模块](docs/模块/长页.md)\n',
    'docs/模块/长页.md': '# 长页\n\n' + '正文\n'.repeat(90)
  })
  const result = check(root)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('docs/模块/长页.md 92 行，超出约定 §4 的 80 行预算')
})
