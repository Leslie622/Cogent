/** Themd 基准维护：显式更新快照，日常检查生成物；不在构建时读取外部仓库。 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(root, 'src/renderer/src/lib/theme/upstream')
const files = ['src/lib/theme/tokens.ts', 'src/lib/theme/compile.ts', 'src/lib/theme/defaults.ts', 'src/styles/theme-base.css', 'src/lib/theme/portable-css.ts']
// 文本基准统一 LF，避免 Windows autocrlf 让另一平台的相同源码误报变化。
const normalize = data => data.toString().replaceAll('\r\n', '\n')
const hash = (data) => createHash('sha256').update(normalize(data)).digest('hex')
const snapshotName = (file) => `${file.split('/').at(-1)}.txt`

/** 只转换宿主结构与缺省色；排版令牌和源默认值从快照原样保留。 */
export function adaptThemdCss(source) {
  const tree = postcss.parse(normalize(source))
  tree.walkRules(rule => {
    // Themd 的编辑器代码工具栏/临时开关不属于 Markdown 结构；由宿主适配。
    if (rule.selector.includes('.themd-code') || rule.selector.includes('.themd-mermaid') || rule.selector.includes('.hljs')) {
      rule.remove()
      return
    }
    rule.selector = rule.selector.replaceAll('.themd-prose', '.md-body')
      .replaceAll('input.task-list-item-checkbox', 'input[type="checkbox"]')
      .replace(/\.md-body(\[style\*=[^\]]+\])/g, '$1 .md-body')
    if (rule.selector === '.md-body') rule.walkDecls('max-width', declaration => declaration.remove())
    rule.walkDecls(declaration => {
      declaration.value = declaration.value.replaceAll('oklch(0.9 0 0)', 'var(--md-default-border)')
        .replaceAll('oklch(0.96 0 0)', 'var(--md-default-inline-bg)')
        .replaceAll('oklch(0.97 0 0)', 'var(--md-default-code-bg)')
        .replaceAll('oklch(0.7 0 0)', 'var(--md-default-task-border)')
      if (rule.selector === '.md-body pre code' && declaration.prop === 'font-size') declaration.value = 'inherit'
    })
  })
  return `/* 由 scripts/themd-theme.mjs 生成；修改上游快照后重新生成，宿主差异放 content.css。 */\n${tree.toString().trim()}\n`
}

export function checkTheme(sourceRoot) {
  const manifest = JSON.parse(readFileSync(resolve(destination, 'manifest.json'), 'utf8'))
  const changed = []
  for (const file of files) {
    const data = readFileSync(resolve(destination, snapshotName(file)))
    if (hash(data) !== manifest.files[file]) changed.push(`本地快照哈希变化：${file}`)
    if (sourceRoot && hash(readFileSync(resolve(sourceRoot, file))) !== manifest.files[file]) changed.push(`上游有变化：${file}`)
  }
  const expected = adaptThemdCss(readFileSync(resolve(destination, 'theme-base.css.txt'), 'utf8'))
  if (normalize(readFileSync(resolve(destination, '../themd-base.css'))) !== expected) changed.push('生成的 themd-base.css 过期')
  const mappings = file => [...readFileSync(file, 'utf8').matchAll(/'([^']+)': '(--t-[^']+)'/g)].map(match => [match[1], match[2]])
  if (JSON.stringify(mappings(resolve(destination, 'tokens.ts.txt'))) !== JSON.stringify(mappings(resolve(destination, '../tokens.ts')))) changed.push('Cogent 令牌映射与 Themd 基准不一致')
  return changed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode = '--check', source] = process.argv.slice(2)
  if (!['--check', '--update'].includes(mode)) throw new Error('用法：node scripts/themd-theme.mjs --check [Themd路径] | --update Themd路径')
  if (mode === '--update') {
    if (!source) throw new Error('--update 必须显式指定 Themd 路径')
    mkdirSync(destination, { recursive: true })
    const revision = execFileSync('git', ['-C', resolve(source), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const hashes = {}
    for (const file of files) {
      const data = readFileSync(resolve(source, file))
      writeFileSync(resolve(destination, snapshotName(file)), normalize(data))
      hashes[file] = hash(data)
    }
    writeFileSync(resolve(destination, 'manifest.json'), `${JSON.stringify({ revision, files: hashes }, null, 2)}\n`)
    writeFileSync(resolve(destination, '../themd-base.css'), adaptThemdCss(readFileSync(resolve(destination, 'theme-base.css.txt'), 'utf8')))
  }
  const changed = checkTheme(source ? resolve(source) : undefined)
  console.log(changed.length ? changed.join('\n') : 'Themd 基准、快照哈希与生成样式一致。')
  if (changed.length) process.exitCode = 1
}
