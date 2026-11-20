/** 文件目标语法，Host 和 Markdown 共用；传输解码与文件名的百分号解码分开。 */
import type { FileLocation } from './files'

export interface FileTarget {
  path: string
  location?: FileLocation
  locationWarning?: string
}
export function parseFileTarget(raw: string): FileTarget | undefined {
  if (/^(?:javascript|data|vbscript|blob|streamdown|https?|mailto):/i.test(raw)) return undefined
  if (
    raw === '' ||
    raw.startsWith('#') ||
    raw.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(raw)
  )
    return undefined
  const hashAt = raw.indexOf('#')
  let destination = hashAt < 0 ? raw : raw.slice(0, hashAt)
  if (destination.includes('?')) return undefined
  let location: FileLocation | undefined
  let locationWarning: string | undefined
  const suffix = hashAt < 0 ? /:(\d+)(?::(\d+))?$/.exec(destination) : null
  const fragment = hashAt < 0 ? null : /^L(\d+)(?:(?:C|:C?)(\d+)|-L(\d+))?$/i.exec(raw.slice(hashAt + 1))
  if (suffix !== null) destination = destination.slice(0, -suffix[0].length)
  if (suffix !== null || fragment !== null) {
    const line = Number((suffix ?? fragment)![1])
    const columnText = suffix?.[2] ?? fragment?.[2]
    const column = columnText === undefined ? undefined : Number(columnText)
    const endLine = fragment?.[3] === undefined ? undefined : Number(fragment[3])
    if (
      !Number.isSafeInteger(line) ||
      line < 1 ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) ||
      (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line))
    )
      locationWarning = '位置无效，已打开文件'
    else
      location = {
        line,
        ...(column !== undefined && { column }),
        ...(endLine !== undefined && { endLine })
      }
  } else if (hashAt >= 0) locationWarning = '不支持的位置标记，已打开文件'
  let path: string
  try {
    path = decodeURIComponent(destination)
  } catch {
    return undefined
  }
  if (path === '' || /[\u0000-\u001f\u007f]/.test(path)) return undefined
  // 协议必须在解码前后都分类，编码的 javascript: 不能成为普通文件名。
  if (
    /^[a-z][\w+.-]*:/i.test(path) &&
    !/^[a-z]:[\\/]/i.test(path) &&
    !/^file:\/\//i.test(path) &&
    !/%3a\d+(?:%3a\d+)?$/i.test(destination)
  )
    return undefined
  if (/^(?:javascript|data|vbscript|blob|streamdown|https?|mailto):/i.test(path)) return undefined
  return {
    path,
    ...(location !== undefined && { location }),
    ...(locationWarning !== undefined && { locationWarning })
  }
}
