/** 本轮改动列表 Host 服务单测：延迟全量扫描、首尾净差、改名折叠、边界覆盖、中断恢复与删除清理。 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeDiffStat } from '../../../src/host/runtime/changes/diff-core'
import { InProcessDiffCalculator } from '../../../src/host/runtime/changes/diff-client'
import { changeHandlers } from '../../../src/host/runtime/changes/handlers'
import { WorkspaceChangesService } from '../../../src/host/runtime/changes/service'
import { CHANGE_LIMITS, canonicalPath } from '../../../src/host/runtime/changes/types'
import type { TurnChangesSummary } from '../../../src/shared/changes'

const dirs: string[] = []
const services: WorkspaceChangesService[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(services.splice(0).map((s) => s.drain().then(() => s.dispose())))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function setup() {
  const hostRoot = await mkdtemp(join(tmpdir(), 'cogent-changes-host-'))
  const ws = await mkdtemp(join(tmpdir(), 'cogent-changes-ws-'))
  dirs.push(hostRoot, ws)
  const events: TurnChangesSummary[] = []
  const service = new WorkspaceChangesService(hostRoot, (doc) => events.push(doc), new InProcessDiffCalculator())
  services.push(service)
  return { hostRoot, ws, events, service }
}

describe('changes/diff-core', () => {
  it('区分 UTF-8、换行符变更与二进制 NUL 字节', () => {
    expect(computeDiffStat(Buffer.from('a\nb\n'), Buffer.from('a\nc\nd\n'), 1000)).toMatchObject({
      status: 'text',
      added: 2,
      deleted: 1
    })
    expect(computeDiffStat(Buffer.from('a\r\nb\r\n'), Buffer.from('a\nb\n'), 1000)).toMatchObject({
      status: 'eol-or-encoding',
      added: 0,
      deleted: 0
    })
    expect(computeDiffStat(Buffer.from([0x89, 0x50, 0x00, 0x4e]), Buffer.from([0x89, 0x50, 0x00, 0x47]), 1000)).toMatchObject({
      status: 'binary',
      added: null,
      deleted: null
    })
  })
})

describe('WorkspaceChangesService', () => {
  it('纯只读回合零扫描短路；仅 edit/write 不扫描整个工作区目录', async () => {
    const { ws, service } = await setup()
    await writeFile(join(ws, 'target.ts'), 'const x = 1\nconst y = 2\n')
    await writeFile(join(ws, 'untouched.ts'), 'keep me\n')

    const ownerRead = {}
    service.begin('s1', 't-read', ownerRead, [ws])
    await service.beforeTool('s1', 't-read', ownerRead, 'read', { path: 'target.ts' }, ws)
    expect(service.finishEmpty('s1', 't-read', ownerRead)).toBe(true)
    expect(await service.get('s1')).toEqual([])

    const ownerEdit = {}
    service.begin('s1', 't-edit', ownerEdit, [ws])
    await service.beforeTool('s1', 't-edit', ownerEdit, 'edit', { path: 'target.ts' }, ws)
    await writeFile(join(ws, 'target.ts'), 'const x = 1\nconst y = 3\nconst z = 4\n')
    expect(service.finishEmpty('s1', 't-edit', ownerEdit)).toBe(false)
    await service.finalize('s1', 't-edit', ownerEdit, 'completed')

    const [summary] = await service.get('s1', 't-edit')
    expect(summary.items).toHaveLength(1)
    expect(summary.items[0]).toMatchObject({ path: 'target.ts', kind: 'modified', added: 2, deleted: 1 })
    expect(summary.totalAdded).toBe(2)
    expect(summary.totalDeleted).toBe(1)

    // 即使之后磁盘又被改掉，审查 diff 依然读到冻结的回合 before/after。
    await writeFile(join(ws, 'target.ts'), 'mutated later\n')
    const diff = await service.diff('s1', 't-edit', summary.revision, summary.items[0].changeId)
    expect(diff.status).toBe('text')
    expect(diff.beforeText).toBe('const x = 1\nconst y = 2\n')
    expect(diff.afterText).toBe('const x = 1\nconst y = 3\nconst z = 4\n')
  })

  it('先 edit 再 powershell 同改一文件时保留 edit 前基线，且捕获 .gitignore/dist 与消零 A->B->A', async () => {
    const { ws, service } = await setup()
    await writeFile(join(ws, '.gitignore'), 'dist/\n')
    await mkdir(join(ws, 'nested-repo', '.git'), { recursive: true })
    await writeFile(join(ws, 'nested-repo', 'inner.txt'), 'v1')
    await writeFile(join(ws, 'app.ts'), 'line1\nline2\n')
    await writeFile(join(ws, 'revert-me.ts'), 'same\n')

    const owner = {}
    service.begin('s1', 't1', owner, [ws])
    // 1. 先 edit app.ts
    await service.beforeTool('s1', 't1', owner, 'edit', { path: 'app.ts' }, ws)
    await writeFile(join(ws, 'app.ts'), 'line1\nline2-edited\n')
    // 2. 再放行 powershell（触发延迟工作区基线），期间改写 app.ts、创建 dist/out.js、改后还原 revert-me.ts、改动嵌套仓库
    await service.beforeTool('s1', 't1', owner, 'powershell', { command: 'echo ok' }, ws)
    await writeFile(join(ws, 'app.ts'), 'line1\nline2-final\nline3\n')
    await mkdir(join(ws, 'dist'), { recursive: true })
    await writeFile(join(ws, 'dist', 'out.js'), 'console.log(1)\n')
    await writeFile(join(ws, 'revert-me.ts'), 'temp\n')
    await writeFile(join(ws, 'revert-me.ts'), 'same\n')
    await writeFile(join(ws, 'nested-repo', 'inner.txt'), 'v2')

    await service.finalize('s1', 't1', owner, 'completed')
    const [summary] = await service.get('s1', 't1')
    expect(summary.coverage).toBe('complete')
    expect(summary.warnings.some((w) => w.includes('nested-repo'))).toBe(true)
    expect(summary.items.map((i) => i.path)).toEqual(['app.ts', 'dist/out.js'])

    const appDiff = await service.diff('s1', 't1', summary.revision, summary.items[0].changeId)
    expect(appDiff.beforeText).toBe('line1\nline2\n')
    expect(appDiff.afterText).toBe('line1\nline2-final\nline3\n')
  })

  it('唯一内容匹配折叠为 renamed，无绑定工作区降级 tools-only，中断状态转 interrupted', async () => {
    const { hostRoot, ws, service } = await setup()
    await writeFile(join(ws, 'old-name.ts'), 'export const uniquePayload = 42\n')
    const owner = {}
    service.begin('s1', 't-rename', owner, [ws])
    await service.beforeTool('s1', 't-rename', owner, 'powershell', { command: 'mv' }, ws)
    await rm(join(ws, 'old-name.ts'))
    await writeFile(join(ws, 'new-name.ts'), 'export const uniquePayload = 42\n')
    await service.finalize('s1', 't-rename', owner, 'completed')

    const [renamed] = await service.get('s1', 't-rename')
    expect(renamed.items).toHaveLength(1)
    expect(renamed.items[0]).toMatchObject({ kind: 'renamed', oldPath: 'old-name.ts', path: 'new-name.ts', added: 0, deleted: 0 })

    // 无工作区根
    const unboundOwner = {}
    service.begin('s1', 't-unbound', unboundOwner, [])
    await service.beforeTool('s1', 't-unbound', unboundOwner, 'powershell', { command: 'echo' }, ws)
    await service.finalize('s1', 't-unbound', unboundOwner, 'completed')
    const [unbound] = await service.get('s1', 't-unbound')
    expect(unbound.coverage).toBe('tools-only')

    // 模拟盘上残留 running manifest（未收口崩溃）
    await service.storage.commit({
      summary: {
        version: 1, sessionId: 's1', turnId: 't-crash', revision: 1, state: 'running',
        coverage: 'complete', totalAdded: 0, totalDeleted: 0, incompleteCount: 0, items: [], warnings: []
      },
      entries: []
    }, new AbortController().signal)
    const [recovered] = await service.get('s1', 't-crash')
    expect(recovered.state).toBe('interrupted')
    expect(recovered.warnings.some((w) => w.includes('中断'))).toBe(true)

    // 删会话清理
    await service.releaseSession('s1')
    expect(existsSync(join(hostRoot, 'changes', 'v1', 'sessions', 's1'))).toBe(false)
  })

  it('手动继续沿用同一回合初始基线，符号链接记录非文本变更，handler 校验参数与会话', async () => {
    const { ws, service } = await setup()
    await writeFile(join(ws, 'story.txt'), 'v0\n')
    const owner1 = {}
    service.begin('s2', 't1', owner1, [ws])
    await service.beforeTool('s2', 't1', owner1, 'write', { path: 'story.txt' }, ws)
    await writeFile(join(ws, 'story.txt'), 'v0\nv1\n')
    await service.finalize('s2', 't1', owner1, 'completed')

    // 手动继续：改回 v0 时净变化应归零
    const owner2 = {}
    service.begin('s2', 't1', owner2, [ws], true)
    await service.beforeTool('s2', 't1', owner2, 'write', { path: 'story.txt' }, ws)
    await writeFile(join(ws, 'story.txt'), 'v0\n')
    await service.finalize('s2', 't1', owner2, 'completed')
    const [continued] = await service.get('s2', 't1')
    expect(continued.revision).toBe(2)
    expect(continued.items).toEqual([])

    // 符号链接记录测试（在支持 symlink 或报错忽略的 Windows 环境容错处理）
    const linkOwner = {}
    try {
      await symlink(join(ws, 'story.txt'), join(ws, 'link.txt'))
      service.begin('s2', 't-link', linkOwner, [ws])
      await service.beforeTool('s2', 't-link', linkOwner, 'powershell', { command: 'ln' }, ws)
      await rm(join(ws, 'link.txt'))
      await service.finalize('s2', 't-link', linkOwner, 'completed')
      const [linkSummary] = await service.get('s2', 't-link')
      expect(linkSummary.items[0].added).toBeNull()
    } catch {
      // 无 symlink 权限的 Windows 受限账号允许跳过此分支
    }

    const handlers = new Map(changeHandlers(service, (sid) => { if (sid !== 's2') throw new Error('未知会话') }))
    expect(() => handlers.get('changes.get')!({ sessionId: 'other' })).toThrow('未知会话')
    expect(() => handlers.get('changes.diff')!({ sessionId: 's2', turnId: 't1', revision: 0, changeId: 'bad' })).toThrow()
    const list = await (handlers.get('changes.get')!({ sessionId: 's2', turnId: 't1' }) as Promise<TurnChangesSummary[]>)
    expect(list[0].turnId).toBe('t1')
    await expect(readFile(join(ws, 'story.txt'), 'utf8')).resolves.toBe('v0\n')
  })

  it('起点工作区扫描超时或超限时，终点扫描到的未纳入基线既有文件不会误判为新增', async () => {
    const { ws, service } = await setup()
    await writeFile(join(ws, 'AGENTS.md'), 'old\n')
    await mkdir(join(ws, 'scanned-dir'), { recursive: true })
    await writeFile(join(ws, 'scanned-dir', 'keep.txt'), 'keep\n')
    await mkdir(join(ws, 'out', 'nested'), { recursive: true })
    await writeFile(join(ws, 'out', 'nested', 'license.txt'), 'MIT\n')
    await writeFile(join(ws, 'out', 'bundle.js'), 'console.log(0)\n')

    const origScan = service.storage.captureSide.bind(service.storage)
    const outCanon = canonicalPath(join(ws, 'out'))
    let scanPhase: 'before' | 'after' = 'before'
    const originalTimeout = CHANGE_LIMITS.scanTimeoutMs
    ;(CHANGE_LIMITS as { scanTimeoutMs: number }).scanTimeoutMs = 25
    try {
      const captureSpy = vi.spyOn(service.storage, 'captureSide').mockImplementation(async (sid, targetPath, budget, signal, statCache) => {
        if (scanPhase === 'before' && canonicalPath(targetPath).startsWith(outCanon)) {
          await new Promise((r) => setTimeout(r, 60))
        }
        return origScan(sid, targetPath, budget, signal, statCache)
      })

      const owner = {}
      service.begin('s-timeout', 't1', owner, [ws])
      await service.beforeTool('s-timeout', 't1', owner, 'powershell', { command: 'echo ok' }, ws)
      expect(captureSpy).toHaveBeenCalled()

      // 真实改动 AGENTS.md，并在已扫描完的目录下新建文件；out/ 下的既有文件原封不动
      await writeFile(join(ws, 'AGENTS.md'), 'old\nnew\n')
      await writeFile(join(ws, 'scanned-dir', 'created.txt'), 'brand new\n')

      scanPhase = 'after'
      ;(CHANGE_LIMITS as { scanTimeoutMs: number }).scanTimeoutMs = 5_000
      await service.finalize('s-timeout', 't1', owner, 'completed')

      const [summary] = await service.get('s-timeout', 't1')
      expect(summary.coverage).toBe('partial')
      expect(summary.warnings.some((w) => w.includes('超时'))).toBe(true)
      expect(summary.items.some((i) => i.path.startsWith('out/'))).toBe(false)
      expect(summary.items.map((i) => i.path)).toEqual(['AGENTS.md', 'scanned-dir/created.txt'])
    } finally {
      ;(CHANGE_LIMITS as { scanTimeoutMs: number }).scanTimeoutMs = originalTimeout
    }
  })

  it('起点工作区扫描触发 maxFiles 上限时，终点多扫出的既有文件不会误判为新增', async () => {
    const { ws, service } = await setup()
    await writeFile(join(ws, 'a.txt'), 'v1\n')
    await mkdir(join(ws, 'z-later'), { recursive: true })
    await writeFile(join(ws, 'z-later', 'existing-1.txt'), 'e1\n')
    await writeFile(join(ws, 'z-later', 'existing-2.txt'), 'e2\n')

    // 临时将 maxFiles 限制为 1，模拟起点因超限未进入 z-later
    const originalMax = CHANGE_LIMITS.maxFiles
    ;(CHANGE_LIMITS as { maxFiles: number }).maxFiles = 1
    try {
      const owner = {}
      service.begin('s-limit', 't1', owner, [ws])
      await service.beforeTool('s-limit', 't1', owner, 'powershell', { command: 'echo ok' }, ws)

      await writeFile(join(ws, 'a.txt'), 'v1\nv2\n')
      // 模拟终点放宽（或删掉前置文件后终点多扫到 z-later）
      ;(CHANGE_LIMITS as { maxFiles: number }).maxFiles = 100
      await service.finalize('s-limit', 't1', owner, 'completed')

      const [summary] = await service.get('s-limit', 't1')
      expect(summary.coverage).toBe('partial')
      expect(summary.warnings.some((w) => w.includes('上限'))).toBe(true)
      expect(summary.items.map((i) => i.path)).toEqual(['a.txt'])
    } finally {
      ;(CHANGE_LIMITS as { maxFiles: number }).maxFiles = originalMax
    }
  })
})
