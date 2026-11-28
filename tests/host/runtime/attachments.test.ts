/** 附件在原件删除、取消和服务器出口上的行为回归。 */
import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AttachmentRef } from '../../../src/shared/attachments'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentService } from '../../../src/host/runtime/attachments'
import { AttachmentConfig, attachmentHandlers } from '../../../src/host/runtime/attachment-config'

const roots: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cogent-attachment-test-')); roots.push(root)
  return { root, service: new AttachmentService(root) }
}
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })
describe('附件存储', () => {
  it('释放遵守草稿/会话引用，去重原件最后才删除', async () => {
    const { root, service } = setup(); const original = join(root, 'same.txt'); writeFileSync(original, '共享')
    const a = await service.importPath(original); const b = await service.importPath(original)
    const path = service.path(a.id)
    service.release(a.id, () => true); expect(service.get(a.id)).toEqual(a)
    service.release(a.id, () => false); expect(() => service.get(a.id)).toThrow(); expect(readFileSync(path, 'utf8')).toBe('共享')
    service.claim([b.id], 's'); service.release(b.id, () => false); expect(service.get(b.id)).toEqual(b)
    service.releaseSession('s', () => false); expect(() => readFileSync(path)).toThrow()
  })
  it('导入保存副本、内容去重，原件删除不影响已认领文件', async () => {
    const { root, service } = setup(); const original = join(root, '中文.txt'); writeFileSync(original, '你好')
    const a = await service.importPath(original); const b = await service.importPath(original)
    expect(a.id).not.toBe(b.id); expect(service.path(a.id)).toBe(service.path(b.id))
    rmSync(original); await service.verify(a.id)
    service.claim([a.id], 'session'); expect(service.forSession(a.id, 'session')).toEqual(a)
    expect(() => service.forSession(a.id, 'another')).toThrow('不属于')
    const restored = new AttachmentService(root); expect(readFileSync(restored.path(a.id), 'utf8')).toBe('你好')
  })
  it('压缩后资产索引用的原件路径：记录与原件都在才返回，已释放、丢失或非法 id 返回 undefined', async () => {
    const { root, service } = setup(); const original = join(root, 'a.txt'); writeFileSync(original, '内容')
    const a = await service.importPath(original)
    expect(service.existingPath(a.id)).toBe(service.path(a.id))
    rmSync(service.path(a.id))
    expect(service.existingPath(a.id)).toBeUndefined()
    service.release(a.id, () => false); expect(() => service.get(a.id)).toThrow()
    expect(service.existingPath(a.id)).toBeUndefined()
    expect(service.existingPath('../secret')).toBeUndefined()
  })
  it('拒绝目录、过大声明、非法 id、损坏原件和重复引用', async () => {
    const { root, service } = setup()
    await expect(service.importPath(root)).rejects.toThrow('文件夹')
    expect(() => service.begin('大文件', 101 * 1024 * 1024, '')).toThrow('100 MiB')
    expect(() => service.get('../secret')).toThrow('id')
    const id = service.begin('a.txt', 0, ''); const ref = await service.finish(id)
    expect(() => service.claim([ref.id, ref.id], 's')).toThrow('重复')
    writeFileSync(service.path(ref.id), '坏'); await expect(service.verify(ref.id)).rejects.toThrow('损坏')
  })
  it('分片必须齐备，取消后不能完成，空文件可以保存', async () => {
    const { service } = setup(); const id = service.begin('a.txt', 3, '')
    await service.chunk(id, Buffer.from('ab')); await expect(service.finish(id)).rejects.toThrow('未收齐')
    await expect(service.chunk(id, Buffer.from('cd'))).rejects.toThrow('大小')
    service.cancel(id); await expect(service.finish(id)).rejects.toThrow('结束或取消')
    expect((await service.finish(service.begin('空.txt', 0, ''))).size).toBe(0)
  })
  it('本地发送不调上传器；服务器出口传真实流、取消信号和进度', async () => {
    const { root } = setup(); const original = join(root, 'a.txt'); writeFileSync(original, 'payload')
    let calls = 0; const signal = new AbortController().signal; const progress: number[] = []
    const service = new AttachmentService(root, { upload: async (ref, stream, receivedSignal, report) => {
      calls++; expect(receivedSignal).toBe(signal); const chunks: Buffer[] = []
      for await (const chunk of stream() as AsyncIterable<Buffer>) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).toBe('payload'); report(ref.size)
      return { locator: 'remote:stable-object-id' }
    } })
    const ref = await service.importPath(original)
    await service.prepareForSend('local', [ref], signal); expect(calls).toBe(0)
    expect(await service.prepareForSend('server', [ref], signal, (_id, n) => progress.push(n))).toEqual([{ id: ref.id, locator: 'remote:stable-object-id' }])
    expect(calls).toBe(1); expect(progress).toEqual([7])
    await expect(new AttachmentService(root).prepareForSend('server', [ref], signal)).rejects.toThrow('尚未配置')
  })
  it('服务器错误和准备取消不冒充成功', async () => {
    const { root } = setup(); const service = new AttachmentService(root, { upload: () => Promise.reject(new Error('offline')) })
    const ref = await service.finish(service.begin('空.txt', 0, ''))
    await expect(service.prepareForSend('server', [ref], new AbortController().signal)).rejects.toThrow('offline')
    const controller = new AbortController(); controller.abort()
    await expect(service.prepareForSend('local', [ref], controller.signal)).rejects.toThrow()
  })
  it('草稿持久化与路径边界；配置失败保留原文件', async () => {
    const { root, service } = setup(); const config = new AttachmentConfig(root)
    config.saveDraft({ id: 'new-chat-1', text: '草稿', attachmentIds: [] })
    expect(new AttachmentConfig(root).readDraft('new-chat-1').text).toBe('草稿')
    expect(() => config.readDraft('../x')).toThrow('id')
    config.saveMedia({ video: { server: 'vision', tool: 'analyse', pathArgument: 'path', questionArgument: 'question', formats: ['.mp4'] } })
    expect(() => config.saveMedia({ video: { server: '../x' } })).toThrow()
    expect(config.media().video?.server).toBe('vision')
    const handlers = new Map(attachmentHandlers(service, config))
    await expect(handlers.get('attachments.chunk')!({ id: 'a', base64: '%%%bad' })).rejects.toThrow('分片')
  })
  it('普通文件超过20项可持久化与认领，图片独立限制20张', async () => {
    const { root, service } = setup(); const refs: AttachmentRef[] = []
    for (let i = 0; i < 25; i++) refs.push(await service.finish(service.begin(`${i}.txt`, 0, '')))
    const config = new AttachmentConfig(root)
    config.saveDraft({ id: 'many', text: '', attachmentIds: refs.map((r) => r.id) })
    expect(config.readDraft('many').attachmentIds).toHaveLength(25)
    expect(service.claim(refs.map((r) => r.id), 's')).toHaveLength(25)
    const original = join(root, 'image.png')
    copyFileSync('tests/fixtures/附件兼容/一像素.png', original)
    const images: AttachmentRef[] = []
    for (let i = 0; i < 21; i++) images.push(await service.importPath(original))
    expect(() => service.claim(images.map((r) => r.id), 's')).toThrow('20')
    expect(service.claim([...images.slice(0,20), ...refs].map((r) => r.id), 's')).toHaveLength(45)
  })
  it('元信息探测不产生受管原件，路径/分片共享两个导入名额', async () => {
    const { root, service } = setup(); const file = join(root, 'a.txt'); writeFileSync(file, 'abc')
    const handlers = new Map(attachmentHandlers(service, new AttachmentConfig(root)))
    await expect(handlers.get('attachments.describe')!({ path: file })).resolves.toEqual({ name: 'a.txt', size: 3, mime: 'text/plain' })
    expect(readdirSync(join(root, 'attachments/v1/objects'))).toEqual([])
    const a = service.begin('a.txt', 0, ''); const b = service.begin('b.txt', 0, '')
    expect(() => service.begin('c.txt', 0, '')).toThrow('2项')
    await expect(service.importPathOperation(crypto.randomUUID(), file)).rejects.toThrow('2项')
    service.cancel(a); await service.finish(b)
    await expect(service.importPathOperation(crypto.randomUUID(), file)).resolves.toMatchObject({ name: 'a.txt' })
  })
})
