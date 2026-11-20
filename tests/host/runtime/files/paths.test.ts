/** 钉路径平台、百分号单次解码和单文件工具边界，避免 URL 清洗后猜路径。 */
import { describe, expect, it } from 'vitest'
import { parseFileTarget } from '../../../../src/shared/file-target'
import { resolveFileTarget, toolFileReferences } from '../../../../src/host/runtime/files/paths'
import type { FileContext } from '../../../../src/shared/files'
const windows: FileContext = { version: 1, userEntryId: 'entry', turnId: 'turn', cwd: 'C:\\project\\src', roots: ['C:\\project'], platform: 'win32' }
describe('文件路径来源', () => {
  it.each(['./测试.txt#L2C3', './测试.txt#L2:C3', './测试.txt#L2:3', './测试.txt:2:3'])('行列写法 %s 指向同一位置', (target) => {
    expect(parseFileTarget(target)).toEqual({ path: './测试.txt', location: { line: 2, column: 3 } })
  })
  it('保留父级、Home、空格中文和字面百分号', () => {
    expect(resolveFileTarget('../报告%2520.md:12:3', windows, 'C:\\Users\\u')).toMatchObject({ path: 'C:\\project\\报告%20.md', location: { line: 12, column: 3 } })
    expect(resolveFileTarget('~/报告%20一.md#L2-L5', windows, 'C:\\Users\\u')).toMatchObject({ path: 'C:\\Users\\u\\报告 一.md', location: { line: 2, endLine: 5 } })
    expect(resolveFileTarget('file://server/share/a%23b.txt', windows, 'C:\\Users\\u').path).toBe('\\\\server\\share\\a#b.txt')
    expect(resolveFileTarget('\\\\server\\share\\a.txt', windows, '').path).toBe('\\\\server\\share\\a.txt')
  })
  it('网页、未完成标记和脚本不能混入本地目标', () => {
    for (const value of ['https://example.com/a', '//example.com/a', '#part', 'streamdown:incomplete-link', 'javascript:alert(1)', 'javascript:12', '%6aavascript%3Aalert(1)', 'a%00.txt', 'a%zz']) expect(parseFileTarget(value)).toBeUndefined()
    expect(parseFileTarget('a%23b%3F.txt')).toMatchObject({ path: 'a#b?.txt' })
    expect(parseFileTarget('a.txt%3A12')).toEqual({ path: 'a.txt:12' })
    expect(parseFileTarget('a.txt:0')?.path).toBe('a.txt')
    expect(parseFileTarget('a.txt:0')?.locationWarning).toBeTypeOf('string')
  })
  it('异平台路径明确失败，POSIX 路径按原 cwd 解析', () => {
    expect(() => resolveFileTarget('/etc/hosts', windows, '')).toThrow('另一种操作系统')
    expect(() => resolveFileTarget('C:/a', { cwd: '/work', platform: 'linux' }, '/home/u')).toThrow('另一种操作系统')
    expect(resolveFileTarget('../a', { cwd: '/work/src', platform: 'linux' }, '/home/u').path).toBe('/work/a')
  })
  it('只认结构化 read/write/edit，不把 shell 或 MCP 参数当文件', () => {
    expect(toolFileReferences('read', { path: 'a#b%20.ts' }, windows)).toEqual([{ path: 'C:\\project\\src\\a#b%20.ts', turnId: 'turn' }])
    expect(toolFileReferences('read', { path: '@C:/my\u00a0files/app.ts' }, windows)[0].path).toBe('C:\\my files\\app.ts')
    expect(toolFileReferences('read', { path: '/mnt/d/code/app.ts' }, windows)[0].path).toBe('D:\\code\\app.ts')
    expect(toolFileReferences('powershell', { command: 'cat a.ts' }, windows)).toEqual([])
    expect(toolFileReferences('mcp__read', { path: 'a.ts' }, windows)).toEqual([])
  })
})
