/** 参照仓钉板脚本用本地裸仓库当上游走真实 git：克隆、checkout、上游漂移、update 回写清单与历史。 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const cli = resolve('scripts/sync-reference.mjs')
const created: string[] = []

function git(cwd: string, ...args: string[]) {
  try {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    throw new Error(`git ${args.join(' ')} 失败：${(error as { stderr?: string }).stderr}`)
  }
}

/** 一个可推送的上游：work 提交后 push 到裸仓库，上游 URL 用 file:// 让 --filter 与 --depth 都走真实传输。 */
function upstream(name: string) {
  const base = mkdtempSync(join(tmpdir(), `cogent-reference-${name}-`))
  created.push(base)
  const work = join(base, 'work')
  const bare = join(base, `${name}.git`)
  mkdirSync(work)
  git(base, 'init', '-q', '--bare', '-b', 'main', bare)
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'remote', 'add', 'origin', bare)
  const publish = (files: Record<string, string>, message: string, tag?: string) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(work, file, '..'), { recursive: true })
      writeFileSync(join(work, file), content)
    }
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', message)
    if (tag) git(work, 'tag', tag)
    git(work, 'push', '-q', 'origin', 'main', ...(tag ? [tag] : []))
    return git(work, 'rev-parse', 'HEAD')
  }
  return { url: pathToFileURL(bare).href, publish }
}

function project(lock: Record<string, unknown>, installed?: string) {
  const root = mkdtempSync(join(tmpdir(), 'cogent-reference-root-'))
  created.push(root)
  writeFileSync(join(root, 'reference.lock.json'), JSON.stringify(lock))
  if (installed) {
    const manifest = join(root, 'node_modules', '@scope', 'kernel', 'package.json')
    mkdirSync(join(manifest, '..'), { recursive: true })
    writeFileSync(manifest, JSON.stringify({ name: '@scope/kernel', version: installed }))
  }
  return root
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' })
}

const head = (root: string, name: string) => git(join(root, 'reference', name), 'rev-parse', 'HEAD')
type Lock = Record<string, { commit: string; tag?: string; history: Array<{ commit: string; tag?: string; until?: string }> }>
const lockOf = (root: string) => JSON.parse(readFileSync(join(root, 'reference.lock.json'), 'utf8')) as Lock

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('branch 策略：sync 克隆到钉板，check 报上游漂移，update 快进并把旧 pin 写进 history', () => {
  const remote = upstream('up')
  const first = remote.publish({ 'README.md': 'one\n' }, 'first')
  const root = project({ up: { url: remote.url, strategy: 'branch', branch: 'main', commit: first, syncedAt: '2026-01-01', history: [] } })

  const before = run(root, 'check')
  expect(before.status, before.stderr).toBe(0)
  expect(before.stdout).toContain('本地未克隆 → npm run reference:sync')

  const synced = run(root, 'sync')
  expect(synced.status, synced.stderr).toBe(0)
  expect(synced.stdout).toContain('克隆 up')
  expect(head(root, 'up')).toBe(first)
  expect(run(root, 'sync').stdout).toContain('已在')

  const second = remote.publish({ 'README.md': 'two\n' }, 'second')
  const drifted = run(root, 'check')
  expect(drifted.status, drifted.stderr).toBe(0)
  expect(drifted.stdout).toContain(`上游 ${second.slice(0, 9)} ≠ 钉板 ${first.slice(0, 9)} → npm run reference:update up`)

  const updated = run(root, 'update', 'up')
  expect(updated.status, updated.stderr).toBe(0)
  expect(updated.stdout).toContain(`${first.slice(0, 9)} → ${second.slice(0, 9)}（origin/main），清单已更新`)
  expect(updated.stdout).toContain('second')
  expect(head(root, 'up')).toBe(second)
  const lock = lockOf(root)
  expect(lock.up.commit).toBe(second)
  expect(lock.up.history).toEqual([expect.objectContaining({ commit: first })])
  expect(run(root, 'check').stdout).toContain('一致')

  // 本地被挪走算不一致（非零退出），sync 拉回钉板；update 到已是最新的提交只报「已是」。
  git(join(root, 'reference', 'up'), 'checkout', '-q', '--detach', first)
  const dirty = run(root, 'check')
  expect(dirty.status).toBe(1)
  expect(dirty.stdout).toContain(`本地 ${first.slice(0, 9)} ≠ 钉板 ${second.slice(0, 9)} → npm run reference:sync up`)
  run(root, 'sync', 'up')
  expect(head(root, 'up')).toBe(second)
  expect(run(root, 'update', 'up').stdout).toContain(`已是 ${second.slice(0, 9)}`)
})

it('tag 策略：钉板跟随已安装版本，sparse 只取登记目录，升版本后 check 不一致、update 切到新 tag', () => {
  const remote = upstream('kernel')
  const first = remote.publish({ 'packages/agent/a.ts': 'export const a = 1\n', 'packages/other/b.ts': 'export const b = 2\n' }, 'first', 'v1.0.0')
  const entry = { url: remote.url, strategy: 'tag', package: '@scope/kernel', tag: 'v1.0.0', commit: first, syncedAt: '2026-01-01', sparse: ['packages/agent'], history: [] }
  const root = project({ kernel: entry }, '1.0.0')

  const synced = run(root, 'sync', 'kernel')
  expect(synced.status, synced.stderr).toBe(0)
  expect(synced.stdout).toContain('克隆 kernel')
  expect(synced.stdout).toContain(`已在 ${first.slice(0, 9)}（v1.0.0）`)
  expect(head(root, 'kernel')).toBe(first)
  expect(existsSync(join(root, 'reference', 'kernel', 'packages', 'agent', 'a.ts'))).toBe(true)
  expect(existsSync(join(root, 'reference', 'kernel', 'packages', 'other', 'b.ts'))).toBe(false)

  const second = remote.publish({ 'packages/agent/a.ts': 'export const a = 2\n' }, 'second', 'v1.1.0')
  writeFileSync(join(root, 'node_modules', '@scope', 'kernel', 'package.json'), JSON.stringify({ name: '@scope/kernel', version: '1.1.0' }))

  const drifted = run(root, 'check')
  expect(drifted.status).toBe(1)
  expect(drifted.stdout).toContain('已安装 @scope/kernel 1.1.0 ≠ 钉板 v1.0.0 → npm run reference:update kernel')
  expect(drifted.stdout).toContain('上游最新 v1.1.0，钉板落后 1 个 release')

  const updated = run(root, 'update', 'kernel')
  expect(updated.status, updated.stderr).toBe(0)
  expect(head(root, 'kernel')).toBe(second)
  const lock = lockOf(root)
  expect(lock.kernel.tag).toBe('v1.1.0')
  expect(lock.kernel.commit).toBe(second)
  expect(lock.kernel.history).toHaveLength(1)
  expect(lock.kernel.history[0]).toMatchObject({ commit: first, tag: 'v1.0.0' })
  expect(lock.kernel.history[0].until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  // Windows 的 autocrlf 会改写换行，只比内容。
  expect(readFileSync(join(root, 'reference', 'kernel', 'packages', 'agent', 'a.ts'), 'utf8').trim()).toBe('export const a = 2')
  expect(existsSync(join(root, 'reference', 'kernel', 'packages', 'other', 'b.ts'))).toBe(false)
  expect(run(root, 'check').stdout).toContain('一致')
})

it('清单缺字段或子命令不明直接拒绝，不碰 reference/', () => {
  const root = project({ up: { url: 'https://example.invalid/up', strategy: 'tag', commit: 'a'.repeat(40) } })
  const broken = run(root, 'sync')
  expect(broken.status).toBe(2)
  expect(broken.stderr).toContain('reference.lock.json 的 up 缺少或非法字段：tag、package')
  const unknown = run(root, 'trim')
  expect(unknown.status).toBe(2)
  expect(unknown.stderr).toContain('未知子命令：trim')
  expect(existsSync(join(root, 'reference'))).toBe(false)
})
