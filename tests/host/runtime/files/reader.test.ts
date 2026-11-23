/** 使用真实临时文件验证读取、版本、取消和会话所有权；不靠文件系统桩制造成功。 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileService } from '../../../../src/host/runtime/files/reader'
import { fileHandlers } from '../../../../src/host/runtime/files/handlers'
import { FILE_LIMITS } from '../../../../src/shared/files'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'cogent-files-')); directories.push(cwd)
  const service = new FileService((sessionId) => { if (!['a', 'b'].includes(sessionId)) throw new Error('会话不存在'); return { context: { cwd, roots: [cwd], platform: process.platform }, saved: true } })
  await writeFile(join(cwd, 'hello.txt'), '你好\nsecond\nthird')
  const descriptor = await service.resolve('a', './hello.txt#L2')
  const read = { sessionId: 'a', fileId: descriptor.fileId, version: descriptor.version, operationId: 'op' }
  return { cwd, service, descriptor, read }
}
describe('当前文件服务', () => {
  it('按 fileId 有界读取和确认系统目标，不给另一个会话借用', async () => {
    const { service, descriptor, read } = await fixture()
    expect(await service.readText(read)).toMatchObject({ text: '你好\nsecond\nthird', encoding: 'utf-8' })
    expect(await service.actionTarget(read)).toMatchObject({ name: 'hello.txt' })
    expect(descriptor.location).toEqual({ line: 2 })
    await expect(service.readText({ ...read, sessionId: 'b' })).rejects.toThrow('失效')
    await expect(service.readText({ ...read, sessionId: 'missing' })).rejects.toThrow('会话不存在')
  })
  it('修改、取消、删除会话后均拒绝旧读取', async () => {
    const { cwd, service, read } = await fixture()
    await writeFile(join(cwd, 'hello.txt'), 'changed content')
    await expect(service.readText(read)).rejects.toThrow('变化')
    service.cancel('a', 'op2')
    await expect(service.readText({ ...read, operationId: 'op2' })).rejects.toThrow('取消')
    service.releaseSession('a')
    await expect(service.actionTarget(read)).rejects.toThrow('失效')
  })
  it('256 KiB 切口不损坏 UTF-8，UTF-16 BOM 正确解码', async () => {
    const { cwd, service } = await fixture()
    const text = 'a'.repeat(FILE_LIMITS.chunk - 1) + '中文🙂尾巴'
    await writeFile(join(cwd, 'hello.txt'), text)
    const descriptor = await service.resolve('a', 'hello.txt')
    const read = { sessionId: 'a', fileId: descriptor.fileId, version: descriptor.version, operationId: 'utf8' }
    const first = await service.readText(read)
    const next = await service.readText({ ...read, offset: first.nextOffset })
    expect(first.text + next.text).toBe(text)
    await writeFile(join(cwd, 'utf16.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文🙂', 'utf16le')]))
    const utf16 = await service.resolve('a', 'utf16.txt')
    expect((await service.readText({ ...read, fileId: utf16.fileId, version: utf16.version, operationId: 'utf16' })).text).toBe('中文🙂')
  })
  it('分片入口拒绝越界、伪造和目录读取', async () => {
    const { cwd, service, read } = await fixture()
    const handlers = new Map(fileHandlers(service))
    expect(() => handlers.get('files.readChunk')!({ ...read, offset: 0, length: FILE_LIMITS.chunk + 1 })).toThrow('范围')
    expect(() => handlers.get('files.resolve')!({ sessionId: 'a', rawTarget: 'a\0b' })).toThrow('字符串')
    const directory = await service.resolve('a', cwd)
    await expect(service.readText({ ...read, fileId: directory.fileId, version: directory.version })).rejects.toThrow('目录')
  })
  it('文件软链接或父目录联接换目标后拒绝旧文件标识', async () => {
    const { cwd, service, read } = await fixture()
    const alias = join(cwd, 'alias')
    let selectedPath = alias
    let nextTarget = join(cwd, 'other.txt')
    let linkType: 'file' | 'junction' = 'file'
    await writeFile(nextTarget, 'other')
    try {
      await symlink(join(cwd, 'hello.txt'), alias, 'file')
    } catch (error) {
      const denied = process.platform === 'win32' && error instanceof Error && 'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      if (!denied) throw error

      // 文件服务复核完整路径，换掉父目录联接也会改变文件的真实位置。
      const firstDir = join(cwd, 'first')
      const secondDir = join(cwd, 'second')
      await mkdir(firstDir)
      await mkdir(secondDir)
      await writeFile(join(firstDir, 'data.txt'), 'original')
      await writeFile(join(secondDir, 'data.txt'), 'other')
      await symlink(firstDir, alias, 'junction')
      selectedPath = join(alias, 'data.txt')
      nextTarget = secondDir
      linkType = 'junction'
    }
    const descriptor = await service.resolve('a', selectedPath)
    await unlink(alias)
    await symlink(nextTarget, alias, linkType)
    await expect(service.readText({ ...read, fileId: descriptor.fileId, version: descriptor.version })).rejects.toThrow('目标已变化')

    const refreshed = await service.resolve('a', selectedPath)
    expect(refreshed.fileId).not.toBe(descriptor.fileId)
    expect((await service.readText({ ...read, fileId: refreshed.fileId, version: refreshed.version })).text).toBe('other')
  })
})
