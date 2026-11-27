import { describe, expect, it } from 'vitest'
import { formatFileSystemError, toUserFileError } from '../../src/shared/file-errors'

describe('file-errors', () => {
  it('翻译带 code 的文件系统错误，不暴露裸 syscall 或路径', () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, realpath 'C:\\missing'"), { code: 'ENOENT' })
    expect(formatFileSystemError(err, 'directory')).toBe('目录不存在或已被移除')
    expect(formatFileSystemError(err, 'file')).toBe('文件不存在或已被移除')
    expect(toUserFileError(err, 'directory').message).toBe('目录不存在或已被移除')
  })

  it('剥离 Electron IPC 包装前缀并翻译裸 ENOENT/EACCES 报文', () => {
    const ipcWrapped = new Error(
      "Error invoking remote method 'fileViews:request': Error: ENOENT: no such file or directory, realpath 'C:\\Users\\demo\\missing.txt'"
    )
    expect(formatFileSystemError(ipcWrapped, 'file')).toBe('文件不存在或已被移除')

    const permWrapped = new Error(
      "Error invoking remote method 'fileViews:request': Error: EACCES: permission denied, open '/secret'"
    )
    expect(formatFileSystemError(permWrapped, 'file')).toBe('没有权限访问该文件')
  })

  it('保留业务自定义错误文案，仅剥离 IPC 外壳', () => {
    expect(formatFileSystemError(new Error("Error invoking remote method 'fileViews:request': Error: 编辑器未配置"), 'file')).toBe('编辑器未配置')
    expect(formatFileSystemError(new Error('ENOENT: 原件缺失'), 'file')).toBe('ENOENT: 原件缺失')
  })
})
