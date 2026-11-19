/** 目录引用的文件系统边界：提交时复查实时路径，不修改工作区根或扩大写类信任。 */
import { statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { isDirectoryRef, type DirectoryRef } from '../../shared/attachments'

export function directoryReference(path: string): DirectoryRef {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('文件夹需要有效的绝对路径')
  const absolute = resolve(path)
  if (!statSync(absolute).isDirectory()) throw new Error(`路径不是文件夹：${absolute}`)
  return { kind: 'directory', name: basename(absolute) || absolute, path: absolute }
}

/** renderer传来的名称不作为文件系统事实；只按实际路径重新生成展示与模型元数据。 */
export function prepareDirectoryReferences(value: unknown): DirectoryRef[] {
  if (!Array.isArray(value) || !value.every(isDirectoryRef)) throw new Error('文件夹引用不合法')
  return value.map((ref) => directoryReference(ref.path))
}
