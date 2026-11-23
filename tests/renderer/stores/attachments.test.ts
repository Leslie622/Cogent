/** 草稿异步身份与同步恢复日志，覆盖页面卸载之外的存活边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindChatDraft, EMPTY_DRAFT, useAttachmentStore } from '@/stores/attachments'
import { attachmentMime, type AttachmentRef, type DirectoryRef } from '@shared/attachments'

const previous = window.cogent
const ref: AttachmentRef = { id: '11111111-1111-1111-1111-111111111111', name: 'a.txt', size: 3, mime: 'text/plain', sha256: 'a'.repeat(64) }
const request = vi.fn()
function draft(id: string) { return useAttachmentStore.getState().drafts[id]! }
function reference(path: string, size = 3): AttachmentRef {
  const name = path.split(/[\\/]/).at(-1)!
  return { ...ref, id: crypto.randomUUID(), name, size, mime: attachmentMime(name) }
}
function sourceMock(importer: (path: string) => Promise<AttachmentRef>, size: (path: string) => number = () => 3) {
  const previousRequest = request.getMockImplementation()! as (method: string, params: { path?: string }) => Promise<unknown>
  request.mockImplementation((method: string, params: { path?: string }) => {
    if (method === 'attachments.describe') { const value = reference(params.path!, size(params.path!)); return Promise.resolve(value) }
    if (method === 'attachments.importPath') return importer(params.path!)
    return previousRequest(method, params)
  })
}
beforeEach(() => {
  localStorage.clear(); vi.useFakeTimers()
  useAttachmentStore.setState({ drafts: {}, media: {} })
  request.mockReset().mockImplementation((method: string, params: { id?: string }) => {
    if (method === 'attachments.draft') return Promise.resolve({ id: params.id, text: '', attachments: [] })
    if (method === 'attachments.media') return Promise.resolve({})
    if (method === 'attachments.resolve') return Promise.resolve({ ref, path: 'managed-path' })
    if (method === 'attachments.describe') return Promise.resolve({ name: ref.name, size: ref.size, mime: ref.mime })
    if (method === 'attachments.importPath') return Promise.resolve(ref)
    return Promise.resolve({ ok: true })
  })
  window.cogent = { ...previous, engineRequest: request } as typeof window.cogent
})
afterEach(async () => { await vi.runAllTimersAsync(); vi.useRealTimers(); window.cogent = previous })
describe('附件草稿', () => {
  it('目录只探测不复制，同一路径去重，移除不释放/删除目录', async () => {
    const directory: DirectoryRef = { kind: 'directory', name: '文件夹.png', path: 'C:/文件夹.png' }
    const previousRequest = request.getMockImplementation()! as (method: string, params: unknown) => Promise<unknown>
    request.mockImplementation((method: string, params: unknown) => method === 'attachments.describe' ? Promise.resolve(directory) : previousRequest(method, params))
    const store = useAttachmentStore.getState(); await store.load('folder')
    store.add('folder', [directory.path, directory.path]); await vi.runAllTimersAsync()
    expect(draft('folder').items).toHaveLength(1)
    expect(draft('folder').items[0]).toMatchObject({ directory, status: 'ready', size: 0 })
    expect(request.mock.calls.some(([method]) => method === 'attachments.importPath' || method === 'attachments.begin')).toBe(false)
    expect(request.mock.calls.some(([method, params]) => method === 'attachments.saveDraft' && (params as { directories?: unknown }).directories !== undefined)).toBe(true)
    store.remove('folder', draft('folder').items[0].key); await vi.runAllTimersAsync()
    expect(request.mock.calls.some(([method]) => method === 'attachments.release')).toBe(false)
  })
  it('目录草稿重启可恢复，路径暂失保留错误卡，修复后可重试', async () => {
    const directory: DirectoryRef = { kind: 'directory', name: '目录', path: 'C:/目录' }
    localStorage.setItem('cogent.attachment-draft.dir-recover', JSON.stringify({ version: 1, text: '目录正文', items: [{ key: 'directory', name: directory.name, size: 0, directory }] }))
    const previousRequest = request.getMockImplementation()! as (method: string, params: unknown) => Promise<unknown>
    let exists = false
    request.mockImplementation((method: string, params: unknown) => method === 'attachments.describe' ? (exists ? Promise.resolve(directory) : Promise.reject(new Error('ENOENT'))) : previousRequest(method, params))
    const store = useAttachmentStore.getState(); await store.load('dir-recover')
    expect(draft('dir-recover').text).toBe('目录正文')
    expect(draft('dir-recover').items[0]).toMatchObject({ directory, status: 'error' })
    exists = true; store.retry('dir-recover', 'directory'); await vi.runAllTimersAsync()
    expect(draft('dir-recover').items[0]).toMatchObject({ directory, status: 'ready' })
    expect(request.mock.calls.some(([method]) => method === 'attachments.importPath')).toBe(false)
  })
  it('已引用的目录变成文件后重试仍报错，不自动复制并变更引用语义', async () => {
    const directory: DirectoryRef = { kind: 'directory', name: '目录', path: 'C:/目录' }
    const store = useAttachmentStore.getState(); await store.load('changed-dir')
    useAttachmentStore.setState({ drafts: { 'changed-dir': { ...draft('changed-dir'), items: [{ key: 'dir', name: directory.name, size: 0, directory, status: 'error' }] } } })
    store.retry('changed-dir','dir'); await vi.runAllTimersAsync()
    expect(draft('changed-dir').items[0]).toMatchObject({ directory, status: 'error', error: '路径已不是文件夹' })
    expect(request.mock.calls.some(([method]) => method === 'attachments.importPath')).toBe(false)
  })
  it('仅导入不创建聊天，切换后回包只修改原草稿', async () => {
    await useAttachmentStore.getState().load('new-a'); await useAttachmentStore.getState().load('new-b')
    useAttachmentStore.getState().add('new-a', ['C:/a.txt']); await vi.runAllTimersAsync()
    expect(draft('new-a').items[0]).toMatchObject({ status: 'ready', ref })
    expect(draft('new-b').items).toEqual([])
    expect(request.mock.calls.some(([method]) => method === 'session.create')).toBe(false)
  })
  it('移除后的迟到导入结果不能复活附件', async () => {
    await useAttachmentStore.getState().load('new-remove')
    let finish!: (value: AttachmentRef) => void
    request.mockImplementationOnce(() => new Promise<AttachmentRef>((resolve) => { finish = resolve }))
    useAttachmentStore.getState().add('new-remove', ['C:/a.txt'])
    const key = draft('new-remove').items[0].key; useAttachmentStore.getState().remove('new-remove', key)
    finish(ref); await vi.runAllTimersAsync(); expect(draft('new-remove').items).toEqual([])
  })
  it('旧提交成功不能清新提交/后续编辑；成功只消费自己的附件快照', async () => {
    const store = useAttachmentStore.getState(); await store.load('chat-a'); store.setText('chat-a', '同文')
    const snapshot = draft('chat-a'); const old = store.startSubmission('chat-a'); const current = store.startSubmission('chat-a')
    store.consume('chat-a', snapshot, old); expect(draft('chat-a').text).toBe('同文')
    store.setText('chat-a', '后续输入'); store.consume('chat-a', snapshot, current); expect(draft('chat-a').text).toBe('后续输入')
    const next = draft('chat-a'); store.consume('chat-a', next, store.startSubmission('chat-a')); expect(draft('chat-a').text).toBe('')
  })
  it('Host 尚未确认时同步日志可恢复文字与原件引用，日志不序列化 File', async () => {
    const store = useAttachmentStore.getState(); await store.load('recover'); store.setText('recover', '未确认正文')
    expect(localStorage.getItem('cogent.attachment-draft.recover')).toContain('未确认正文')
    useAttachmentStore.setState({ drafts: {} }); await store.load('recover')
    expect(draft('recover').text).toBe('未确认正文'); expect(draft('recover').loaded).toBe(true)
  })
  it('删除会话后，迟到的原件校验不会恢复已绑定草稿或重新写盘', async () => {
    const sessionId = 'delete-during-recovery'
    const id = 'original-new-draft'
    const journal = `cogent.attachment-draft.${id}`
    bindChatDraft(sessionId, id)
    localStorage.setItem(journal, JSON.stringify({ version: 1, text: '已删除正文', items: [{ key: ref.id, name: ref.name, size: ref.size, ref }] }))
    let signalValidationStarted!: () => void
    const validationStarted = new Promise<void>((resolve) => { signalValidationStarted = resolve })
    let finishValidation!: (value: { ref: AttachmentRef; path: string }) => void
    const validation = new Promise<{ ref: AttachmentRef; path: string }>((resolve) => { finishValidation = resolve })
    const fallback = request.getMockImplementation()! as (method: string, params: unknown) => Promise<unknown>
    request.mockImplementation((method: string, params: unknown) => {
      if (method !== 'attachments.resolve') return fallback(method, params)
      signalValidationStarted()
      return validation
    })

    const store = useAttachmentStore.getState()
    const recovery = store.load(id)
    await validationStarted
    await store.discardChat(sessionId)
    finishValidation({ ref, path: 'managed-path' })
    await recovery
    await vi.runAllTimersAsync()

    expect(draft(id)).toEqual({ ...EMPTY_DRAFT, loaded: true })
    expect(localStorage.getItem(journal)).toBeNull()
    expect(localStorage.getItem(`cogent.chat-draft.${sessionId}`)).toBeNull()
    expect(request.mock.calls.filter(([method]) => method === 'attachments.saveDraft')).toEqual([
      ['attachments.saveDraft', { id, text: '', attachmentIds: [] }]
    ])
  })
  it('未完成导入重启后显示错误，既有原件缺失也不能变成 ready', async () => {
    localStorage.setItem('cogent.attachment-draft.interrupted', JSON.stringify({ version: 1, text: '原文', items: [{ key: 'pending', name: '导入中.txt', size: 3 }] }))
    await useAttachmentStore.getState().load('interrupted'); expect(draft('interrupted').items[0]).toMatchObject({ status: 'error' })
    request.mockImplementation((method: string) => method === 'attachments.resolve' ? Promise.reject(new Error('ENOENT')) :
      Promise.resolve(method === 'attachments.draft' ? { id: 'missing', text: '', attachments: [ref] } : {}))
    await useAttachmentStore.getState().load('missing'); expect(draft('missing').items[0].status).toBe('error'); expect(draft('missing').items[0].error).toContain('不可用')
  })
  it('损坏恢复日志不会静默重建空草稿', async () => {
    localStorage.setItem('cogent.attachment-draft.bad', '{broken')
    await useAttachmentStore.getState().load('bad')
    expect(draft('bad').loaded).toBe(false); expect(draft('bad').error).toContain('恢复失败')
    expect(EMPTY_DRAFT.text).toBe('')
  })
  it('100个普通文件不被20项截断，复制始终最多两项并发', async () => {
    let active = 0; let peak = 0
    sourceMock(async (path) => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return reference(path) })
    const store = useAttachmentStore.getState(); await store.load('many')
    store.add('many', Array.from({ length: 100 }, (_, i) => `C:/file-${i}.txt`))
    await vi.runAllTimersAsync()
    expect(draft('many').items).toHaveLength(100)
    expect(draft('many').items.every((item) => item.status === 'ready')).toBe(true)
    expect(peak).toBe(2); expect(draft('many').rejections).toEqual([])
    expect(new Set(draft('many').items.map((item) => item.ref!.id)).size).toBe(100)
  })
  it('21图加普通文件只拒绝第21图，未加入明细保留名称与原因', async () => {
    sourceMock((path) => Promise.resolve(reference(path)))
    const store = useAttachmentStore.getState(); await store.load('images')
    store.add('images', [...Array.from({ length: 21 }, (_, i) => `C:/image-${i}.png`), 'C:/a.txt', 'C:/b.txt'])
    await vi.runAllTimersAsync()
    expect(draft('images').items).toHaveLength(22)
    expect(draft('images').items.every((item) => item.status === 'ready')).toBe(true)
    expect(draft('images').rejections).toEqual([{ name: 'image-20.png', reason: '每条消息最多添加 20 张图片' }])
    store.clearRejections('images'); expect(draft('images').rejections).toEqual([])
  })
  it('未知路径大小先探测，200MiB满额后多出的文件不进入复制', async () => {
    const sizes: Record<string, number> = { 'C:/a.txt': 80 * 1024**2, 'C:/b.txt': 80 * 1024**2, 'C:/c.txt': 40 * 1024**2, 'C:/extra.txt': 1, 'C:/oversize.txt': 100 * 1024**2 + 1 }
    const copied: string[] = []
    sourceMock((path) => { copied.push(path); return Promise.resolve(reference(path, sizes[path])) }, (path) => sizes[path])
    const store = useAttachmentStore.getState(); await store.load('capacity'); store.add('capacity', Object.keys(sizes))
    await vi.runAllTimersAsync()
    expect(copied).toEqual(['C:/a.txt', 'C:/b.txt', 'C:/c.txt'])
    expect(draft('capacity').items.reduce((sum,item) => sum + item.size,0)).toBe(200 * 1024**2)
    expect(draft('capacity').rejections?.map((item) => item.name)).toEqual(['extra.txt', 'oversize.txt'])
    expect(draft('capacity').items.every((item) => item.status === 'ready')).toBe(true)
  })
  it('探测后源文件增长时释放超额副本，不将其变成ready', async () => {
    sourceMock((path) => Promise.resolve(reference(path, 50 * 1024**2)), () => 30 * 1024**2)
    const store = useAttachmentStore.getState(); await store.load('growing')
    const existing = ['a', 'b'].map((key) => ({ key, ref: reference(`C:/${key}.txt`,80 * 1024**2), name: key, size: 80 * 1024**2, status: 'ready' as const }))
    useAttachmentStore.setState({ drafts: { growing: { ...draft('growing'), items: existing } } })
    store.add('growing', ['C:/grew.txt']); await vi.runAllTimersAsync()
    expect(draft('growing').items).toEqual(existing)
    expect(draft('growing').rejections?.[0]).toMatchObject({ name: 'grew.txt' })
    expect(request.mock.calls.some(([method]) => method === 'attachments.release')).toBe(true)
  })
  it('排队移除不发请求，在途移除晚返回只释放，其他任务继续排队且不超并发', async () => {
    const pending = new Map<string, (value: AttachmentRef) => void>(); const started: string[] = []
    let active = 0; let peak = 0
    sourceMock((path) => new Promise((resolve) => {
      active++; peak = Math.max(peak,active); started.push(path)
      pending.set(path, (value) => { active--; pending.delete(path); resolve(value) })
    }))
    const store = useAttachmentStore.getState(); await store.load('queue')
    store.add('queue', Array.from({ length: 5 }, (_,i) => `C:/${i}.txt`)); await vi.runAllTimersAsync()
    expect(started).toEqual(['C:/0.txt','C:/1.txt'])
    expect(draft('queue').items.map((item) => item.status)).toEqual(['importing','importing','queued','queued','queued'])
    const items = draft('queue').items
    store.remove('queue',items[2].key); store.remove('queue',items[1].key)
    pending.get('C:/0.txt')!(reference('C:/0.txt')); await vi.runAllTimersAsync()
    expect(started).toEqual(['C:/0.txt','C:/1.txt','C:/3.txt'])
    const removed = reference('C:/1.txt'); pending.get('C:/1.txt')!(removed); await vi.runAllTimersAsync()
    expect(request).toHaveBeenCalledWith('attachments.release',{ id: removed.id })
    while (pending.size > 0) {
      const [path, finish] = [...pending][0]; finish(reference(path)); await vi.runAllTimersAsync()
    }
    expect(peak).toBe(2); expect(started).not.toContain('C:/2.txt')
    expect(draft('queue').items.map((item) => item.name)).toEqual(['0.txt','3.txt','4.txt'])
    expect(draft('queue').items.every((item) => item.status === 'ready')).toBe(true)
  })
})
