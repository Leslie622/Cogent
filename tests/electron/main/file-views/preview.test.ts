/** 网页关闭取消正在读取的资源，而不是只释放HTML父登记后继续读完整个大文件。 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcDeps } from '../../../../src/electron/main/ipc'
const mock = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mock.profile } }))
import { createFileViewPreviewSource } from '../../../../src/electron/main/file-views/preview'
let root = '', oldRoot: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cogent-preview-source-')); oldRoot = process.env.COGENT_HOME
  process.env.COGENT_HOME = join(root, 'home'); mock.profile = join(root, 'profile')
  mkdirSync(process.env.COGENT_HOME); mkdirSync(mock.profile); writeFileSync(join(root, 'index.html'), 'html')
})
afterEach(() => { if (oldRoot === undefined) delete process.env.COGENT_HOME; else process.env.COGENT_HOME = oldRoot; rmSync(root, { recursive: true, force: true }) })
describe('网页文件租约', () => {
  it('独立父租约与在途资源在关闭时均被释放，取消后不再读后续块', async () => {
    let failRead!: (error: Error) => void
    const descriptor = { path: join(root, 'index.html'), version: 'v', mime: 'text/html' }
    const request = vi.fn((method: string) => {
      if (method === 'fileViews.cloneLease') return Promise.resolve({ leaseId: 'parent', descriptor })
      if (method === 'fileViews.previewResource') return Promise.resolve({ leaseId: 'child', descriptor })
      if (method === 'fileViews.readChunk') return new Promise((_resolve, reject) => { failRead = reject })
      if (method === 'fileViews.cancel') failRead(new Error('读取已取消'))
      return Promise.resolve({ ok: true })
    })
    const source = await createFileViewPreviewSource({ host: { request }, getWindow: () => ({ webContents: { id: 1 } }) } as unknown as IpcDeps, 'original')
    const reading = source.readResource('image.png')
    const rejected = expect(reading).rejects.toThrow('取消')
    await vi.waitFor(() => expect(failRead).toBeDefined())
    await source.release(); await rejected
    expect(request.mock.calls.filter(([method]) => method === 'fileViews.readChunk')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('fileViews.release', { windowId: 1, leaseId: 'child' })
    expect(request).toHaveBeenCalledWith('fileViews.release', { windowId: 1, leaseId: 'parent' })
    await expect(source.readResource('later.png')).rejects.toThrow('关闭')
  })
  it('交付HTML拒绝扩大原件目录并归还已clone的父租约', async () => {
    const request = vi.fn((method: string) => Promise.resolve(method === 'fileViews.cloneLease' ? { leaseId: 'parent', descriptor: { path: join(root, 'missing.html'), delivery: { target: {} } } } : { ok: true }))
    await expect(createFileViewPreviewSource({ host: { request }, getWindow: () => ({ webContents: { id: 1 } }) } as unknown as IpcDeps, 'original', root)).rejects.toThrow('冻结资源')
    expect(request).toHaveBeenCalledWith('fileViews.release', { windowId: 1, leaseId: 'parent' })
  })
})
