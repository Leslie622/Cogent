/** 目录排序/过期游标、嵌套忽略与跨页重放；使用真实磁盘树，不复制算法。 */
import { mkdtemp, mkdir, writeFile, rm, realpath, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileScanEngine, type ScanRoot, type ScanRequest } from '../../../../src/host/runtime/file-views/scan-engine'
import type { FileViewDirectory, FileViewSearch } from '../../../../src/shared/file-views'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() { const path = await mkdtemp(join(tmpdir(), 'cogent-scan-')); roots.push(path); const root: ScanRoot = { id: 'root', path, realPath: await realpath(path), name: '根', kind: 'directory' }; return { root, engine: new FileScanEngine() } }
const list = (engine: FileScanEngine, root: ScanRoot, extra: Partial<Extract<ScanRequest, { kind: 'list' }>> = {}) => engine.run({ kind: 'list', contextId: 'ctx', roots: [root], directoryId: root.id, operationId: 'list', limit: 2, ...extra }) as Promise<FileViewDirectory>
const search = (engine: FileScanEngine, root: ScanRoot, extra: Partial<Extract<ScanRequest, { kind: 'search' }>> = {}) => engine.run({ kind: 'search', contextId: 'ctx', roots: [root], query: '', includeIgnored: false, operationId: 'query', limit: 2, ...extra }) as Promise<FileViewSearch>
describe('目录与文件名搜索', () => {
  it('全目录快照排序后分页，游标只属于原context且刷新使旧快照失效', async () => {
    const { root, engine } = await fixture(); await mkdir(join(root.path, 'dir')); for (const name of ['file10.txt', 'file2.txt', 'file1.txt']) await writeFile(join(root.path, name), name)
    const first = await list(engine, root); expect(first.entries.map((entry) => entry.name)).toEqual(['dir', 'file1.txt'])
    const second = await list(engine, root, { cursor: first.nextCursor }); expect(second.entries.map((entry) => entry.name)).toEqual(['file2.txt', 'file10.txt']); expect(second.complete).toBe(true)
    await expect(list(engine, root, { contextId: 'other', cursor: first.nextCursor })).rejects.toThrow('游标')
    await list(engine, root, { refresh: true }); await expect(list(engine, root, { cursor: first.nextCursor })).rejects.toThrow('失效')
    const fresh = await list(engine, root); await utimes(root.path, new Date('2000-01-01'), new Date('2000-01-01')); await expect(list(engine, root, { cursor: fresh.nextCursor })).rejects.toThrow('变化')
    await engine.close('ctx')
  })
  it('未展开子目录也可搜索，嵌套ignore能反选，包含忽略项选项生效', async () => {
    const { root, engine } = await fixture(); await mkdir(join(root.path, 'sub')); await writeFile(join(root.path, '.gitignore'), '*.log\n'); await writeFile(join(root.path, 'sub', '.gitignore'), '!keep.log\n'); await writeFile(join(root.path, 'sub', 'keep.log'), 'keep'); await writeFile(join(root.path, 'sub', 'drop.log'), 'drop')
    const normal = await search(engine, root, { query: '.log', limit: 100 }); expect(normal.entries.map((entry) => entry.name)).toEqual(['keep.log']); expect(normal.complete).toBe(true)
    await mkdir(join(root.path, '.git')); await writeFile(join(root.path, '.git', 'secret.log'), 'git metadata')
    const all = await search(engine, root, { query: '.log', includeIgnored: true, limit: 100 }); expect(all.entries.map((entry) => entry.name)).toEqual(['drop.log', 'keep.log'])
    await engine.close('ctx')
  })
  it('旧页cursor可重放，继续扫描不会改变已有页；第2001项确实可到达', async () => {
    const { root, engine } = await fixture(); await Promise.all(Array.from({ length: 2001 }, (_, index) => writeFile(join(root.path, `file${index}.txt`), '')))
    const first = await search(engine, root, { query: 'file', limit: 200 }); const second = await search(engine, root, { query: 'file', limit: 200, cursor: first.nextCursor })
    const again = await search(engine, root, { query: 'file', limit: 200, cursor: first.nextCursor }); expect(again).toEqual(second)
    const names = new Set([...first.entries, ...second.entries].map((entry) => entry.path)); let page = second
    while (page.nextCursor !== undefined) { page = await search(engine, root, { query: 'file', limit: 200, cursor: page.nextCursor }); for (const entry of page.entries) names.add(entry.path) }
    expect(names.size).toBe(2001); expect(page.complete).toBe(true); await engine.close('ctx')
  }, 30_000)
  it('预先取消和伪造目录越界不调度读取；close释放搜索游标', async () => {
    const { root, engine } = await fixture(); for (const name of ['a', 'b', 'c']) await writeFile(join(root.path, name), '')
    const canceled = new AbortController(); canceled.abort(); await expect(engine.run({ kind: 'close', contextId: 'ctx' }, canceled.signal)).rejects.toThrow()
    await expect(list(engine, root, { directoryId: 'root:' + Buffer.from('../').toString('base64url') })).rejects.toThrow('越界')
    const first = await search(engine, root); await engine.close('ctx'); await expect(search(engine, root, { cursor: first.nextCursor })).rejects.toThrow('失效')
  })
})
