/** 将底层文件系统错误码或裸 IPC/Node 报错翻译为面向用户的中文提示，避免裸系统路径与调用栈直出界面。 */
export type FileErrorTargetKind = 'file' | 'directory' | 'path'

const SYSCALL_CODE_RE =
  /^(ENOENT|ENOTDIR|EISDIR|EACCES|EPERM|EBUSY|ENAMETOOLONG|ELOOP):\s*(?:no such file or directory|not a directory|illegal operation on a directory|permission denied|operation not permitted|resource busy or locked|file name too long|too many symbolic links encountered)\b/i

function labelOf(kind: FileErrorTargetKind): string {
  return kind === 'directory' ? '目录' : kind === 'file' ? '文件' : '文件或目录'
}

export function translateFileErrorCode(code: string, kind: FileErrorTargetKind = 'path'): string | null {
  const label = labelOf(kind)
  switch (code.toUpperCase()) {
    case 'ENOENT':
      return `${label}不存在或已被移除`
    case 'ENOTDIR':
      return '路径不是有效的目录'
    case 'EISDIR':
      return '目标是目录，无法按文件读取'
    case 'EACCES':
    case 'EPERM':
      return `没有权限访问该${label}`
    case 'EBUSY':
      return `${label}正被其他程序占用`
    case 'ENAMETOOLONG':
      return '文件路径过长'
    case 'ELOOP':
      return '符号链接层级过多'
    default:
      return null
  }
}

export function formatFileSystemError(error: unknown, kind: FileErrorTargetKind = 'path'): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
  if (code !== undefined) {
    const translated = translateFileErrorCode(code, kind)
    if (translated !== null) return translated
  }
  const raw = (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  )
  const match = SYSCALL_CODE_RE.exec(raw)
  if (match !== null) {
    const translated = translateFileErrorCode(match[1], kind)
    if (translated !== null) return translated
  }
  return raw
}

export function toUserFileError(error: unknown, kind: FileErrorTargetKind = 'path'): Error {
  const message = formatFileSystemError(error, kind)
  if (error instanceof Error && error.message === message) return error
  const wrapped = new Error(message) as NodeJS.ErrnoException
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    wrapped.code = (error as { code: string }).code
  }
  return wrapped
}
