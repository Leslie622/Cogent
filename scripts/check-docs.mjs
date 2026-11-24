/**
 * 文档检查入口：文档间的链接、锚点、入口可达性和带文档名的章节引用必须存在；
 * 行数预算只提示。规则见 docs/约定.md §4。
 *
 * 只把客观错误判为失败：修起来是秒级，也不会有争议。预算超限取决于内容取舍，
 * 挡住检查只会逼人挪字，所以只列出。
 *
 * 链接目标以 git 为准。入库的才算有效，没入库也没被忽略的文件算错误；被
 * .gitignore 忽略的本地产物和参照仓不检查。它们在开发机上有、在 CI 的这个时点
 * 没有，只看存在性会让两边的结论相反。
 *
 * 边界：只读；代码围栏与行内代码里的链接是被演示或被测试的样例，不检查；
 * 不带文档名的章节引用（如「计划 §3.5」）目标不确定，不检查。
 * 用法：node scripts/check-docs.mjs [仓库根]。根参数供夹具测试使用；
 * 不在仓库根运行时没有 git 清单，退回纯存在性检查。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? '.')
const show = file => relative(root, file).split(sep).join('/')
// Windows 的路径不区分大小写，git 清单与链接写法的大小写可能不同。
const key = name => process.platform === 'win32' ? name.toLowerCase() : name
const samePath = (a, b) => key(a) === key(b)

function walk(directory, accept) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name)
    if (!entry.isDirectory()) return accept(entry.name) ? [file] : []
    // 文档站的依赖带各自的说明文件，不属于本项目文档。
    return entry.name === 'node_modules' ? [] : walk(file, accept)
  })
}

function walkMarkdown(directory) {
  return walk(directory, name => name.endsWith('.md'))
}

const documents = [
  ...['AGENTS.md', 'README.md'].filter(name => existsSync(join(root, name))).map(name => join(root, name)),
  ...walkMarkdown(join(root, 'docs')),
  ...walkMarkdown(join(root, 'licenses'))
]

/** 围栏内的行不产出；行号沿用原文件，报错时能直接定位。 */
function proseLines(text) {
  const lines = []
  let fence = null
  text.split('\n').forEach((line, index) => {
    const mark = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null
      return
    }
    if (mark) {
      fence = mark
      return
    }
    lines.push({ number: index + 1, text: line.replace(/(`+)[^\n]*?\1/g, '') })
  })
  return lines
}

/** 标题锚点按 GitHub 规则生成；编号标题另收一份，供章节引用核对。 */
function slug(heading) {
  return heading.replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~]/g, '')
    .trim().toLowerCase().replace(/[^\p{L}\p{N}\s\-_]/gu, '').replace(/ /g, '-')
}

const outlines = new Map()
function outline(file) {
  if (outlines.has(file)) return outlines.get(file)
  const anchors = new Set()
  const sections = new Set()
  const used = new Map()
  for (const { text } of proseLines(readFileSync(file, 'utf8'))) {
    const heading = text.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)
    if (heading) {
      // 同名标题依次落 -1、-2。
      const base = slug(heading[1])
      const count = used.get(base) ?? 0
      used.set(base, count + 1)
      anchors.add(count === 0 ? base : `${base}-${count}`)
      const numbered = heading[1].match(/^(\d+(?:\.\d+)*)\.?(?![\d.])/)
      if (numbered) sections.add(numbered[1])
    }
    for (const explicit of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(explicit[1])
  }
  outlines.set(file, { anchors, sections })
  return outlines.get(file)
}

let failures = 0
let linkCount = 0
let sectionCount = 0

function fail(message) {
  console.error(message)
  failures++
}

function git(args, input) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 })
}

/** 入库文件清单。清单只认仓库根：在子目录运行时 git 只列该子目录，会把其余文件误判成未入库。 */
function trackedPaths() {
  const top = git(['rev-parse', '--show-toplevel'])
  if (top.status !== 0 || !samePath(resolve(top.stdout.trim()), root)) return null
  return new Set(git(['ls-files', '-z']).stdout.split('\0').filter(Boolean).map(key))
}
const tracked = trackedPaths()

/** 只问一次 git 哪些路径被忽略；退出码 1 表示一个都没有，不是错误。已入库的文件不受忽略规则约束，不会被列出。 */
function ignoredPaths(names) {
  if (tracked === null || names.length === 0) return new Set()
  const answer = git(['check-ignore', '-z', '--stdin'], `${[...new Set(names)].join('\0')}\0`)
  if (answer.status !== 0 && answer.status !== 1) fail(`无法读取 git 忽略规则：${answer.stderr.trim()}`)
  return new Set(answer.stdout.split('\0').filter(Boolean).map(key))
}

/**
 * tracked 已入库，或本就是由入库文件构成的目录；untracked 没入库也没被忽略；
 * ignored 被忽略的本地文件。没有 git 清单时只分存在与否。
 */
function classify(file) {
  const name = key(show(file))
  if (tracked === null) return existsSync(file) ? 'tracked' : 'untracked'
  if (tracked.has(name)) return 'tracked'
  if (ignored.has(name)) return 'ignored'
  return existsSync(file) && statSync(file).isDirectory() ? 'tracked' : 'untracked'
}

// 可达性只在受检文档之间连边。
const reachable = new Map(documents.map(file => [file, new Set()]))
const references = []
for (const file of documents) {
  for (const { number, text } of proseLines(readFileSync(file, 'utf8'))) {
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1]
      if (/^(?:https?:|mailto:)/.test(target)) continue
      const hash = target.indexOf('#')
      const location = hash < 0 ? target : target.slice(0, hash)
      references.push({ file, number, target, location, resolved: location === '' ? file : resolve(dirname(file), location), anchor: hash < 0 ? '' : target.slice(hash + 1) })
    }
  }
}
const ignored = ignoredPaths(references.map(reference => show(reference.resolved)))

for (const { file, number, target, location, resolved, anchor } of references) {
  // 文内锚点指向本文，本文已在受检之列，不必再问 git。
  const kind = location === '' ? 'tracked' : classify(resolved)
  if (kind === 'ignored') continue
  linkCount++
  if (kind === 'untracked') {
    fail(`${show(file)}:${number} 链接目标${existsSync(resolved) ? '未入库' : '不存在'}：${target}`)
    continue
  }
  if (reachable.has(resolved)) reachable.get(file).add(resolved)
  if (anchor === '' || !statSync(resolved).isFile()) continue
  let decoded = anchor
  try {
    decoded = decodeURIComponent(anchor)
  } catch {
    // 百分号不成码时按字面找不到锚点，走下面的坏锚点报告。
  }
  if (decoded === '') continue
  const range = decoded.match(/^L(\d+)(?:-L?(\d+))?$/)
  if (range) {
    if (Number(range[2] ?? range[1]) > readFileSync(resolved, 'utf8').split('\n').length) fail(`${show(file)}:${number} 行号超出文件：${target}`)
  } else if (resolved.endsWith('.md') && !outline(resolved).anchors.has(decoded)) {
    fail(`${show(file)}:${number} 锚点不存在：${target}`)
  }
}

// 入口是人和 agent 的第一跳；从它们走不到的文档等于不存在。
const entries = documents.filter(file => /^(?:AGENTS|README)\.md$/.test(basename(file)))
if (documents.length > 0 && entries.length === 0) fail('没有 AGENTS.md 或 README.md 作为文档入口')
const seen = new Set()
const pending = [...entries]
while (pending.length > 0) {
  const file = pending.pop()
  if (seen.has(file)) continue
  seen.add(file)
  pending.push(...reachable.get(file))
}
for (const file of documents) {
  if (!seen.has(file)) fail(`没有入口可达：${show(file)}`)
}

const sources = [
  ...['src', 'tests'].flatMap(name => walk(join(root, name), file => /[.](?:ts|tsx|mjs|cjs)$/.test(file))),
  ...documents
]
const named = /([\p{L}\p{N}._/\\-]+[.]md)[^\S\n]*§[^\S\n]*(\d+(?:[.]\d+)*)/gu
const convention = /(?<![\p{L}\p{N}._/\\-])约定[^\S\n]*§[^\S\n]*(\d+(?:[.]\d+)*)/gu
/** 文档名之前可以紧贴中文（「不属于约定.md」）：最后一段路径内从左逐字让位，取第一个存在的文件。 */
function documentAt(from, referenced) {
  const name = referenced.replaceAll('\\', '/')
  const lead = name.slice(0, name.lastIndexOf('/') + 1)
  const bases = [dirname(from), root, join(root, 'docs')]
  for (let cut = lead.length; cut < name.length; cut++) {
    const found = bases.map(base => join(base, lead + name.slice(cut))).find(path => existsSync(path) && statSync(path).isFile() && classify(path) !== 'ignored')
    if (found) return found
  }
  return undefined
}
for (const file of sources) {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    for (const match of line.matchAll(named)) {
      sectionCount++
      const target = documentAt(file, match[1])
      if (!target) fail(`${show(file)}:${index + 1} 引用的文档不存在：${match[1].slice(match[1].lastIndexOf('/') + 1)} §${match[2]}`)
      else if (!outline(target).sections.has(match[2])) fail(`${show(file)}:${index + 1} 章节不存在：${match[1].slice(match[1].lastIndexOf('/') + 1)} §${match[2]}`)
    }
    for (const match of line.matchAll(convention)) {
      sectionCount++
      if (!outline(join(root, 'docs/约定.md')).sections.has(match[1])) fail(`${show(file)}:${index + 1} 章节不存在：约定 §${match[1]}`)
    }
  })
}

// 预算取自约定 §4：模块 40–80 行，架构、约定、UI 布局 150–250 行。
const budgets = [
  ...documents.filter(file => show(file).startsWith('docs/模块/') && basename(file) !== '索引.md').map(file => [file, 80]),
  ...['docs/架构.md', 'docs/约定.md', 'docs/UI布局.md'].map(path => [join(root, path), 250])
]
const overBudget = budgets
  .filter(([file]) => existsSync(file))
  .map(([file, limit]) => [show(file), readFileSync(file, 'utf8').replace(/\r/g, '').replace(/\n$/, '').split('\n').length, limit])
  .filter(([, count, limit]) => count > limit)
for (const [path, count, limit] of overBudget) console.log(`${path} ${count} 行，超出约定 §4 的 ${limit} 行预算（只提示）`)

if (failures > 0) {
  console.error(`文档检查失败：${failures} 处。`)
  process.exitCode = 1
} else {
  console.log(`文档检查通过：${documents.length} 个文档，${linkCount} 个链接，${sectionCount} 处章节引用${overBudget.length > 0 ? `，${overBudget.length} 份文档超行数预算` : ''}。`)
}
