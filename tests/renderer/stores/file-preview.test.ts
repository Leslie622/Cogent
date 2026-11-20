/** 迟到请求和 Blob 所有权；真实 store 动作驱动，不复制状态机实现。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDescriptor } from '@shared/files'
import { useFilePreviewStore } from '@/stores/file-preview'
const descriptor = (id: string, kind: FileDescriptor['kind'] = 'text'): FileDescriptor => ({ fileId: id, serviceId: 'host', path: '/work/' + id, name: id, kind, mime: 'text/plain', size: 4, version: 'v', source: 'saved' })
const scope = { sessionId: 'a', turnId: 'turn', refs: [] }
let request: ReturnType<typeof vi.fn<(method: string, params: { rawTarget?: string; fileId?: string }) => Promise<unknown>>>
const revoke = vi.fn()
beforeEach(() => {
  request = vi.fn<(method: string, params: { rawTarget?: string; fileId?: string }) => Promise<unknown>>().mockResolvedValue({ ok: true })
  window.cogent = { engineRequest: request } as unknown as typeof window.cogent
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:test'); static revokeObjectURL = revoke })
})
afterEach(() => { useFilePreviewStore.getState().close(); vi.unstubAllGlobals() })
describe('文件预览所有权', () => {
  it('关闭后到达的 resolve 不能发起读取或复活预览', async () => {
    let complete!: (value: FileDescriptor) => void
    request.mockImplementation((method) => method === 'files.resolve' ? new Promise((resolve) => { complete = resolve }) : Promise.resolve({ ok: true }))
    const pending = useFilePreviewStore.getState().open(scope, './a.txt')
    useFilePreviewStore.getState().close(); complete(descriptor('a.txt')); await pending
    expect(useFilePreviewStore.getState().current).toBeNull()
    expect(request).not.toHaveBeenCalledWith('files.readText', expect.anything())
  })
  it('A 切到 B 后，A 的读取失败不能覆盖 B', async () => {
    let fail!: (reason: Error) => void
    request.mockImplementation((method, params) => {
      if (method === 'files.resolve') return Promise.resolve(descriptor(params.rawTarget!))
      if (method === 'files.readText') return params.fileId === 'a' ? new Promise((_resolve, reject) => { fail = reject }) : Promise.resolve({ text: 'B', encoding: 'utf-8' })
      return Promise.resolve({ ok: true })
    })
    const first = useFilePreviewStore.getState().open(scope, 'a')
    await vi.waitFor(() => expect(fail).toBeDefined())
    await useFilePreviewStore.getState().open({ ...scope, sessionId: 'b' }, 'b')
    fail(new Error('旧错误')); await first
    expect(useFilePreviewStore.getState().current).toMatchObject({ text: 'B', error: null, scope: { sessionId: 'b' } })
  })
  it('分片以同一版本读取，关闭回收 Blob 并取消', async () => {
    request.mockImplementation((method) => method === 'files.resolve' ? Promise.resolve(descriptor('a.png', 'image')) : method === 'files.readChunk' ? Promise.resolve({ base64: btoa('data'), done: true, nextOffset: 4 }) : Promise.resolve({ ok: true }))
    await useFilePreviewStore.getState().open(scope, 'a.png')
    expect(useFilePreviewStore.getState().current?.url).toBe('blob:test')
    expect(request).toHaveBeenCalledWith('files.readChunk', expect.objectContaining({ version: 'v', sessionId: 'a' }))
    useFilePreviewStore.getState().close()
    expect(revoke).toHaveBeenCalledWith('blob:test')
    expect(request).toHaveBeenCalledWith('files.cancel', expect.objectContaining({ sessionId: 'a' }))
  })
})
