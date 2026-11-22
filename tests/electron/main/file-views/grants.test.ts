/** 授权仅由可信main记录；重启恢复、坏库、链接换目标不能偷偷扩大范围。 */
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileViewGrants } from '../../../../src/electron/main/file-views/grants'
const directories: string[] = []
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('桌面文件持久授权', () => {
  it('原生选择的授权可重启恢复且不接受任意renderer路径/ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cogent-grants-')); directories.push(root); const path = join(root, 'selected'); await mkdir(path)
    const grants = new FileViewGrants(join(root, 'home')); const id = await grants.add(path)
    const restored = new FileViewGrants(join(root, 'home')); expect(await restored.roots([id])).toMatchObject([{ grantId: id, path, kind: 'directory' }]); await expect(restored.roots([path])).rejects.toThrow('不存在')
  })
  it('损坏授权文件报错且原件不被改写', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cogent-grants-')); directories.push(root); const path = join(root, 'file-view-grants.json'); await writeFile(path, '{broken')
    await expect(new FileViewGrants(root).roots(['id'])).rejects.toThrow(); expect(await readFile(path, 'utf8')).toBe('{broken')
  })
  it('异步复核结束时页面已重载，提交前检查阻止持久化授权', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cogent-grants-')); directories.push(root)
    const home = join(root, 'home'); const grants = new FileViewGrants(home)
    await expect(grants.add(root, () => { throw new Error('页面已重载') })).rejects.toThrow('重载')
    await expect(readFile(join(home, 'file-view-grants.json'), 'utf8')).rejects.toThrow()
  })
  it('损坏记录前的半份授权不泄漏进内存，修复为空后旧ID仍无权限', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cogent-grants-')); directories.push(root); const path = join(root, 'selected'); await mkdir(path)
    const home = join(root, 'home'); const id = await new FileViewGrants(home).add(path)
    const file = join(home, 'file-view-grants.json'); const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; grants: unknown[] }
    await writeFile(file, JSON.stringify({ ...saved, grants: [...saved.grants, { broken: true }] }))
    const restored = new FileViewGrants(home)
    await expect(restored.roots([id])).rejects.toThrow('损坏')
    await writeFile(file, JSON.stringify({ version: 1, grants: [] }))
    await expect(restored.roots([id])).rejects.toThrow('不存在')
  })
  it('junction授权不能在重启后被换到其他真实目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cogent-grants-')); directories.push(root); const a = join(root, 'a'); const b = join(root, 'b'); const link = join(root, 'link'); await mkdir(a); await mkdir(b); await symlink(a, link, 'junction')
    const grants = new FileViewGrants(join(root, 'home')); const id = await grants.add(link); await unlink(link); await symlink(b, link, 'junction')
    await expect(new FileViewGrants(join(root, 'home')).roots([id])).rejects.toThrow('变化')
  })
})
