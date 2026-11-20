/** 当前文件预览 owner；每次切换换代，迟到读取只能丢弃，关闭负责取消及 Blob 回收。 */
import { create } from 'zustand'
import type { FileDescriptor, FileMethods, ParsedFile } from '@shared/files'
import { FILE_LIMITS } from '@shared/files'
import type { FileLinkScope } from '@/features/home/files/FileLink'

export interface Preview {
  scope: FileLinkScope
  rawTarget: string
  operationId: string
  generation: number
  descriptor: FileDescriptor | null
  loading: boolean
  error: string | null
  text: string | null
  encoding: string | null
  url: string | null
  document: ParsedFile | null
}
interface PreviewState {
  current: Preview | null
  open: (scope: FileLinkScope, rawTarget: string) => Promise<void>
  close: () => void
  documentPage: (cursor: number, sheet?: string, range?: string) => Promise<void>
}
let generation = 0
function release(preview: Preview | null): void {
  if (preview === null) return
  if (preview.url !== null) URL.revokeObjectURL(preview.url)
  void window.cogent
    .engineRequest('files.cancel', {
      sessionId: preview.scope.sessionId,
      operationId: preview.operationId
    })
    .catch(() => {
      /* Host 重启后没有旧操作可取消。 */
    })
}
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
export const useFilePreviewStore = create<PreviewState>((set, get) => ({
  current: null,
  close: () => {
    generation++
    const current = get().current
    set({ current: null })
    release(current)
  },
  open: async (scope, rawTarget) => {
    const previous = get().current
    const current: Preview = {
      scope,
      rawTarget,
      operationId: crypto.randomUUID(),
      generation: ++generation,
      descriptor: null,
      loading: true,
      error: null,
      text: null,
      encoding: null,
      url: null,
      document: null
    }
    set({ current })
    release(previous)
    const owns = () => get().current?.generation === current.generation
    const update = (patch: Partial<Preview>) => {
      if (owns()) set((state) => ({ current: { ...state.current!, ...patch } }))
    }
    try {
      const descriptor = await window.cogent.engineRequest('files.resolve', {
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        rawTarget,
        relativeTo: scope.relativeTo
      })
      if (!owns()) return
      update({ descriptor })
      const read = {
        sessionId: scope.sessionId,
        fileId: descriptor.fileId,
        version: descriptor.version,
        operationId: current.operationId
      }
      if (descriptor.kind === 'text' || descriptor.kind === 'markdown') {
        let offset: number | undefined = 0
        const chunks: string[] = []
        let encoding = ''
        while (offset !== undefined) {
          const result: FileMethods['files.readText']['result'] = await window.cogent.engineRequest(
            'files.readText',
            { ...read, offset }
          )
          if (!owns()) return
          chunks.push(result.text)
          encoding = result.encoding
          offset = result.nextOffset
        }
        update({ text: chunks.join(''), encoding, loading: false })
      } else if (descriptor.kind === 'office') {
        const document = await window.cogent.engineRequest('files.parseDocument', {
          ...read,
          cursor: 0
        })
        update({ document, loading: false })
      } else if (['image', 'pdf', 'audio', 'video'].includes(descriptor.kind)) {
        const limit = descriptor.kind === 'image' ? FILE_LIMITS.image : FILE_LIMITS.binary
        if (descriptor.size > limit)
          throw new Error(`文件超过 ${limit / 1024 / 1024} MiB 预览容量，请用系统打开`)
        const chunks: Uint8Array<ArrayBuffer>[] = []
        let offset = 0
        for (;;) {
          const part = await window.cogent.engineRequest('files.readChunk', {
            ...read,
            offset,
            length: FILE_LIMITS.chunk
          })
          if (!owns()) return
          chunks.push(Uint8Array.from(atob(part.base64), (value) => value.charCodeAt(0)))
          offset = part.nextOffset
          if (part.done) break
        }
        const url = URL.createObjectURL(new Blob(chunks, { type: descriptor.mime }))
        update({ url, loading: false })
      } else update({ loading: false })
    } catch (error) {
      update({ error: reason(error), loading: false })
    }
  },
  documentPage: async (cursor, sheet, range) => {
    const current = get().current!
    const descriptor = current.descriptor!
    const ownGeneration = ++generation
    release(current)
    const operationId = crypto.randomUUID()
    set({
      current: { ...current, generation: ownGeneration, operationId, loading: true, error: null }
    })
    try {
      const document = await window.cogent.engineRequest('files.parseDocument', {
        sessionId: current.scope.sessionId,
        fileId: descriptor.fileId,
        version: descriptor.version,
        operationId,
        cursor,
        sheet,
        range
      })
      if (get().current?.generation === ownGeneration)
        set((state) => ({ current: { ...state.current!, document, loading: false } }))
    } catch (error) {
      if (get().current?.generation === ownGeneration)
        set((state) => ({ current: { ...state.current!, error: reason(error), loading: false } }))
    }
  }
}))
