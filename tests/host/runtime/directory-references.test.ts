/** 目录只接绝对实时路径；形状、文件系统与显示名分别在外部边界核实。 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { directoryReference, prepareDirectoryReferences } from '../../../src/host/runtime/directory-references'
import { AttachmentConfig } from '../../../src/host/runtime/attachment-config'
import { AttachmentService } from '../../../src/host/runtime/attachments'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })) })
const root = () => { const path = mkdtempSync(join(tmpdir(), 'cogent-directory-ref-')); roots.push(path); return path }

describe('目录引用边界', () => {
  it('真实目录包含中文、空格和图片后缀，描述只返回路径而非伪造文件元数据', async () => {
    const home = root(); const path = join(home, '目录 测试.png'); mkdirSync(path)
    const service = new AttachmentService(home)
    expect(await service.describePath(path)).toEqual({ kind: 'directory', name: '目录 测试.png', path })
    expect(() => service.claim([], 'chat')).not.toThrow()
    await expect(service.importPath(path)).rejects.toThrow('文件夹')
  })
  it('相对路径、非目录、缺失路径与非法引用均明确失败，显示名重新取实际路径', () => {
    const home = root(); const path = join(home, '子目录'); mkdirSync(path)
    const ref = directoryReference(path)
    expect(prepareDirectoryReferences([{ ...ref, name: '伪造的名字' }])).toEqual([ref])
    for (const value of [null, {}, [null], [{ ...ref, path: 1 }], [{ ...ref, path: './relative' }]]) {
      expect(() => prepareDirectoryReferences(value)).toThrow()
    }
    const file = join(home, 'file'); writeFileSync(file, 'text')
    expect(() => directoryReference(file)).toThrow('不是文件夹')
    expect(() => directoryReference(join(home, 'missing'))).toThrow('ENOENT')
  })
  it('草稿持久化引用不要求目录永远存在，旧草稿仍读得到', () => {
    const home = root(); const path = join(home, '目录'); mkdirSync(path)
    const directory = directoryReference(path); const config = new AttachmentConfig(home)
    config.saveDraft({ id: 'new-a', text: '正文', attachmentIds: [], directories: [directory] })
    rmSync(path, { recursive: true })
    expect(config.readDraft('new-a').directories).toEqual([directory])
    config.saveDraft({ id: 'old', text: '', attachmentIds: [] }); expect(config.readDraft('old').directories).toBeUndefined()
    expect(() => config.saveDraft({ id: 'bad', text: '', attachmentIds: [], directories: ['path'] })).toThrow('文件夹引用')
  })
})
