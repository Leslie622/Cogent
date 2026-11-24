/** 真实磁盘产物事务：覆盖/清空/取消/故障/历史字节/权限归属，测试对外行为。 */
import { mkdtemp, writeFile, rm, readFile, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutputsService, outputPath } from '../../../src/host/runtime/outputs/service'
import { FileService } from '../../../src/host/runtime/files/reader'
import { outputHandlers } from '../../../src/host/runtime/outputs/handlers'
import type { FileContext } from '../../../src/shared/files'
import type { OutputDeclaration, TurnOutputs } from '../../../src/shared/outputs'

const roots: string[] = []
const services: OutputsService[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(services.splice(0).map((service) => service.drain())); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cogent-outputs-')); roots.push(root)
  await writeFile(join(root, '甲 #%.txt'), Buffer.from('\ufeff甲\r\nA\r\n'))
  await writeFile(join(root, 'B.txt'), 'B')
  await writeFile(join(root, 'C.txt'), 'C')
  const events: TurnOutputs[] = []
  const service = new OutputsService(root, (doc) => events.push(doc))
  services.push(service)
  const owner = {}
  const context: FileContext = { version: 1, turnId: 't1', userEntryId: 'u1', cwd: root, roots: [root], platform: process.platform }
  service.begin('s1', 't1', owner)
  const report = async (items: OutputDeclaration[], callId = crypto.randomUUID()) => {
    await service.stage('s1', context, owner, callId, items)
    return (await service.settle('s1', callId, true))!
  }
  const files = new FileService(() => ({ context, saved: true }))
  return { root, service, owner, context, report, files, events }
}

describe('产物申报与交付版本', () => {
  it('暂存不发布，确认后仍等终态；完整替换、失败保留和明确清空', async () => {
    const f = await fixture()
    await f.service.stage('s1', f.context, f.owner, 'call1', [{ path: '甲 #%.txt' }, { path: 'B.txt' }])
    expect(await f.service.get('s1')).toEqual([])
    const first = (await f.service.settle('s1', 'call1', true))!
    expect(first.active).toHaveLength(2); expect(first.published).toEqual([])
    await expect(f.report([{ path: 'C.txt' }, { path: 'missing.txt' }])).rejects.toThrow('missing.txt')
    expect((await f.service.get('s1'))[0].active).toHaveLength(2)
    const second = await f.report([{ path: 'B.txt', note: '第二份' }, { path: 'C.txt' }])
    expect(second.active.map((item) => item.name)).toEqual(['B.txt', 'C.txt'])
    expect(second.active[0].outputId).toBe(first.active[1].outputId)
    const empty = await f.report([])
    expect(empty.declared).toBe(true); expect(empty.active).toEqual([])
    await f.service.finalize('s1', 't1', f.owner, 'completed')
    expect((await new OutputsService(f.root, () => {}).get('s1'))[0]).toMatchObject({ state: 'ready', active: [], published: [], declared: true })
  })
  it('源文件后改为B，终态复核保存B；再删除原件，交付副本仍可读且原文件动作报错', async () => {
    const f = await fixture()
    await f.report([{ path: '甲 #%.txt', note: '报告' }])
    await writeFile(join(f.root, '甲 #%.txt'), '\ufeff最终B\r\n')
    await f.service.finalize('s1', 't1', f.owner, 'completed')
    await rm(join(f.root, '甲 #%.txt'))
    const doc = (await f.service.get('s1'))[0]
    const target = { sessionId: 's1', turnId: 't1', revision: doc.revision, outputId: doc.published[0].outputId, version: 'delivery' as const }
    const descriptor = await f.service.resolve(target, f.files)
    expect(descriptor.path).toBe(join(f.root, '甲 #%.txt'))
    const content = await f.files.readChunk({ sessionId: 's1', fileId: descriptor.fileId, version: descriptor.version, operationId: 'op', offset: 0, length: 100 })
    expect(Buffer.from(content.base64, 'base64')).toEqual(Buffer.from('\ufeff最终B\r\n'))
    await expect(f.service.resolve({ ...target, version: 'current' }, f.files)).rejects.toThrow()
    const exported = await f.files.actionTarget({ sessionId: 's1', fileId: descriptor.fileId })
    await writeFile(exported.path, '被外部编辑')
    const source = await f.service.storage.verify(doc.published[0])
    expect(await readFile(source, 'utf8')).toBe('\ufeff最终B\r\n')
  })
  it('源在收尾前丢失，保留已确认版并标最终版未确认；停止和失败事实不丢', async () => {
    const f = await fixture()
    await f.report([{ path: 'B.txt' }])
    await rm(join(f.root, 'B.txt'))
    await f.service.finalize('s1', 't1', f.owner, 'aborted')
    const doc = (await f.service.get('s1'))[0]
    expect(doc.outcome).toBe('aborted'); expect(doc.published[0].warning).toContain('最终版未确认')
    expect(await readFile(await f.service.storage.verify(doc.published[0]), 'utf8')).toBe('B')
  })
  it('最终扩展判错或取消不能提交新声明，旧确认版仍有效', async () => {
    const f = await fixture()
    const old = await f.report([{ path: 'B.txt' }])
    await f.service.stage('s1', f.context, f.owner, 'bad', [{ path: 'C.txt' }])
    await f.service.settle('s1', 'bad', false)
    expect((await f.service.get('s1'))[0].revision).toBe(old.revision)
    const controller = new AbortController()
    await f.service.stage('s1', f.context, f.owner, 'abort', [{ path: 'C.txt' }], controller.signal)
    controller.abort()
    await expect(f.service.settle('s1', 'abort', true)).rejects.toThrow()
    expect((await f.service.get('s1'))[0].active[0].name).toBe('B.txt')
  })
  it('两次并行声明按进入顺序提交，不按复制完成时间抢写', async () => {
    const f = await fixture()
    await f.service.stage('s1', f.context, f.owner, 'first', [{ path: 'B.txt' }])
    let staged = false
    const later = f.service.stage('s1', f.context, f.owner, 'second', [{ path: 'C.txt' }]).then(() => { staged = true })
    await new Promise((done) => setTimeout(done, 10)); expect(staged).toBe(false)
    await f.service.settle('s1', 'first', true); await later; await f.service.settle('s1', 'second', true)
    expect((await f.service.get('s1'))[0].active.map((item) => item.name)).toEqual(['C.txt'])
  })
  it('重复真实目标保留首次顺序、最后说明；目录、超条目和无效参数整批拒绝', async () => {
    const f = await fixture()
    const doc = await f.report([{ path: 'B.txt', note: '旧说明' }, { path: './B.txt', note: '新说明' }])
    expect(doc.active).toHaveLength(1); expect(doc.active[0].note).toBe('新说明')
    await expect(f.report([{ path: '.' }])).rejects.toThrow('普通文件')
    await expect(f.report(Array.from({ length: 101 }, () => ({ path: 'B.txt' })))).rejects.toThrow('100')
    expect(() => outputPath('x\0y', f.context)).toThrow('空字符')
    const routes = new Map(outputHandlers(f.service, f.files, () => {}))
    expect(() => routes.get('outputs.resolve')!({ sessionId: '../x' })).toThrow()
  })
  it('预算之外的普通文件仍可交付，但明确标 source-only', async () => {
    const f = await fixture()
    const file = await open(join(f.root, 'big.zip'), 'w'); await file.truncate(101 * 1024 ** 2); await file.close()
    const doc = await f.report([{ path: 'big.zip' }])
    expect(doc.active[0].copy.status).toBe('source-only')
    await rm(join(f.root, 'big.zip'))
    await f.service.finalize('s1', 't1', f.owner, 'completed')
    const published = (await f.service.get('s1'))[0].published[0]
    expect(published.copy.status).toBe('source-only')
    expect(published.warning).toContain('未保存交付副本')
    expect(published.warning).not.toContain('保留最近确认版本')
  })
  it('真实IO错误、manifest提交错误不能伪装预算降级或抹旧清单', async () => {
    const f = await fixture(); const old = await f.report([{ path: 'B.txt' }])
    vi.spyOn(f.service.storage, 'capture').mockRejectedValueOnce(new Error('ENOSPC'))
    await expect(f.report([{ path: 'C.txt' }])).rejects.toThrow('ENOSPC')
    vi.spyOn(f.service.storage, 'commit').mockRejectedValueOnce(new Error('disk commit failed'))
    await expect(f.report([{ path: 'C.txt' }])).rejects.toThrow('disk commit failed')
    expect((await f.service.get('s1'))[0].revision).toBe(old.revision)
  })
  it('重启中断只恢复保存字节；手动继续保留已发布版，最后清空撤回', async () => {
    const f = await fixture(); await f.report([{ path: 'B.txt' }])
    const restarted = new OutputsService(f.root, () => {})
    services.push(restarted)
    const [restored, concurrent] = await Promise.all([restarted.get('s1'), restarted.get('s1')])
    const doc = restored[0]
    expect(concurrent[0].revision).toBe(doc.revision)
    expect(doc.state).toBe('interrupted'); expect(doc.published[0].name).toBe('B.txt')
    await writeFile(join(f.root, 'B.txt'), '后来改写')
    expect(await readFile(await restarted.storage.verify(doc.published[0]), 'utf8')).toBe('B')
    const owner = {}; restarted.begin('s1', 't1', owner, true)
    expect((await restarted.get('s1'))[0].published).toMatchObject([{ name: 'B.txt' }])
    await restarted.stage('s1', f.context, owner, 'clear', []); await restarted.settle('s1', 'clear', true)
    await restarted.finalize('s1', 't1', owner, 'completed')
    expect((await restarted.get('s1'))[0].published).toEqual([])
  })
  it('副本损坏、错误会话/回合/版本/ID明确报错', async () => {
    const f = await fixture(); await f.report([{ path: 'B.txt' }]); await f.service.finalize('s1', 't1', f.owner, 'completed')
    const doc = (await f.service.get('s1'))[0]
    const target = { sessionId: 's1', turnId: 't1', revision: doc.revision, outputId: doc.published[0].outputId, version: 'delivery' as const }
    await expect(f.service.resolve({ ...target, sessionId: 's2' }, f.files)).rejects.toThrow('不存在')
    await expect(f.service.resolve({ ...target, outputId: 'fake' }, f.files)).rejects.toThrow('不属于')
    await expect(f.service.resolve({ ...target, revision: doc.revision - 1 }, f.files)).rejects.toThrow('已更新')
    await writeFile(await f.service.storage.verify(doc.published[0]), 'X')
    await expect(f.service.resolve(target, f.files)).rejects.toThrow('校验失败')
    await writeFile(join(f.service.storage.turnPath('s1', 't1'), 'manifest.json'), '{}')
    await expect(f.service.get('s1')).rejects.toThrow()
  })
  it('Markdown依赖只解析同清单保存版本，不混入当前源文件', async () => {
    const f = await fixture(); await writeFile(join(f.root, '报告.md'), '# 文档\n![图片](B.txt)')
    await f.report([{ path: '报告.md' }, { path: 'B.txt' }]); await f.service.finalize('s1', 't1', f.owner, 'completed')
    const doc = (await f.service.get('s1'))[0]
    const md = await f.service.resolve({ sessionId: 's1', turnId: 't1', revision: doc.revision, outputId: doc.published[0].outputId, version: 'delivery' }, f.files)
    await rm(join(f.root, 'B.txt'))
    const dependency = await f.files.resolve('s1', 'B.txt', 't1', md.fileId)
    expect(dependency.delivery).toBeDefined()
    await expect(f.files.resolve('s1', 'C.txt', 't1', md.fileId)).rejects.toThrow('依赖未保存')
  })
  it('删除会话回收受管字节，源文件仍在，旧owner无法回写', async () => {
    const f = await fixture(); await f.report([{ path: 'B.txt' }])
    const reading = f.service.get('s1')
    await f.service.releaseSession('s1')
    expect(await reading).toEqual([])
    await expect(f.service.stage('s1', f.context, f.owner, 'late', [{ path: 'C.txt' }])).rejects.toThrow('已失效')
    await vi.waitFor(async () => expect(await f.service.get('s1')).toEqual([]))
    await f.service.drain()
    expect(await f.service.storage.list('s1')).toEqual([])
    expect(await readFile(join(f.root, 'B.txt'), 'utf8')).toBe('B')
    await mkdir(join(f.root, 'unrelated')); expect(() => f.service.storage.managed('../unrelated')).toThrow('越界')
  })
  it('清空后再申报身份稳定；打开预览的副本直到关闭后才被回收', async () => {
    const f = await fixture()
    const first = await f.report([{ path: 'B.txt' }]); await f.report([])
    const next = await f.report([{ path: 'B.txt' }])
    expect(next.active[0].outputId).toBe(first.active[0].outputId)
    await f.service.finalize('s1', 't1', f.owner, 'completed')
    const doc = (await f.service.get('s1'))[0]
    const old = doc.published[0]
    const descriptor = await f.service.resolve({ sessionId: 's1', turnId: 't1', revision: doc.revision, outputId: old.outputId, version: 'delivery' }, f.files)
    f.service.begin('s1', 't1', f.owner, true)
    await f.report([]); await f.service.finalize('s1', 't1', f.owner, 'completed'); await f.service.get('s1')
    expect((await f.files.readText({ sessionId: 's1', fileId: descriptor.fileId, version: descriptor.version, operationId: 'lease' })).text).toBe('B')
    f.files.cancel('s1', 'lease', descriptor.fileId)
    await f.service.get('s1')
    await expect(f.service.storage.verify(old)).rejects.toThrow()
  }, 15000)
  it('两个会话的同名toolCallId各自确认，不串清单或丢事务锁', async () => {
    const f = await fixture(); const other = {}
    f.service.begin('s2', 't1', other)
    await f.service.stage('s1', f.context, f.owner, 'same-call', [{ path: 'B.txt' }])
    await f.service.stage('s2', f.context, other, 'same-call', [{ path: 'C.txt' }])
    await f.service.settle('s2', 'same-call', true); await f.service.settle('s1', 'same-call', true)
    expect((await f.service.get('s1'))[0].active[0].name).toBe('B.txt')
    expect((await f.service.get('s2'))[0].active[0].name).toBe('C.txt')
  })
})
