/** 草稿独立于页面生命周期；异步导入只拥有捕获的草稿/卡片身份。 */
import { create } from 'zustand'
import { ATTACHMENT_LIMITS, attachmentAdmissionIssue, attachmentMime, isAttachmentRef, isDirectoryRef,
  type AttachmentMetadata, type AttachmentRef, type AttachmentRejection, type MediaBindings, type DirectoryRef } from '@shared/attachments'
import { unwrapIpcError } from '@/lib/ipc'

export interface DraftAttachment {
  key: string
  name: string
  size: number
  status: 'queued' | 'importing' | 'ready' | 'error'
  mime?: string
  ref?: AttachmentRef
  directory?: DirectoryRef
  error?: string
  progress?: number
}
export interface Draft { text: string; items: DraftAttachment[]; loaded: boolean; error: string | null; edit: number; rejections?: AttachmentRejection[] }
export const EMPTY_DRAFT: Draft = { text: '', items: [], loaded: false, error: null, edit: 0 }
export function chatDraftId(sessionId: string): string { return localStorage.getItem(`cogent.chat-draft.${sessionId}`) ?? `chat-${sessionId}` }
export function bindChatDraft(sessionId: string, draftId: string): void { localStorage.setItem(`cogent.chat-draft.${sessionId}`, draftId) }
type Source = File | string
const sources = new Map<string, Source>()
const imports = new Map<string, AbortController>()
const queue: Array<{ id: string; key: string }> = []
const loading = new Map<string, Promise<void>>()
const writes = new Map<string, Promise<unknown>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const submissions = new Map<string, symbol>()
const journalKey = (id: string): string => `cogent.attachment-draft.${id}`

function readJournal(id: string): { text: string; items: DraftAttachment[] } | undefined {
  const text = localStorage.getItem(journalKey(id))
  if (text === null) return undefined
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null) throw new Error('草稿恢复日志损坏')
  const journal = raw as { version?: unknown; text?: unknown; items?: unknown }
  if (journal.version !== 1 || typeof journal.text !== 'string' || !Array.isArray(journal.items)) throw new Error('草稿恢复日志形状不合法')
  const items = journal.items.map((value: unknown): DraftAttachment => {
    if (typeof value !== 'object' || value === null) throw new Error('草稿附件形状不合法')
    const item = value as Partial<DraftAttachment>
    if (typeof item.key !== 'string' || typeof item.name !== 'string' || typeof item.size !== 'number' ||
      (item.ref !== undefined && !isAttachmentRef(item.ref)) || (item.directory !== undefined && !isDirectoryRef(item.directory)) ||
      (item.ref !== undefined && item.directory !== undefined)) throw new Error('草稿附件元数据损坏')
    const incomplete = item.ref === undefined && item.directory === undefined
    return { key: item.key, name: item.name, size: item.size, ref: item.ref, directory: item.directory,
      status: incomplete ? 'error' : 'ready',
      ...(incomplete && { error: '上次导入未完成，请重新选择原文件' }) }
  })
  return { text: journal.text, items }
}

interface DraftState {
  drafts: Partial<Record<string, Draft>>
  media: MediaBindings
  load: (id: string) => Promise<void>
  setText: (id: string, text: string) => void
  add: (id: string, files: Source[]) => void
  remove: (id: string, key: string) => void
  retry: (id: string, key: string) => void
  clearRejections: (id: string) => void
  startSubmission: (id: string) => symbol
  consume: (id: string, snapshot: Draft, token: symbol) => boolean
  discardChat: (sessionId: string) => Promise<void>
}
function patch(id: string, update: (draft: Draft) => Draft): void {
  useAttachmentStore.setState((state) => ({ drafts: { ...state.drafts, [id]: update(state.drafts[id] ?? EMPTY_DRAFT) } }))
}
function metadata(item: DraftAttachment): AttachmentMetadata {
  if (item.directory !== undefined) return { name: item.name, size: 0, mime: 'inode/directory' }
  return item.ref ?? { name: item.name, size: item.size, mime: item.mime ?? attachmentMime(item.name) }
}
function dequeue(key: string): void {
  const index = queue.findIndex((item) => item.key === key)
  if (index >= 0) queue.splice(index, 1)
}
function drain(): void {
  while (imports.size < ATTACHMENT_LIMITS.importConcurrency && queue.length > 0) {
    const item = queue.shift()!
    void runImport(item.id, item.key)
  }
}
function refuse(id: string, key: string, info: AttachmentMetadata, reason: string): void {
  sources.delete(key)
  patch(id, (draft) => ({ ...draft, items: draft.items.filter((item) => item.key !== key),
    rejections: [...(draft.rejections ?? []), { name: info.name, reason }], edit: draft.edit + 1 }))
  save(id)
}
function save(id: string): void {
  const current = useAttachmentStore.getState().drafts[id]!
  // Host 写入是异步 IPC；同步小日志封住关窗/进程退出前尚未确认的窗口。
  const journal = JSON.stringify({ version: 1, text: current.text, items: current.items.map(({ key, name, size, ref, directory }) => ({ key, name, size, ref, directory })) })
  try { localStorage.setItem(journalKey(id), journal) }
  catch (error) { patch(id, (d) => ({ ...d, error: `草稿恢复日志写入失败：${unwrapIpcError(error)}` })) }
  const old = timers.get(id); if (old !== undefined) clearTimeout(old)
  timers.set(id, setTimeout(() => {
    timers.delete(id)
    const draft = current
    const directories = draft.items.flatMap((item) => item.directory === undefined ? [] : [item.directory])
    const snapshot = { id, text: draft.text, attachmentIds: draft.items.flatMap((i) => i.ref === undefined ? [] : [i.ref.id]),
      ...(directories.length > 0 && { directories }) }
    const previous = writes.get(id) ?? Promise.resolve()
    // 每份草稿串行落盘；前一轮失败已在 UI 公开，后续编辑允许重新保存。
    const next = previous.then(() => window.cogent.engineRequest('attachments.saveDraft', snapshot))
      .then(() => {
        if (draft.items.every((item) => item.status === 'ready') && localStorage.getItem(journalKey(id)) === journal) localStorage.removeItem(journalKey(id))
        patch(id, (d) => d.error?.startsWith('草稿保存失败：') === true ? { ...d, error: null } : d)
      }, (error: unknown) => {
        patch(id, (d) => ({ ...d, error: `草稿保存失败：${unwrapIpcError(error)}` }))
      })
    writes.set(id, next)
  }, 150))
}
async function importSource(source: Source, controller: AbortController, progress: (bytes: number) => void): Promise<AttachmentRef> {
  const path = typeof source === 'string' ? source : window.cogent.filePath(source)
  if (path !== '') {
    const operationId = crypto.randomUUID()
    let cancellation: Promise<unknown> | undefined
    const cancel = (): void => { cancellation = window.cogent.engineRequest('attachments.cancel', { id: operationId }) }
    controller.signal.throwIfAborted()
    controller.signal.addEventListener('abort', cancel, { once: true })
    try { return await window.cogent.engineRequest('attachments.importPath', { path, operationId }) }
    finally { controller.signal.removeEventListener('abort', cancel); await cancellation }
  }
  const file = source as File
  const { id } = await window.cogent.engineRequest('attachments.begin', { name: file.name, size: file.size, mime: file.type })
  try {
    for (let offset = 0; offset < file.size; offset += ATTACHMENT_LIMITS.chunkBytes) {
      controller.signal.throwIfAborted()
      const bytes = new Uint8Array(await file.slice(offset, offset + ATTACHMENT_LIMITS.chunkBytes).arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      await window.cogent.engineRequest('attachments.chunk', { id, base64: btoa(binary) })
      progress(offset + bytes.length)
    }
    controller.signal.throwIfAborted()
    return await window.cogent.engineRequest('attachments.finish', { id })
  } catch (error) {
    // 清暂存失败不能隐藏导入的原始错误；同时把清理错误展示给调用方。
    try { await window.cogent.engineRequest('attachments.cancel', { id }) }
    catch (cleanupError) { throw new Error(`${unwrapIpcError(error)}；清理暂存失败：${unwrapIpcError(cleanupError)}`) }
    throw error
  }
}
async function runImport(id: string, key: string): Promise<void> {
  const controller = new AbortController(); imports.set(key, controller)
  const update = (f: (item: DraftAttachment) => DraftAttachment): void => {
    patch(id, (d) => ({ ...d, items: d.items.map((item) => item.key === key ? f(item) : item) }))
  }
  try {
    const source = sources.get(key)!
    const path = typeof source === 'string' ? source : window.cogent.filePath(source)
    const info = typeof source === 'string' || path !== '' ? await window.cogent.engineRequest('attachments.describe', { path }) :
      { name: source.name, size: source.size, mime: attachmentMime(source.name, source.type) }
    controller.signal.throwIfAborted()
    if ('kind' in info) {
      const duplicate = useAttachmentStore.getState().drafts[id]!.items.some((item) => item.key !== key && item.directory?.path === info.path)
      if (duplicate) {
        sources.delete(key); patch(id, (draft) => ({ ...draft, items: draft.items.filter((item) => item.key !== key) })); save(id); return
      }
      update((item) => ({ ...item, name: info.name, size: 0, directory: info, status: 'ready', error: undefined }))
      sources.delete(key); save(id); return
    }
    if (useAttachmentStore.getState().drafts[id]!.items.find((item) => item.key === key)!.directory !== undefined) throw new Error('路径已不是文件夹')
    const others = (): AttachmentMetadata[] => useAttachmentStore.getState().drafts[id]!.items.filter((item) => item.key !== key).map(metadata)
    const issue = attachmentAdmissionIssue(info, others())
    if (issue !== undefined) { refuse(id, key, info, issue); return }
    // 描述返回后同步预留真实大小，另一并发任务看到的是同一份容量账本。
    update((item) => ({ ...item, name: info.name, size: info.size, mime: info.mime, status: 'importing' }))
    const ref = await importSource(source, controller, (bytes) => update((i) => ({ ...i, progress: bytes })))
    if (controller.signal.aborted) { await window.cogent.engineRequest('attachments.release', { id: ref.id }); return }
    const actualIssue = attachmentAdmissionIssue(ref, others())
    if (actualIssue !== undefined) {
      await window.cogent.engineRequest('attachments.release', { id: ref.id })
      refuse(id, key, ref, actualIssue); return
    }
    update((item) => ({ ...item, ref, name: ref.name, size: ref.size, status: 'ready', error: undefined }))
    save(id)
  } catch (error) {
    if (!controller.signal.aborted) { update((item) => ({ ...item, status: 'error', error: unwrapIpcError(error) })); save(id) }
  } finally { imports.delete(key); drain() }
}
export const useAttachmentStore = create<DraftState>((set, get) => ({
  drafts: {}, media: {},
  load: async (id) => {
    if (get().drafts[id]?.loaded) return
    const pending = loading.get(id); if (pending !== undefined) return pending
    const ownsLoad = (): boolean => loading.get(id) === promise
    // 先登记恢复身份。删除时让整次读取失效，包含迟到的原件校验与回写。
    const promise = Promise.resolve().then(async () => {
      if (!ownsLoad()) return
      try {
        const journal = readJournal(id)
        const [draft, media] = await Promise.all([
          window.cogent.engineRequest('attachments.draft', { id }), window.cogent.engineRequest('attachments.media', {})
        ])
        if (!ownsLoad()) return
        const items: DraftAttachment[] = journal?.items ?? [
          ...draft.attachments.map((ref): DraftAttachment => ({ key: ref.id, name: ref.name, size: ref.size, ref, status: 'ready' })),
          ...(draft.directories ?? []).map((directory): DraftAttachment => ({ key: crypto.randomUUID(), name: directory.name, size: 0, directory, status: 'ready' }))
        ]
        await Promise.all(items.map(async (item) => {
          if (item.directory !== undefined) {
            try {
              const info = await window.cogent.engineRequest('attachments.describe', { path: item.directory.path })
              if (!('kind' in info)) throw new Error('路径已不是文件夹')
            } catch (cause) { item.status = 'error'; item.error = `文件夹不可用：${unwrapIpcError(cause)}` }
            return
          }
          if (item.ref === undefined) return
          try { await window.cogent.engineRequest('attachments.resolve', { id: item.ref.id }) }
          catch (cause) { item.status = 'error'; item.error = `附件不可用：${unwrapIpcError(cause)}` }
        }))
        if (!ownsLoad()) return
        patch(id, () => ({ text: journal?.text ?? draft.text, items, loaded: true, error: null, edit: 0 }))
        set({ media })
        if (journal !== undefined) save(id)
      } catch (error) {
        if (ownsLoad()) patch(id, (d) => ({ ...d, error: `草稿恢复失败：${unwrapIpcError(error)}` }))
      } finally {
        if (ownsLoad()) loading.delete(id)
      }
    })
    loading.set(id, promise); return promise
  },
  setText: (id, text) => { patch(id, (d) => ({ ...d, text, edit: d.edit + 1 })); save(id) },
  add: (id, files) => {
    const draft = get().drafts[id]!
    const added: DraftAttachment[] = []
    const rejected: AttachmentRejection[] = []
    const reserved = draft.items.map(metadata)
    for (const source of files) {
      const name = typeof source === 'string' ? source.split(/[\\/]/).at(-1)! : source.name
      // OS路径尚未分辨文件/目录；带.png后缀的目录也不能提前占用图片名额。
      const pathSource = typeof source === 'string' || window.cogent.filePath(source) !== ''
      const size = pathSource ? 0 : source.size
      const mime = pathSource ? 'application/octet-stream' : attachmentMime(name, source.type)
      const info = { name, size, mime }
      const issue = attachmentAdmissionIssue(info, reserved)
      if (issue !== undefined) { rejected.push({ name, reason: issue }); continue }
      const key = crypto.randomUUID(); sources.set(key, source)
      added.push({ key, ...info, status: 'queued' }); reserved.push(info)
      queue.push({ id, key })
    }
    patch(id, (d) => ({ ...d, items: [...d.items, ...added], rejections: [...(d.rejections ?? []), ...rejected], edit: d.edit + (added.length > 0 ? 1 : 0) }))
    save(id)
    drain()
  },
  remove: (id, key) => {
    const ref = get().drafts[id]!.items.find((item) => item.key === key)?.ref
    dequeue(key); imports.get(key)?.abort(); sources.delete(key)
    patch(id, (d) => ({ ...d, items: d.items.filter((i) => i.key !== key), edit: d.edit + 1 })); save(id)
    if (ref !== undefined) void window.cogent.engineRequest('attachments.release', { id: ref.id }).catch((cause: unknown) => patch(id, (d) => ({ ...d, error: `附件清理失败：${unwrapIpcError(cause)}` })))
  },
  retry: (id, key) => {
    const directory = get().drafts[id]!.items.find((item) => item.key === key)!.directory
    if (directory !== undefined) sources.set(key, directory.path)
    if (!sources.has(key)) { patch(id, (d) => ({ ...d, error: '请重新选择原文件' })); return }
    patch(id, (d) => ({ ...d, items: d.items.map((i) => i.key === key ? { ...i, status: 'queued', error: undefined } : i) }))
    queue.push({ id, key }); save(id); drain()
  },
  clearRejections: (id) => patch(id, (draft) => ({ ...draft, rejections: [] })),
  startSubmission: (id) => { const token = Symbol('draft-submit'); submissions.set(id, token); return token },
  discardChat: async (sessionId) => {
    const id = chatDraftId(sessionId)
    loading.delete(id)
    for (const item of get().drafts[id]?.items ?? EMPTY_DRAFT.items) {
      dequeue(item.key); imports.get(item.key)?.abort(); sources.delete(item.key)
    }
    const timer = timers.get(id); if (timer !== undefined) { clearTimeout(timer); timers.delete(id) }
    patch(id, () => ({ ...EMPTY_DRAFT, loaded: true }))
    await writes.get(id)
    await window.cogent.engineRequest('attachments.saveDraft', { id, text: '', attachmentIds: [] })
    localStorage.removeItem(journalKey(id)); localStorage.removeItem(`cogent.chat-draft.${sessionId}`)
  },
  consume: (id, snapshot, token) => {
    if (submissions.get(id) !== token) return false
    submissions.delete(id)
    const keys = new Set(snapshot.items.map((i) => i.key))
    keys.forEach((key) => sources.delete(key))
    patch(id, (d) => ({ ...d, text: d.edit === snapshot.edit ? '' : d.text, items: d.items.filter((i) => !keys.has(i.key)),
      rejections: d.rejections === snapshot.rejections ? [] : d.rejections }))
    save(id)
    return true
  }
}))
