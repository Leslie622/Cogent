/** 真磁盘验证 lease/旧入口兼容、无会话 owner、父租约竞态及 frozen HTML 资源。 */
import { mkdtemp, writeFile, rm, mkdir, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileService } from '../../../../src/host/runtime/files/reader'
import { OutputsService } from '../../../../src/host/runtime/outputs/service'
import { FileViewsService } from '../../../../src/host/runtime/file-views/service'
import { fileViewHandlers } from '../../../../src/host/runtime/file-views/handlers'
import { FileScanEngine } from '../../../../src/host/runtime/file-views/scan-engine'
import type { DirectoryScanner } from '../../../../src/host/runtime/file-views/scanner'
import type { FileContext } from '../../../../src/shared/files'

const fixtures: Array<{ root: string; service: FileViewsService; outputs: OutputsService }> = []
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { f.service.dispose(); await f.outputs.drain(); f.outputs.dispose(); await rm(f.root, { recursive: true, force: true }) } })
async function fixture(scanner?: DirectoryScanner) {
  const root = await mkdtemp(join(tmpdir(), 'cogent-file-views-'))
  await writeFile(join(root, 'a.txt'), '原件 A'); await writeFile(join(root, 'index.html'), '<script src="./app.js"></script>'); await writeFile(join(root, 'app.js'), 'window.saved = true')
  const context: FileContext = { version: 1, turnId: 'turn', userEntryId: 'user', cwd: root, roots: [root], platform: process.platform }
  const source = vi.fn((id: string) => { if (id !== 'session') throw new Error('会话不存在'); return { context, saved: true } })
  const files = new FileService(source); const outputs = new OutputsService(root, () => {})
  const engine = new FileScanEngine()
  const service = new FileViewsService(files, outputs, scanner ?? { run: (request, signal) => engine.run(request, signal), dispose: () => {} })
  fixtures.push({ root, service, outputs })
  return { root, files, outputs, service, source, context }
}
describe('多标签文件资源', () => {
  it('项目搜索排除文件与外部目录grant，授权仍可独立读取预览', async () => {
    const f = await fixture()
    const project = join(f.root, 'project'), external = join(f.root, 'external')
    await mkdir(project); await mkdir(external)
    await writeFile(join(project, 'wanted-project.txt'), '项目文件')
    await writeFile(join(external, 'wanted-external.txt'), '外部文件')
    const selectedFile = join(f.root, 'wanted-single.txt'); await writeFile(selectedFile, '单文件')
    const roots = [
      { id: 'project', path: project, name: '项目', kind: 'directory' as const },
      { id: 'external', path: external, name: '外部', kind: 'directory' as const, grantId: 'external-grant' },
      { id: 'file', path: selectedFile, name: '单文件', kind: 'file' as const, grantId: 'file-grant' }
    ]
    const context = await f.service.registerContext(1, 'session', roots)
    const result = await f.service.search({ windowId: 1, contextId: context.contextId, query: 'wanted', operationId: 'project-search' })
    expect(result.entries.map(entry => entry.name)).toEqual(['wanted-project.txt'])
    expect(context.grantIds).toEqual(['external-grant', 'file-grant'])
    const lease = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(external, 'wanted-external.txt') }, 'external-preview')
    expect(await f.service.readText(1, { leaseId: lease.leaseId, version: lease.descriptor.version, operationId: 'external-read' })).toMatchObject({ text: '外部文件' })
    const ordinary = await f.service.registerContext(1, 'ordinary', roots.slice(1))
    const empty = await f.service.search({ windowId: 1, contextId: ordinary.contextId, query: 'wanted', operationId: 'ordinary-search' })
    expect(empty.entries).toEqual([])
    expect(empty.complete).toBe(true)
    const single = await f.service.acquire(1, { kind: 'context', contextId: ordinary.contextId, path: selectedFile }, 'single-preview')
    expect(await f.service.readText(1, { leaseId: single.leaseId, version: single.descriptor.version, operationId: 'single-read' })).toMatchObject({ text: '单文件' })
  })

  it('页面重载撤销旧context/lease且允许同windowId的新代请求，旧载荷不能在reset后复活', async () => {
    const f = await fixture(); const handlers = new Map(fileViewHandlers(f.service))
    const context = await f.service.registerContext(1, 'draft', [{ id: 'r', path: f.root, name: '根', kind: 'directory' }])
    const old = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'a.txt') }, 'file')
    f.service.cancel(1, 'repeat')
    f.service.resetWindow(1, 1)
    await expect(f.files.actionTarget({ sessionId: old.ownerId, fileId: old.descriptor.fileId })).rejects.toThrow()
    expect(() => handlers.get('fileViews.acquire')!({ windowId: 1, windowEpoch: 0, source: { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, operationId: 'late' })).toThrow('重载')
    expect(() => f.service.resetWindow(1, 0)).toThrow('重载')
    await expect(f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'a.txt') }, 'old-context')).rejects.toThrow('上下文')
    const fresh = await handlers.get('fileViews.acquire')!({ windowId: 1, windowEpoch: 1, source: { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, operationId: 'repeat' }) as Awaited<ReturnType<FileViewsService['acquire']>>
    expect(await f.service.readText(1, { leaseId: fresh.leaseId, version: fresh.descriptor.version, operationId: 'read' })).toMatchObject({ text: '原件 A' })
    f.service.resetWindow(1, 1) // 同代ACK重试不撤销已恢复的资源。
    expect(await f.service.actionTarget(1, fresh.leaseId)).toMatchObject({ kind: 'text' })
  })
  it('重载前正等待根复核的registerContext失败，新代可恢复同scope', async () => {
    const f = await fixture(); const roots = [{ id: 'r', path: f.root, name: '根', kind: 'directory' as const }]
    const pending = f.service.registerContext(1, 'draft', roots)
    f.service.resetWindow(1, 1)
    await expect(pending).rejects.toThrow('重载')
    expect(await f.service.registerContext(1, 'draft', roots)).toMatchObject({ roots: [{ path: f.root }] })
  })
  it('重载取消已持有父lease的在途acquire，新代相同operationId不受旧代取消影响', async () => {
    const f = await fixture(); const parent = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './index.html' }, 'parent')
    const resolve = f.files.resolve.bind(f.files); let registered = ''; let finish!: () => void
    const gate = new Promise<void>(done => { finish = done })
    const spy = vi.spyOn(f.files, 'resolve').mockImplementation(async (...args) => { const descriptor = await resolve(...args); registered = descriptor.fileId; await gate; return descriptor })
    const pending = f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './app.js', relativeTo: parent.leaseId }, 'repeat')
    await vi.waitFor(() => expect(registered).not.toBe('')); const staleFile = registered
    f.service.resetWindow(1, 1); spy.mockRestore()
    const fresh = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, 'repeat')
    finish(); await expect(pending).rejects.toThrow('取消')
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: staleFile })).rejects.toThrow('失效')
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: parent.descriptor.fileId })).rejects.toThrow('失效')
    expect(await f.service.readText(1, { leaseId: fresh.leaseId, version: fresh.descriptor.version, operationId: 'read' })).toMatchObject({ text: '原件 A' })
  })
  it('旧代close ACK不能终止新代已开始的目录扫描，旧扫描也不发布迟到结果', async () => {
    let finishClose!: () => void; let finishScan!: (value: unknown) => void; const dispose = vi.fn()
    const f = await fixture({ run: (request) => request.kind === 'close' ? new Promise(resolve => { finishClose = () => resolve({ ok: true }) }) : new Promise(resolve => { finishScan = resolve as (value: unknown) => void }), dispose })
    const roots = [{ id: 'r', path: f.root, name: '根', kind: 'directory' as const }]
    await f.service.registerContext(1, 'draft', roots)
    f.service.resetWindow(1, 1)
    const fresh = await f.service.registerContext(1, 'draft', roots)
    const scan = f.service.listDirectory({ windowId: 1, contextId: fresh.contextId, directoryId: fresh.roots[0].id, operationId: 'scan' })
    finishClose(); await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(dispose).not.toHaveBeenCalled()
    f.service.resetWindow(1, 2)
    finishScan({ entries: [], generation: 1, complete: true, truncated: false })
    await expect(scan).rejects.toThrow()
    finishClose()
  })
  it('重载前HTML子资源resolve迟到只能清理登记，不能向新代发布lease', async () => {
    const f = await fixture(); const parent = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './index.html' }, 'parent')
    const register = f.files.registerPath.bind(f.files); let registered = ''; let finish!: () => void
    const gate = new Promise<void>(done => { finish = done })
    vi.spyOn(f.files, 'registerPath').mockImplementation(async (...args) => { const descriptor = await register(...args); registered = descriptor.fileId; await gate; return descriptor })
    const pending = f.service.previewResource(1, parent.leaseId, './app.js')
    await vi.waitFor(() => expect(registered).not.toBe(''))
    f.service.resetWindow(1, 1); finish()
    await expect(pending).rejects.toThrow('来源已关闭')
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: registered })).rejects.toThrow('失效')
  })
  it('上下文登记正等待文件系统时删会话，迟到根不能发布新的context', async () => {
    const f = await fixture()
    const pending = f.service.registerContext(1, 'session', [{ id: 'r', path: f.root, name: '根', kind: 'directory' }])
    f.service.releaseSession('session')
    await expect(pending).rejects.toThrow('已删除')
    await expect(f.service.registerContext(1, 'session', [])).rejects.toThrow('已删除')
  })
  it('HTML资源在删除会话后才resolve完成，只释放临时登记不发布新lease', async () => {
    const f = await fixture(); const parent = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './index.html' }, 'parent')
    const register = f.files.registerPath.bind(f.files); let registered = ''; let finish!: () => void
    const gate = new Promise<void>((done) => { finish = done })
    vi.spyOn(f.files, 'registerPath').mockImplementation(async (...args) => { const descriptor = await register(...args); registered = descriptor.fileId; await gate; return descriptor })
    const pending = f.service.previewResource(1, parent.leaseId, './app.js')
    await vi.waitFor(() => expect(registered).not.toBe(''))
    f.service.releaseSession('session'); finish()
    await expect(pending).rejects.toThrow('已删除')
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: registered })).rejects.toThrow('失效')
  })
  it('会话删除不允许已在途原生目标复核返回成功', async () => {
    const f = await fixture(); const lease = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, 'file')
    const action = f.files.actionTarget.bind(f.files); let started = false; let finish!: () => void
    const gate = new Promise<void>((done) => { finish = done })
    vi.spyOn(f.files, 'actionTarget').mockImplementation(async (...args) => { const target = await action(...args); started = true; await gate; return target })
    const pending = f.service.actionTarget(1, lease.leaseId)
    await vi.waitFor(() => expect(started).toBe(true))
    f.service.releaseSession('session'); finish()
    await expect(pending).rejects.toThrow('失效')
  })
  it('外部删除session同时回收context，父内链在途登记只能被清理而不能复活', async () => {
    const f = await fixture()
    const context = await f.service.registerContext(1, 'session', [{ id: 'r', path: f.root, name: '根', kind: 'directory' }])
    const tree = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'a.txt') }, 'tree')
    const parent = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './index.html' }, 'parent')
    const resolve = f.files.resolve.bind(f.files); let registered = ''; let finish!: () => void
    const gate = new Promise<void>((done) => { finish = done })
    vi.spyOn(f.files, 'resolve').mockImplementation(async (...args) => { const descriptor = await resolve(...args); registered = descriptor.fileId; await gate; return descriptor })
    const child = f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './app.js', relativeTo: parent.leaseId }, 'child')
    const rejected = expect(child).rejects.toThrow('取消')
    await vi.waitFor(() => expect(registered).not.toBe(''))
    f.service.releaseSession('session')
    f.files.releaseSession('session')
    await expect(f.files.actionTarget({ sessionId: tree.ownerId, fileId: tree.descriptor.fileId })).rejects.toThrow()
    // parent的临时hold仍在：子resolve完成前释放parent会破坏已开始的内链解析。
    expect(await f.files.actionTarget({ sessionId: 'session', fileId: parent.descriptor.fileId })).toMatchObject({ kind: 'text' })
    finish(); await rejected
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: parent.descriptor.fileId })).rejects.toThrow('失效')
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: registered })).rejects.toThrow('失效')
    await expect(f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, 'late')).rejects.toThrow('已删除')
  })
  it('正文session与文件树context打开同原件可归并资源键，释放一个来源不伤另一来源', async () => {
    const f = await fixture()
    const context = await f.service.registerContext(1, 'session', [{ id: 'r', path: f.root, name: '根', kind: 'directory' }])
    const body = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, 'body')
    const tree = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'a.txt') }, 'tree')
    expect(body.canonicalKey).toBe(tree.canonicalKey); expect(body.ownerId).not.toBe(tree.ownerId)
    f.service.release(1, body.leaseId)
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: body.descriptor.fileId })).rejects.toThrow('失效')
    expect(await f.service.readText(1, { leaseId: tree.leaseId, version: tree.descriptor.version, operationId: 'tree-read' })).toMatchObject({ text: '原件 A' })
  })
  it('草稿和提交后新context对同规范目标使用相同资源键，登记仍各自释放', async () => {
    const f = await fixture()
    const root = { id: 'r', path: f.root, name: '根', kind: 'directory' as const }
    const draft = await f.service.registerContext(1, 'draft:one', [root])
    const session = await f.service.registerContext(1, 'session', [root])
    const before = await f.service.acquire(1, { kind: 'context', contextId: draft.contextId, path: join(f.root, 'a.txt') }, 'before')
    const after = await f.service.acquire(1, { kind: 'context', contextId: session.contextId, path: join(f.root, 'a.txt') }, 'after')
    expect(before.canonicalKey).toBe(after.canonicalKey)
    expect(before.ownerId).not.toBe(after.ownerId)
    f.service.release(1, before.leaseId)
    expect(await f.service.readText(1, { leaseId: after.leaseId, version: after.descriptor.version, operationId: 'read' })).toMatchObject({ text: '原件 A' })
  })
  it('窗口并发关闭多个context，等待全部清理ACK后才销毁共享worker', async () => {
    const finish: Array<() => void> = []; const dispose = vi.fn()
    const f = await fixture({ run: () => new Promise((resolve) => { finish.push(() => resolve({ ok: true })) }), dispose })
    await f.service.registerContext(1, 'draft-a', [{ id: 'a', path: f.root, name: 'A', kind: 'directory' }])
    await f.service.registerContext(1, 'draft-b', [{ id: 'b', path: f.root, name: 'B', kind: 'directory' }])
    f.service.releaseWindow(1)
    expect(finish).toHaveLength(2); expect(dispose).not.toHaveBeenCalled()
    finish[0](); await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(dispose).not.toHaveBeenCalled()
    finish[1](); await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
  })
  it('显式 acquire 各有登记，最后 release 使旧ID失效但不夺走legacy ID', async () => {
    const f = await fixture(); const legacy = await f.files.resolve('session', './a.txt')
    const first = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, 'first')
    const second = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, 'second')
    expect(new Set([legacy.fileId, first.descriptor.fileId, second.descriptor.fileId]).size).toBe(3)
    expect(first.canonicalKey).toBe(second.canonicalKey)
    f.service.release(1, first.leaseId)
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: first.descriptor.fileId })).rejects.toThrow('失效')
    expect(await f.service.readText(1, { leaseId: second.leaseId, version: second.descriptor.version, operationId: 'read' })).toMatchObject({ text: '原件 A' })
    expect(await f.files.readText({ sessionId: 'session', fileId: legacy.fileId, version: legacy.version, operationId: 'legacy' })).toMatchObject({ text: '原件 A' })
    expect(() => f.service.release(2, second.leaseId)).toThrow('窗口')
  })
  it('草稿目录独立于session，closeContext等待已打开lease和父内链结束', async () => {
    const f = await fixture(); f.source.mockClear()
    const context = await f.service.registerContext(1, 'draft', [{ id: 'root', name: '根', path: f.root, kind: 'directory' }])
    const parent = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'index.html') }, 'parent')
    f.service.closeContext(1, context.contextId)
    const child = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: './app.js', relativeTo: parent.leaseId }, 'child')
    expect(f.source).not.toHaveBeenCalled()
    f.service.release(1, parent.leaseId)
    expect(await f.service.readText(1, { leaseId: child.leaseId, version: child.descriptor.version, operationId: 'read' })).toMatchObject({ text: 'window.saved = true' })
    f.service.release(1, child.leaseId)
    await expect(f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'a.txt') }, 'late')).rejects.toThrow('上下文')
  })
  it('桌面Markdown相对内链保留URI转义与行列，树的字面百分号路径不解码', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'a b.txt'), 'first\nsecond'); await writeFile(join(f.root, 'literal%20.txt'), 'percent')
    const context = await f.service.registerContext(1, 'draft', [{ id: 'r', name: '根', path: f.root, kind: 'directory' }])
    const parent = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'index.html') }, 'parent')
    const child = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: './a%20b.txt#L2', relativeTo: parent.leaseId }, 'child')
    expect(child.descriptor.path).toBe(join(f.root, 'a b.txt')); expect(child.descriptor.location).toEqual({ line: 2 })
    const literal = await f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'literal%20.txt') }, 'literal')
    expect(literal.descriptor.path).toBe(join(f.root, 'literal%20.txt'))
  })
  it('根外、跨窗口context、junction换目标均被拒绝', async () => {
    const f = await fixture(); const first = join(f.root, 'one'); const second = join(f.root, 'two'); const link = join(f.root, 'link')
    await mkdir(first); await mkdir(second); await writeFile(join(first, 'inside.txt'), 'one'); await writeFile(join(second, 'inside.txt'), 'two')
    await symlink(first, link, 'junction')
    const context = await f.service.registerContext(1, 'draft', [{ id: 'r', path: link, name: '链接根', kind: 'directory' }])
    await expect(f.service.acquire(2, { kind: 'context', contextId: context.contextId, path: join(link, 'inside.txt') }, 'other')).rejects.toThrow('窗口')
    await expect(f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(f.root, 'a.txt') }, 'outside')).rejects.toThrow('授权')
    await unlink(link); await symlink(second, link, 'junction')
    await expect(f.service.acquire(1, { kind: 'context', contextId: context.contextId, path: join(link, 'inside.txt') }, 'changed')).rejects.toThrow('变化')
  })
  it('resolve期间取消不发布租约，并释放刚完成的登记', async () => {
    const f = await fixture(); const original = f.files.resolve.bind(f.files)
    let finish!: () => void
    const delayed = new Promise<void>((resolve) => { finish = resolve })
    let registered = ''
    vi.spyOn(f.files, 'resolve').mockImplementation(async (...args) => { const descriptor = await original(...args); registered = descriptor.fileId; await delayed; return descriptor })
    const pending = f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, 'op')
    await vi.waitFor(() => expect(registered).not.toBe(''))
    f.service.cancel(1, 'op'); finish()
    await expect(pending).rejects.toThrow('取消')
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: registered })).rejects.toThrow('失效')
  })
  it('HTML独立clone在原标签关闭后仍读frozen依赖，拒绝未申报依赖与当前原目录', async () => {
    const f = await fixture(); const owner = {}; f.outputs.begin('session', 'turn', owner)
    await f.outputs.stage('session', f.context, owner, 'report', [{ path: 'index.html' }, { path: 'app.js' }]); await f.outputs.settle('session', 'report', true); await f.outputs.finalize('session', 'turn', owner, 'completed')
    const doc = (await f.outputs.get('session'))[0]
    const target = { sessionId: 'session', turnId: 'turn', revision: doc.revision, outputId: doc.published.find((item) => item.name === 'index.html')!.outputId, version: 'delivery' as const }
    const parent = await f.service.acquire(1, { kind: 'output', target }, 'html')
    const browser = f.service.cloneLease(1, parent.leaseId); f.service.release(1, parent.leaseId)
    await writeFile(join(f.root, 'app.js'), 'changed'); await writeFile(join(f.root, 'private.txt'), 'private')
    const child = await f.service.previewResource(1, browser.leaseId, './app.js')
    expect(await f.service.readText(1, { leaseId: child.leaseId, version: child.descriptor.version, operationId: 'script' })).toMatchObject({ text: 'window.saved = true' })
    expect(child.descriptor.mime).toBe('text/javascript')
    await expect(f.service.previewResource(1, browser.leaseId, './private.txt')).rejects.toThrow('依赖未保存')
  })
  it('HTML显式扩大根可读父级assets，保护目录及其junction仍被Host拒绝', async () => {
    const f = await fixture(); const pages = join(f.root, 'pages'), assets = join(f.root, 'assets'), profile = join(f.root, 'profile')
    await mkdir(pages); await mkdir(assets); await mkdir(profile)
    await writeFile(join(pages, 'index.html'), '<script src="../assets/app.js"></script>'); await writeFile(join(assets, 'app.js'), 'public-script'); await writeFile(join(profile, 'Preferences'), 'private-profile')
    await symlink(profile, join(f.root, 'linked-profile'), 'junction')
    const parent = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './pages/index.html' }, 'parent')
    const policy = { root: { path: f.root, realPath: f.root }, blockedRoots: [profile] }
    await expect(f.service.previewResource(1, parent.leaseId, '../assets/app.js')).rejects.toThrow('超出')
    const child = await f.service.previewResource(1, parent.leaseId, 'assets/app.js', policy)
    expect(await f.service.readText(1, { leaseId: child.leaseId, version: child.descriptor.version, operationId: 'script' })).toMatchObject({ text: 'public-script' })
    for (const path of ['profile/Preferences', 'linked-profile/Preferences']) await expect(f.service.previewResource(1, parent.leaseId, path, policy)).rejects.toThrow('受保护')
    await writeFile(join(assets, 'id_rsa'), 'private-key')
    await expect(f.service.previewResource(1, parent.leaseId, 'assets/id_rsa', policy)).rejects.toThrow('敏感')
  })
  it('HTML依赖在main复核后、Host登记前junction换进保护目录，回收迟到登记', async () => {
    const f = await fixture(); const publicDir = join(f.root, 'public'), profile = join(f.root, 'profile'), link = join(f.root, 'assets')
    await mkdir(publicDir); await mkdir(profile); await writeFile(join(publicDir, 'app.js'), 'public'); await writeFile(join(profile, 'app.js'), 'private'); await symlink(publicDir, link, 'junction')
    const parent = await f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './index.html' }, 'parent')
    const register = f.files.registerPath.bind(f.files); let registered = ''
    vi.spyOn(f.files, 'registerPath').mockImplementation(async (...args) => {
      await unlink(link); await symlink(profile, link, 'junction')
      const descriptor = await register(...args); registered = descriptor.fileId; return descriptor
    })
    await expect(f.service.previewResource(1, parent.leaseId, 'assets/app.js', { root: { path: f.root, realPath: f.root }, blockedRoots: [profile] })).rejects.toThrow('受保护')
    expect(registered).not.toBe('')
    await expect(f.files.actionTarget({ sessionId: 'session', fileId: registered })).rejects.toThrow('失效')
  })
  it('窗口关闭后迟到操作与任意未知source均失败', async () => {
    const f = await fixture(); f.service.releaseWindow(1)
    await expect(f.service.acquire(1, { kind: 'session', sessionId: 'session', rawTarget: './a.txt' }, 'late')).rejects.toThrow('窗口已关闭')
    const handlers = new Map(fileViewHandlers(f.service))
    expect(() => handlers.get('fileViews.acquire')!({ windowId: 2, operationId: 'op', source: { kind: 'exec', path: 'calc' } })).toThrow('来源')
    expect(() => handlers.get('fileViews.readChunk')!({ windowId: 2, leaseId: 'x', version: 'v', operationId: 'op', offset: 0, length: 1024 ** 2 })).toThrow('范围')
  })
})
