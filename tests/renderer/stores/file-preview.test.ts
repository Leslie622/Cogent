/** 并行文件、迟到响应与租约/Blob所有权，使用真实的两个store。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDescriptor } from '@shared/files'
import { useFilePreviewStore } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'
const descriptor = (id: string, kind: FileDescriptor['kind'] = 'text'): FileDescriptor => ({ fileId: id, serviceId: 'host', path: '/work/' + id, name: id, kind, mime: 'text/plain', size: 4, version: 'v', source: 'saved' })
const lease = (id: string, kind: FileDescriptor['kind'] = 'text') => ({ leaseId: id, descriptor: descriptor(id, kind), canonicalKey: id, ownerId: 'host' })
const scope = { sessionId: 'a', turnId: 'turn', refs: [] }
const request = vi.fn<(method: string, params: { source?: { rawTarget?: string }; leaseId?: string }) => Promise<unknown>>()
const revoke = vi.fn()
beforeEach(() => {
  request.mockReset().mockResolvedValue({ ok: true })
  revoke.mockReset()
  window.cogent = { fileViewsRequest: request } as unknown as typeof window.cogent
  useFilePreviewStore.getState().resetAll()
  useWorkspaceStore.getState().reset()
  useWorkspaceStore.getState().setScope('a')
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:test'); static revokeObjectURL = revoke })
})
afterEach(() => { useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset(); vi.unstubAllGlobals() })
describe('文件预览所有权', () => {
  it('当前标签切换文件释放旧Blob/lease并清理阅读状态，旧视图退出不能写回新文件', async () => {
    request.mockImplementation((method, params) => method === 'fileViews.acquire' ? Promise.resolve(lease(params.source!.rawTarget!, params.source!.rawTarget === 'a.png' ? 'image' : 'text')) : method === 'fileViews.readChunk' ? Promise.resolve({ base64: btoa('data'), done: true, nextOffset: 4 }) : method === 'fileViews.readText' ? Promise.resolve({ text: '新的文件', encoding: 'utf-8' }) : Promise.resolve({ ok: true }))
    await useFilePreviewStore.getState().open(scope, 'a.png')
    const previous = useFilePreviewStore.getState().current!, id = previous.tabId
    useFilePreviewStore.getState().setView(id, { page: 9, scrollTop: 888, zoom: 2 })
    await useFilePreviewStore.getState().navigate(id, scope, 'b.txt')
    expect(useWorkspaceStore.getState().scopes.a.tabs.map(tab => tab.id)).toEqual([id])
    expect(useFilePreviewStore.getState().current).toMatchObject({ tabId: id, rawTarget: 'b.txt', text: '新的文件', error: null })
    expect(useFilePreviewStore.getState().views[id]).toBeUndefined()
    expect(revoke).toHaveBeenCalledWith('blob:test')
    expect(request).toHaveBeenCalledWith('fileViews.release', { leaseId: 'a.png' })
    useFilePreviewStore.getState().setView(id, { scrollTop: 888 }, previous.generation)
    expect(useFilePreviewStore.getState().views[id]).toBeUndefined()
  })

  it('同一标签快速A→B→C时，迟到B只释放租约，C的内容和身份保留', async () => {
    let finishB!: (value: ReturnType<typeof lease>) => void
    request.mockImplementation((method, params) => {
      if (method === 'fileViews.acquire') return params.source!.rawTarget === 'b' ? new Promise(resolve => { finishB = resolve }) : Promise.resolve(lease(params.source!.rawTarget!))
      return method === 'fileViews.readText' ? Promise.resolve({ text: params.leaseId, encoding: 'utf-8' }) : Promise.resolve({ ok: true })
    })
    await useFilePreviewStore.getState().open(scope, 'a')
    const id = useFilePreviewStore.getState().current!.tabId
    const pending = useFilePreviewStore.getState().navigate(id, scope, 'b')
    await useFilePreviewStore.getState().navigate(id, scope, 'c')
    finishB(lease('b')); await pending
    expect(useFilePreviewStore.getState().current).toMatchObject({ tabId: id, rawTarget: 'c', text: 'c' })
    expect(useWorkspaceStore.getState().scopes.a.tabs.map(tab => tab.id)).toEqual([id])
    expect(request).toHaveBeenCalledWith('fileViews.release', { leaseId: 'b' })
    expect(request).not.toHaveBeenCalledWith('fileViews.readText', expect.objectContaining({ leaseId: 'b' }))
    useFilePreviewStore.getState().close(id)
    await useFilePreviewStore.getState().navigate(id, scope, 'late')
    expect(useWorkspaceStore.getState().scopes.a.tabs).toHaveLength(0)
  })
  it.each(['report.docx', 'book.xlsx', 'book.xlsm', 'book.xls', 'slides.pptx', 'legacy.doc'])('Office预览保留%s的原始字节，不请求附件文本替代版式', async (name) => {
    const bytes = new Uint8Array([80, 75, 3, 4])
    request.mockImplementation(method => method === 'fileViews.acquire' ? Promise.resolve(lease(name, 'office')) : method === 'fileViews.readChunk' ? Promise.resolve({ base64: btoa(String.fromCharCode(...bytes)), done: true, nextOffset: bytes.length }) : Promise.resolve({ ok: true }))
    await useFilePreviewStore.getState().open(scope, name)
    expect(request).toHaveBeenCalledWith('fileViews.readChunk', expect.objectContaining({ leaseId: name, version: 'v', offset: 0 }))
    expect(request.mock.calls.some(([method]) => method === 'fileViews.parseDocument')).toBe(false)
    expect(useFilePreviewStore.getState().current).toMatchObject({ text: null, document: null, url: 'blob:test', bytes: 4, loading: false, error: null })
  })
  it.each([['large.docx', 26], ['large.xlsx', 26], ['large.pptx', 65]])('过大的%s在读取前给出可视化预算错误', async (name, size) => {
    const acquired = lease(name, 'office')
    acquired.descriptor.size = Number(size) * 1024 ** 2
    request.mockImplementation(method => method === 'fileViews.acquire' ? Promise.resolve(acquired) : Promise.resolve({ ok: true }))
    await useFilePreviewStore.getState().open(scope, name)
    expect(request.mock.calls.some(([method]) => method === 'fileViews.readChunk')).toBe(false)
    expect(useFilePreviewStore.getState().current?.error).toContain('预览容量')
  })
  it('关闭后到达的acquire释放租约，不能发起读取或复活标签', async () => {
    let complete!: (value: ReturnType<typeof lease>) => void
    request.mockImplementation(method => method === 'fileViews.acquire' ? new Promise(resolve => { complete = resolve }) : Promise.resolve({ ok: true }))
    const pending = useFilePreviewStore.getState().open(scope, './a.txt')
    useFilePreviewStore.getState().close(); complete(lease('a.txt')); await pending
    expect(useFilePreviewStore.getState().current).toBeNull()
    expect(request).not.toHaveBeenCalledWith('fileViews.readText', expect.anything())
    expect(request).toHaveBeenCalledWith('fileViews.release', { leaseId: 'a.txt' })
  })
  it('A切到B后，A仍独立读取；切回A保留失败信息且不污染B', async () => {
    let fail!: (reason: Error) => void
    request.mockImplementation((method, params) => {
      if (method === 'fileViews.acquire') return Promise.resolve(lease(params.source!.rawTarget!))
      if (method === 'fileViews.readText') return params.leaseId === 'a' ? new Promise((_resolve, reject) => { fail = reject }) : Promise.resolve({ text: 'B', encoding: 'utf-8' })
      return Promise.resolve({ ok: true })
    })
    const first = useFilePreviewStore.getState().open(scope, 'a')
    await vi.waitFor(() => expect(fail).toBeDefined())
    const a = useWorkspaceStore.getState().scopes.a.activeId!
    await useFilePreviewStore.getState().open(scope, 'b')
    fail(new Error('A读取失败')); await first
    expect(useFilePreviewStore.getState().current).toMatchObject({ text: 'B', error: null })
    useWorkspaceStore.getState().activate(a)
    expect(useFilePreviewStore.getState().current?.error).toBe('A读取失败')
    expect(request).not.toHaveBeenCalledWith('fileViews.release', { leaseId: 'a' })
  })
  it('分片以同一版本读取；后台切换不释放，关闭才回收Blob', async () => {
    request.mockImplementation(method => method === 'fileViews.acquire' ? Promise.resolve(lease('a.png', 'image')) : method === 'fileViews.readChunk' ? Promise.resolve({ base64: btoa('data'), done: true, nextOffset: 4 }) : Promise.resolve({ ok: true }))
    await useFilePreviewStore.getState().open(scope, 'a.png')
    const id = useFilePreviewStore.getState().current!.tabId
    useWorkspaceStore.getState().newTab()
    expect(revoke).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith('fileViews.readChunk', expect.objectContaining({ version: 'v', leaseId: 'a.png' }))
    useFilePreviewStore.getState().close(id)
    expect(revoke).toHaveBeenCalledWith('blob:test')
    expect(request).toHaveBeenCalledWith('fileViews.release', { leaseId: 'a.png' })
  })
  it('别名归并仅释放多余租约；预算回收保留阅读位置及标签', async () => {
    let sequence = 0
    request.mockImplementation(method => method === 'fileViews.acquire' ? Promise.resolve({ ...lease('same'), leaseId: 'lease-' + ++sequence }) : method === 'fileViews.readText' ? Promise.resolve({ text: 'content', encoding: 'utf-8' }) : Promise.resolve({ ok: true }))
    await useFilePreviewStore.getState().open(scope, './a')
    const id = useFilePreviewStore.getState().current!.tabId
    await useFilePreviewStore.getState().open(scope, '/work/a')
    expect(useWorkspaceStore.getState().scopes.a.tabs).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('fileViews.release', { leaseId: 'lease-2' })
    useFilePreviewStore.getState().setView(id, { scrollTop: 345 })
    useWorkspaceStore.getState().newTab()
    useFilePreviewStore.getState().trim(0)
    expect(useFilePreviewStore.getState().byTab[id]).toMatchObject({ evicted: true, text: null, leaseId: 'lease-1' })
    expect(useFilePreviewStore.getState().views[id].scrollTop).toBe(345)
    expect(request).not.toHaveBeenCalledWith('fileViews.release', { leaseId: 'lease-1' })
  })
})
