/** 真 Streamdown 默认插件管线：安全处理前后的目标不能丢失相对语义或 Windows 字符。 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/ui/markdown'
import { FileLink, FileLinkContext, type FileLinkScope } from '@/features/home/files/FileLink'
import { decodeFileLink, encodeFileLink, knownFileLink } from '@/lib/file-links'
import { useFilePreviewStore } from '@/stores/file-preview'
const scope: FileLinkScope = { sessionId: 'session', turnId: 'turn', refs: [{ path: 'C:/work/src/app.ts' }] }
function markdown(content: string, streaming = false) { return render(<FileLinkContext.Provider value={scope}><Markdown content={content} streaming={streaming} /></FileLinkContext.Provider>) }
describe('正文文件链接真实渲染', () => {
  it.each([
    ['[相对](../shared/app.ts:12:2)', '../shared/app.ts:12:2'],
    ['[相对](./src/app.ts)', './src/app.ts'],
    ['[无扩展](README)', 'README'],
    [String.raw`[盘符](C:\Users\u\.config\app.ts)`, String.raw`C:\Users\u\.config\app.ts`],
    [String.raw`[标题](C:\Users\u\.config\app.ts "说明")`, String.raw`C:\Users\u\.config\app.ts`],
    [String.raw`[中文](<C:\Users\u\我的 文件\.config\app.ts> "说明")`, String.raw`C:\Users\u\我的 文件\.config\app.ts`],
    [String.raw`[共享](\\server\share\file.txt)`, String.raw`\\server\share\file.txt`],
    ['[百分号](./a%2520%23b.md#L2-L3)', './a%2520%23b.md#L2-L3'],
  ])('%s 保留原目标', (content, target) => {
    markdown(content)
    expect(screen.getByRole('link')).toHaveAttribute('data-file-link', target)
  })
  it('流式未闭合链接不能点，闭合后使用同一委托', () => {
    const open = vi.spyOn(useFilePreviewStore.getState(), 'open').mockResolvedValue(undefined)
    const rendered = markdown('[文件](./src/app', true)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    act(() => rendered.rerender(<FileLinkContext.Provider value={scope}><Markdown content="[文件](./src/app.ts)" streaming /></FileLinkContext.Provider>))
    fireEvent.click(screen.getByRole('link'))
    expect(open).toHaveBeenCalledWith(scope, './src/app.ts'); open.mockRestore()
  })
  it('HTTP 仍走浏览器；脚本和未知协议没有可打开入口', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    markdown('[网页](https://example.com) [脚本](javascript:alert(1)) [其他](unknown:abc) [片段](#abc)')
    fireEvent.click(screen.getByRole('link', { name: '网页' }))
    expect(open).toHaveBeenCalledWith('https://example.com/')
    expect(screen.queryByRole('link', { name: '脚本' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '其他' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '片段' })).not.toHaveAttribute('data-file-link'); open.mockRestore()
  })
  it('只有真实且唯一的反引号文件变链接，围栏及链接内不嵌套', () => {
    markdown('`app.ts` `npm test` [已有 `app.ts`](https://example.com)\n\n```ts\napp.ts\n```')
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'app.ts' })).toHaveAttribute('data-file-link', 'C:/work/src/app.ts')
    expect(knownFileLink('app.ts', [{ path: '/a/app.ts' }, { path: '/b/app.ts' }])).toBeUndefined()
    expect(knownFileLink('missing.ts', scope.refs)).toBeUndefined()
  })
  it('内部载荷需要完整形状和合法本地目标', () => {
    expect(decodeFileLink(encodeFileLink('../a%2520.txt'))).toBe('../a%2520.txt')
    expect(decodeFileLink('#cogent-file:%7B%22v%22%3A2%7D')).toBeUndefined()
    expect(decodeFileLink(encodeFileLink('javascript:alert(1)'))).toBeUndefined()
  })
  it('文件链接内的本地图片委托不生成第二层锚点', () => {
    render(<FileLinkContext.Provider value={scope}><FileLink target="./outer.md"><FileLink target="./picture.png">图片</FileLink></FileLink></FileLinkContext.Provider>)
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByText('图片')).toBeInTheDocument()
  })
  it('词表晚到与会话切换不复用另一份缓存词表', () => {
    const content = '`缓存回填.ts:2:3`'
    const empty: FileLinkScope = { sessionId: 'cache-a', refs: [] }
    const known: FileLinkScope = { ...empty, refs: [{ path: 'C:/a/缓存回填.ts' }] }
    const other: FileLinkScope = { sessionId: 'cache-b', refs: [{ path: 'C:/b/缓存回填.ts' }] }
    const view = render(<FileLinkContext.Provider value={empty}><Markdown content={content} /></FileLinkContext.Provider>)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    view.rerender(<FileLinkContext.Provider value={known}><Markdown content={content} /></FileLinkContext.Provider>)
    expect(screen.getByRole('link')).toHaveAttribute('data-file-link', 'C:/a/缓存回填.ts:2:3')
    view.rerender(<FileLinkContext.Provider value={other}><Markdown content={content} /></FileLinkContext.Provider>)
    expect(screen.getByRole('link')).toHaveAttribute('data-file-link', 'C:/b/缓存回填.ts:2:3')
    view.rerender(<FileLinkContext.Provider value={empty}><Markdown content={content} /></FileLinkContext.Provider>)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
  it('流式与终态均使用当前词表，渐显片段只放在一个标签容器内', () => {
    const current: FileLinkScope = { sessionId: 'stream-files', refs: [{ path: 'C:/work/流式测试.txt' }] }
    const content = '[测试.txt](./流式测试.txt:2:3) 和 `流式测试.txt:2:3`'
    const view = render(<FileLinkContext.Provider value={current}><Markdown content={content} streaming /></FileLinkContext.Provider>)
    const link = screen.getByRole('link', { name: '测试.txt' })
    expect(link.querySelectorAll('[data-reveal]').length).toBeGreaterThan(1)
    expect(link.querySelectorAll(':scope > [data-reveal]')).toHaveLength(0)
    expect(screen.getByRole('link', { name: '流式测试.txt:2:3' })).toBeInTheDocument()
    view.rerender(<FileLinkContext.Provider value={current}><Markdown content={content} /></FileLinkContext.Provider>)
    expect(screen.getByRole('link', { name: '流式测试.txt:2:3' })).toHaveAttribute('data-file-link', 'C:/work/流式测试.txt:2:3')
  })
})
