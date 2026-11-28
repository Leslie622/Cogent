#!/usr/bin/env node
/**
 * reference/ 参照仓钉板 —— 根目录 reference.lock.json 是「当前钉在哪个 commit」的唯一可信源，
 * reference/ 本身仍被 .gitignore 排除。四仓分两类策略（docs/架构.md「reference 源码参照」）：
 * - tag（pi）：pi 是 Cogent 实际运行的内核，参照必须读 node_modules 里那份。update 按已安装的
 *   @earendil-works/pi-coding-agent 版本切到 v<版本> tag，升依赖才升参照；上游 master 回答的是
 *   「pi 往哪走」，需要时 git log v<版本>..origin/master 看，不钉。partial clone（--filter=blob:none）
 *   历史完整，sparse 只取 agent / ai / coding-agent 三包。
 * - branch（deepseek-harness / zcode / Pi-meme）：纯调研对象，update 快进到各自默认分支的最新提交；
 *   浅克隆维持浅，fetch 时加深到 SHALLOW_DEPTH，够 update 打印提交摘要。
 *
 * 子命令：
 * - sync [仓库名]  ：按清单克隆或 checkout 到钉住的 commit，新机器一条命令补齐；
 * - check          ：对比 本地 HEAD / 清单 / 上游。本地与清单不一致、已安装 pi 版本与钉板 tag 不一致
 *                    才非零退出；上游漂移、落后 release 只提示。网络失败按「远端不可达」跳过，不算错；
 * - update [仓库名]：按策略前移钉板，旧 pin 进 history，回写清单并打印变更摘要。
 *
 * 边界：check 只读；update 只改清单与本地克隆，不碰项目依赖。参照仓有本地改动时 checkout 会
 * 被拒，照提示 reset，不替人丢改动。代理走 git 自己的配置或 HTTPS_PROXY 环境变量。
 * 文档里的短 SHA 引用由 scripts/check-docs.mjs 对照本清单提示。
 * --root <目录> 供夹具测试指定仓库根。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const LOCK_NAME = 'reference.lock.json'
const REMOTE_TIMEOUT_MS = 45_000
const FETCH_TIMEOUT_MS = 10 * 60_000
const SHALLOW_DEPTH = 100
const HISTORY_LIMIT = 20

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const root = path.resolve(rootFlag < 0 ? fileURLToPath(new URL('..', import.meta.url)) : args[rootFlag + 1])
const [command = 'check', ...names] = rootFlag < 0 ? args : args.filter((_, index) => index !== rootFlag && index !== rootFlag + 1)
const lockFile = path.join(root, LOCK_NAME)
const referenceDir = path.join(root, 'reference')

if (!['sync', 'check', 'update'].includes(command)) {
  console.error(`未知子命令：${command}（可用 sync / check / update [仓库名]）`)
  process.exit(2)
}

function git(cwd, gitArgs, timeout) {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 })
  // git 不在 PATH、或超时被杀时没有 status，只有 error；其余失败照常返回 status / stderr 由调用方判断。
  if (result.error) throw new Error(`git ${gitArgs[0]} 没有完成：${result.error.message}`)
  return result
}

function loadLock() {
  if (!existsSync(lockFile)) {
    console.error(`缺少 ${LOCK_NAME}：${lockFile}`)
    process.exit(2)
  }
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  for (const name of names) {
    if (!(name in lock)) {
      console.error(`清单里没有参照仓：${name}（有 ${Object.keys(lock).join(' / ')}）`)
      process.exit(2)
    }
  }
  for (const [name, entry] of Object.entries(lock)) {
    const required = entry.strategy === 'tag' ? ['url', 'tag', 'package'] : ['url', 'branch']
    const missing = required.filter(key => typeof entry[key] !== 'string')
    if (entry.strategy !== 'tag' && entry.strategy !== 'branch') missing.push('strategy（须为 tag 或 branch）')
    if (typeof entry.commit !== 'string' || !/^[0-9a-f]{40}$/.test(entry.commit)) missing.push('commit（40 位）')
    if (missing.length > 0) {
      console.error(`${LOCK_NAME} 的 ${name} 缺少或非法字段：${missing.join('、')}`)
      process.exit(2)
    }
  }
  return lock
}

const saveLock = lock => writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
const short = sha => sha.slice(0, 9)
const today = () => new Date().toISOString().slice(0, 10)
const repoDir = name => path.join(referenceDir, name)
const isCloned = dir => existsSync(path.join(dir, '.git'))

/** 本地 HEAD；没克隆返回 null。 */
function localHead(dir) {
  if (!isCloned(dir)) return null
  const result = git(dir, ['rev-parse', 'HEAD'])
  return result.status === 0 ? result.stdout.trim() : null
}

const hasCommit = (dir, sha) => git(dir, ['cat-file', '-e', `${sha}^{commit}`]).status === 0
const isShallow = dir => git(dir, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true'

/** tag 策略的仓是 partial clone，换 commit 时要补 blob；branch 策略保持浅克隆并加深，供 update 打印提交摘要。 */
function fetch(entry, dir) {
  const depth = entry.strategy === 'branch' && isShallow(dir) ? ['--depth', String(SHALLOW_DEPTH)] : []
  return git(dir, ['fetch', ...depth, 'origin', entry.strategy === 'tag' ? '--tags' : entry.branch], FETCH_TIMEOUT_MS)
}

/** cone 模式 list 输出「/目录/」与 /* 两条根规则，归一后比较，不一致才重设。 */
function applySparse(entry, dir) {
  if (!entry.sparse) return
  const current = git(dir, ['sparse-checkout', 'list']).stdout.split('\n')
    .map(line => line.trim().replace(/^\/|\/$/g, '')).filter(line => line !== '' && line !== '*')
  if (current.length === entry.sparse.length && entry.sparse.every(dir => current.includes(dir))) return
  const result = git(dir, ['sparse-checkout', 'set', ...entry.sparse])
  if (result.status !== 0) throw new Error(`设置 sparse-checkout 失败：${result.stderr.trim()}`)
}

function clone(name, entry) {
  const shape = entry.sparse ? ['--filter=blob:none', '--sparse'] : ['--depth', String(SHALLOW_DEPTH)]
  const result = git(root, ['clone', ...shape, entry.url, repoDir(name)], FETCH_TIMEOUT_MS)
  if (result.status !== 0) throw new Error(`克隆 ${name} 失败：${result.stderr.trim()}`)
  applySparse(entry, repoDir(name))
}

/** checkout 失败分两种：参照仓有本地改动（git 拒绝覆盖）和 partial clone 补 blob 时网络 / 代理不通，提示分开，不替人丢改动。 */
function checkout(dir, sha) {
  const result = git(dir, ['checkout', '--detach', sha])
  if (result.status !== 0) {
    const detail = result.stderr.trim()
    const network = /unable to access|Could not resolve|Failed to connect|promisor remote|timed?\s?out/i.test(detail)
    const hint = network
      ? '补 blob 或拉取需要网络：检查代理（git config --local --get http.proxy）或 HTTPS_PROXY 后重试'
      : '参照仓应保持只读；有本地改动先查看 git status，确认不要再 reset'
    throw new Error(`checkout ${short(sha)} 失败：${detail}\n${hint}`)
  }
}

function installedVersion(entry) {
  const file = path.join(root, 'node_modules', ...entry.package.split('/'), 'package.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : null
}

/** 上游 tag → 剥壳后的 commit；远端不可达返回 null。 */
function remoteTags(dir) {
  const result = git(dir, ['ls-remote', '--tags', 'origin'], REMOTE_TIMEOUT_MS)
  if (result.status !== 0) return null
  const tags = new Map()
  for (const line of result.stdout.split('\n')) {
    const [sha, ref] = line.trim().split('\t')
    if (!ref?.startsWith('refs/tags/')) continue
    // 附注 tag 先列 tag 对象、紧随 ^{} 列其 commit，后者覆盖前者。
    tags.set(ref.slice('refs/tags/'.length, ref.endsWith('^{}') ? -3 : undefined), sha)
  }
  return tags
}

function remoteBranch(dir, branch) {
  const result = git(dir, ['ls-remote', 'origin', `refs/heads/${branch}`], REMOTE_TIMEOUT_MS)
  if (result.status !== 0) return null
  return result.stdout.trim().split('\t')[0] ?? ''
}

const stable = tag => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag) !== null
function compareTags(a, b) {
  const x = /^v(\d+)\.(\d+)\.(\d+)$/.exec(a)
  const y = /^v(\d+)\.(\d+)\.(\d+)$/.exec(b)
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i])
    if (diff !== 0) return diff
  }
  return 0
}

function sync(name, entry) {
  const dir = repoDir(name)
  if (!isCloned(dir)) {
    console.log(`克隆 ${name} ← ${entry.url}`)
    clone(name, entry)
  }
  if (!hasCommit(dir, entry.commit)) {
    console.log(`拉取 ${name} 的 ${short(entry.commit)}`)
    const result = fetch(entry, dir)
    if (result.status !== 0) throw new Error(`拉取 ${name} 失败：${result.stderr.trim()}`)
  }
  applySparse(entry, dir)
  const head = localHead(dir)
  const label = entry.tag ? `（${entry.tag}）` : ''
  if (head === entry.commit) {
    console.log(`${name.padEnd(18)} 已在 ${short(entry.commit)}${label}`)
    return
  }
  checkout(dir, entry.commit)
  console.log(`${name.padEnd(18)} ${head === null ? '新克隆' : short(head)} → ${short(entry.commit)}${label}`)
}

function check(name, entry) {
  const dir = repoDir(name)
  const problems = []
  const notes = []
  const head = localHead(dir)
  if (head === null) notes.push('本地未克隆 → npm run reference:sync')
  else if (head !== entry.commit) problems.push(`本地 ${short(head)} ≠ 钉板 ${short(entry.commit)} → npm run reference:sync ${name}`)

  if (entry.strategy === 'tag') {
    const installed = installedVersion(entry)
    if (installed === null) notes.push(`未安装 ${entry.package}，跳过安装版本对比`)
    else if (`v${installed}` !== entry.tag) {
      problems.push(`已安装 ${entry.package} ${installed} ≠ 钉板 ${entry.tag} → npm run reference:update ${name}`)
    }
    if (head !== null) {
      const tags = remoteTags(dir)
      if (tags === null) notes.push('远端不可达，跳过上游对比')
      else {
        if (tags.get(entry.tag) !== undefined && tags.get(entry.tag) !== entry.commit) {
          problems.push(`上游 tag ${entry.tag} 指向 ${short(tags.get(entry.tag))} ≠ 钉板 ${short(entry.commit)}`)
        }
        const releases = [...tags.keys()].filter(stable).sort(compareTags)
        const behind = releases.filter(tag => compareTags(tag, entry.tag) > 0)
        if (behind.length > 0) notes.push(`上游已到 ${behind.at(-1)}，钉板落后 ${behind.length} 个 release（只告知差距；要升先升依赖，再 npm run reference:update ${name}）`)
      }
    }
  } else if (head !== null) {
    const upstream = remoteBranch(dir, entry.branch)
    if (upstream === null) notes.push('远端不可达，跳过上游对比')
    else if (upstream === '') notes.push(`上游没有分支 ${entry.branch}，核对清单`)
    else if (upstream !== entry.commit) notes.push(`上游 ${short(upstream)} ≠ 钉板 ${short(entry.commit)} → npm run reference:update ${name}`)
  }
  return { problems, notes }
}

/** 提交摘要走 first-parent：merge 密集的仓（deepseek-harness）只看 PR 合并线；浅克隆拿不到中间提交时退回 diff --stat，便于改文档的人看上游动了什么。 */
function printSummary(dir, before, target) {
  const log = git(dir, ['log', '--oneline', '--first-parent', `${before}..${target}`])
  const text = log.status === 0 && log.stdout.trim() !== '' ? log.stdout.trim() : git(dir, ['diff', '--stat', before, target]).stdout.trim()
  if (text === '') return
  const lines = text.split('\n')
  console.log(lines.slice(0, 20).map(line => `  ${line}`).join('\n') + (lines.length > 20 ? `\n  … 共 ${lines.length} 行` : ''))
}

function update(name, entry, lock) {
  const dir = repoDir(name)
  const before = entry.commit
  if (!isCloned(dir)) {
    console.log(`克隆 ${name} ← ${entry.url}`)
    clone(name, entry)
  }
  let target
  let label
  if (entry.strategy === 'tag') {
    const installed = installedVersion(entry)
    if (installed === null) throw new Error(`读不到已安装的 ${entry.package}，无法确定 ${name} 应钉的 tag；先 npm ci`)
    label = `v${installed}`
    const fetched = fetch(entry, dir)
    if (fetched.status !== 0) throw new Error(`拉取 ${name} 的 tag 失败：${fetched.stderr.trim()}`)
    const resolved = git(dir, ['rev-parse', '--verify', `${label}^{commit}`])
    if (resolved.status !== 0) throw new Error(`上游没有 tag ${label}（已安装 ${entry.package} ${installed}）`)
    target = resolved.stdout.trim()
  } else {
    label = `origin/${entry.branch}`
    const fetched = fetch(entry, dir)
    if (fetched.status !== 0) throw new Error(`拉取 ${name} 的 ${entry.branch} 失败：${fetched.stderr.trim()}`)
    const resolved = git(dir, ['rev-parse', '--verify', `refs/remotes/origin/${entry.branch}^{commit}`])
    if (resolved.status !== 0) throw new Error(`拉取后没有 ${label}`)
    target = resolved.stdout.trim()
  }
  if (target === before) {
    console.log(`${name.padEnd(18)} 已是 ${short(target)}（${label}）`)
    return
  }
  checkout(dir, target)
  const history = entry.history ?? []
  if (!history.some(item => item.commit === before)) {
    history.unshift({ commit: before, ...(entry.tag ? { tag: entry.tag } : {}), until: today() })
  }
  entry.history = history.slice(0, HISTORY_LIMIT)
  entry.commit = target
  if (entry.strategy === 'tag') entry.tag = label
  entry.syncedAt = today()
  saveLock(lock)
  console.log(`${name.padEnd(18)} ${short(before)} → ${short(target)}（${label}），清单已更新`)
  printSummary(dir, before, target)
}

const lock = loadLock()
const selected = names.length > 0 ? names : Object.keys(lock)
let failures = 0
for (const name of selected) {
  try {
    if (command === 'sync') sync(name, lock[name])
    else if (command === 'update') update(name, lock[name], lock)
    else {
      const { problems, notes } = check(name, lock[name])
      const items = [...problems, ...notes]
      const state = problems.length > 0 ? '不一致' : notes.length > 0 ? '提示' : '一致'
      console.log(`${name.padEnd(18)} ${state}${items.length > 0 ? `：${items.join('；')}` : ''}`)
      failures += problems.length
    }
  } catch (error) {
    console.error(`${name.padEnd(18)} 失败：${error.message}`)
    failures++
  }
}
if (failures > 0) process.exitCode = 1
