/** 按实际工具平台解析目标，拒绝把异平台绝对路径悄悄映射到本机同名文件。 */
import { posix, win32 } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FileContext, FileReference } from '../../../shared/files'
import { parseFileTarget } from '../../../shared/file-target'

export function resolveFileTarget(
  raw: string,
  context: Pick<FileContext, 'cwd' | 'platform'>,
  home: string
) {
  const target = parseFileTarget(raw)
  if (target === undefined) throw new Error('不是有效的本地文件目标')
  const windows = context.platform === 'win32'
  let path = target.path
  if (/^file:\/\//i.test(path)) {
    // 不再调用 fileURLToPath，避免文件名中的百分号发生第二次语义解码。
    const tail = path.slice(7)
    if (tail.startsWith('/')) path = windows ? tail.replace(/^\/(?=[a-z]:)/i, '') : tail
    else if (tail.startsWith('localhost/')) path = '/' + tail.slice(10)
    else {
      if (!windows) throw new Error('当前平台不支持 Windows 网络共享路径')
      path = '\\\\' + tail.replaceAll('/', '\\')
    }
  }
  if (/^\/[a-z]:[\\/]/i.test(path)) {
    if (!windows) throw new Error('文件路径属于另一种操作系统')
    path = path.slice(1)
  }
  if (windows ? path.startsWith('/') && !/^\/[a-z]:/i.test(path) : /^[a-z]:[\\/]|^\\/i.test(path))
    throw new Error('文件路径属于另一种操作系统')
  if (path === '~' || /^[~][\\/]/.test(path))
    path = (windows ? win32 : posix).join(home, path.slice(2))
  return { ...target, path: (windows ? win32 : posix).resolve(context.cwd, path) }
}

/** 文件工具走 pi 的命令行路径约定，审批和产物引用共用这份解析。 */
export function resolveToolFilePath(raw: string, context: Pick<FileContext, 'cwd' | 'platform'>): string {
  // 对齐 pi 的工具输入习惯，Markdown 目标本身不做这些 CLI 语义转换。
  let input = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '')
  if (context.platform === 'win32' && !input.includes('\\')) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(input)
    if (drive !== null) input = `${drive[1].toUpperCase()}:/${drive.at(2) ?? ''}`
  }
  // 工具参数是字面路径，不能借 Markdown URI 解析器处理；否则 POSIX 的合法冒号文件名会被误当协议。
  const pathApi = context.platform === 'win32' ? win32 : posix
  if (input === '~') input = homedir()
  else if (input.startsWith('~/') || (context.platform === 'win32' && input.startsWith('~\\')))
    input = pathApi.join(homedir(), input.slice(2))
  else if (/^file:\/\//.test(input)) input = fileURLToPath(input)
  return pathApi.resolve(context.cwd, input)
}

/** 只收明确单文件工具的结构参数；成功结果才把目标交给正文词表。 */
export function toolFileReferences(
  name: string,
  args: Record<string, unknown>,
  context: FileContext
): FileReference[] {
  if (!['read', 'write', 'edit'].includes(name) || typeof args.path !== 'string') return []
  let path = resolveToolFilePath(args.path, context)
  // pi read 对 macOS 截图空格、NFD 与弯引号有明确兼容分支；按同序核对已知候选，不扫描目录。
  if (name === 'read' && !existsSync(path)) {
    const variants = [
      path.replace(/ (AM|PM)\./gi, '\u202F$1.'),
      path.normalize('NFD'),
      path.replace(/'/g, '\u2019'),
      path.normalize('NFD').replace(/'/g, '\u2019')
    ]
    path = variants.find((candidate) => existsSync(candidate)) ?? path
  }
  return [{ path, turnId: context.turnId }]
}
