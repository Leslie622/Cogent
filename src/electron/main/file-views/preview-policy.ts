/** main只按当前原件和原生选择求值授权；每个资源仍需Host在登记与读取时复核真实路径。 */
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import { fileViewPreviewSensitivePath, type FileViewPreviewPolicy } from '../../../shared/file-views'
import { storageRoot } from '../storage-root'
function within(root: string, target: string): boolean {
  const part = relative(root, target)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
}

export async function createPreviewPolicy(htmlPath: string, selectedRoot?: string): Promise<{ path: string; entryPath: string; policy: FileViewPreviewPolicy }> {
  const path = await realpath(htmlPath)
  const rootPath = selectedRoot === undefined ? dirname(path) : resolve(selectedRoot)
  const realPath = await realpath(rootPath)
  if (!(await stat(realPath)).isDirectory() || realPath === parse(realPath).root) throw new Error('网页资源目录必须是普通目录，不能选择文件系统根目录')
  const blockedRoots = await Promise.all([storageRoot(), app.getPath('userData')].map(root => realpath(root)))
  if (blockedRoots.some(root => within(root, realPath) || within(root, path))) throw new Error('应用数据目录不能作为网页资源目录')
  if (fileViewPreviewSensitivePath(realPath) || fileViewPreviewSensitivePath(path) || fileViewPreviewSensitivePath(rootPath)) throw new Error('敏感目录不能作为网页资源目录')
  if (!within(realPath, path)) throw new Error('所选资源目录必须包含当前HTML文件')
  const policy: FileViewPreviewPolicy = { root: { path: rootPath, realPath }, blockedRoots }
  const entryPath = relative(realPath, path).split(sep).join('/')
  await checkPreviewResource(policy, entryPath)
  return { path, entryPath, policy }
}

export async function checkPreviewResource(policy: FileViewPreviewPolicy, relativePath: string): Promise<string> {
  const target = resolve(policy.root.realPath, relativePath)
  if (await realpath(policy.root.path) !== policy.root.realPath || !within(policy.root.realPath, target)) throw new Error('网页资源根已变化或路径越界')
  const actual = await realpath(target)
  if (!within(policy.root.realPath, actual) || policy.blockedRoots.some(root => within(root, actual)) || fileViewPreviewSensitivePath(actual) || fileViewPreviewSensitivePath(target)) throw new Error('网页资源位于受保护目录或敏感文件')
  return actual
}
