/** 测宿主接线：Pierre 渲染边界用真实 Shadow 行节点替身，浏览器布局/原生选择另做实机验证。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { File as PierreFile, FileContents, FileOptions, VirtualFileMetrics } from '@pierre/diffs'
import type { CSSProperties, ReactNode } from 'react'
import TextPreview from '@/features/home/files/TextPreview'
import { useFilePreviewStore } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'

const harness = vi.hoisted(() => ({
  dark: false, mounts: 0, unmounts: 0, first: 0, last: Infinity,
  file: null as FileContents | null,
  options: null as FileOptions<undefined> | null,
  metrics: null as VirtualFileMetrics | null,
  host: null as HTMLElement | null,
  instance: { top: 0, getLineHeight: vi.fn(() => 20), reconcileHeights: vi.fn() }
}))
vi.mock('@/stores/appearance', () => ({ useIsDarkMode: () => harness.dark }))
vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react')
  return {
    Virtualizer: ({ children, className, contentClassName }: { children: ReactNode; className: string; contentClassName: string }) => <div className={className}><div className={contentClassName}>{children}</div></div>,
    File: ({ file, options, metrics, className, style }: { file: FileContents; options: FileOptions<undefined>; metrics: VirtualFileMetrics; className: string; style: CSSProperties }) => {
      const host = React.useRef<HTMLDivElement>(null)
      React.useLayoutEffect(() => {
        harness.mounts++
        return () => { harness.unmounts++ }
      }, [])
      React.useLayoutEffect(() => {
        const node = host.current!, root = node.shadowRoot ?? node.attachShadow({ mode: 'open' })
        if (harness.file !== file || root.children.length === 0) {
          root.replaceChildren()
          file.contents.split(/(?<=\n)/).forEach((content, index) => {
            if (index < harness.first || index > harness.last) return
            const line = document.createElement('div')
            line.dataset.line = String(index + 1); line.dataset.lineIndex = String(index)
            const first = document.createElement('span'), last = document.createElement('span')
            first.textContent = content.slice(0, 3); last.textContent = content.slice(3)
            line.append(first, last); root.append(line)
          })
        }
        harness.file = file; harness.options = options; harness.metrics = metrics; harness.host = node
        options.onPostRender!(node, harness.instance as unknown as PierreFile)
      })
      return <div ref={host} className={className} style={style} data-pierre-file />
    }
  }
})

let native: {
  anchorNode: Node | null; anchorOffset: number; focusNode: Node | null; focusOffset: number
  setBaseAndExtent: ReturnType<typeof vi.fn<(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number) => void>>
}
function tab(name = 'example.py') {
  return useWorkspaceStore.getState().openFile({ scope: { sessionId: 'code-session', refs: [] }, target: 'C:/项目/' + name }, 'code-session')
}
function setNative(anchor: number, head: number, notify = true) {
  const line = harness.host!.shadowRoot!.querySelector('[data-line]')!
  const point = (offset: number) => offset <= 3 ? [line.firstChild!.firstChild!, offset] as const : [line.lastChild!.firstChild!, offset - 3] as const
  const start = point(anchor), end = point(head)
  native.setBaseAndExtent(start[0], start[1], end[0], end[1])
  if (notify) act(() => { document.dispatchEvent(new Event('selectionchange')) })
}
beforeEach(() => {
  harness.dark = false; harness.mounts = 0; harness.unmounts = 0; harness.first = 0; harness.last = Infinity
  harness.file = null; harness.host = null; harness.options = null; harness.metrics = null
  harness.instance.getLineHeight.mockClear(); harness.instance.reconcileHeights.mockClear()
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset(); useWorkspaceStore.getState().setScope('code-session')
  native = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, setBaseAndExtent: vi.fn((anchor: Node, anchorOffset: number, focus: Node, focusOffset: number) => {
    Object.assign(native, { anchorNode: anchor, anchorOffset, focusNode: focus, focusOffset })
  }) }
  vi.spyOn(window, 'getSelection').mockImplementation(() => native as unknown as Selection)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('CSS', { highlights: new Map() })
  vi.stubGlobal('Highlight', class { constructor(...ranges: Range[]) { Object.assign(this, { ranges }) } })
})
afterEach(() => {
  cleanup(); useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('Pierre 源码预览宿主', () => {
  it('SVG源码显式使用XML语法，不被库缺失的svg扩展名映射降为纯文本', () => {
    render(<TextPreview text={'<svg xmlns="http://www.w3.org/2000/svg" />'} name="image.svg" active />)
    expect(harness.file).toMatchObject({ name: 'image.svg', lang: 'xml' })
  })
  it('以文件名交给广语言查看器、WASM高亮与虚拟行，暗色/隐藏切换保留实例', () => {
    const id = tab(), view = render(<TextPreview text={"print('中文')\n"} name="example.py" tabId={id} active />)
    const node = view.container.querySelector('[data-pierre-file]')
    expect(view.container.querySelector('[data-code-preview]')).toBeInTheDocument()
    expect(view.container.querySelector('[data-code-scroll]')).toHaveAttribute('aria-label', '源码内容')
    expect(view.container.querySelector('.cm-editor')).toBeNull()
    expect(harness.file).toMatchObject({ name: 'example.py', contents: "print('中文')\n\n" })
    expect(harness.options).toMatchObject({ preferredHighlighter: 'shiki-wasm', disableLineNumbers: false, disableFileHeader: true, overflow: 'wrap', themeType: 'light' })
    expect(harness.metrics?.hunkLineCount).toBe(50)
    expect(view.container.querySelector('.code-typography')).toBeInTheDocument()
    harness.dark = true
    view.rerender(<TextPreview text={"print('中文')\n"} name="example.py" tabId={id} active={false} />)
    view.rerender(<TextPreview text={"print('中文')\n"} name="example.py" tabId={id} active />)
    expect(view.container.querySelector('[data-pierre-file]')).toBe(node)
    expect(harness.options?.themeType).toBe('dark')
    expect(harness.mounts).toBe(1); expect(harness.unmounts).toBe(0)
  })

  it('选区3..8、beta搜索、未派发scroll的64位置在退出立即保存并重挂恢复', async () => {
    const id = tab(), props = { text: 'alpha beta gamma', name: 'example.py', tabId: id, active: true }
    const view = render(<TextPreview {...props} />)
    setNative(3, 8, false)
    expect(screen.queryByRole('button', { name: /^搜索$/ })).toBeNull()
    fireEvent.keyDown(view.container.querySelector('[data-code-preview]')!, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: '搜索源码' }), { target: { value: 'beta' } })
    const scroll = view.container.querySelector<HTMLElement>('[data-code-scroll]')!
    scroll.scrollTop = 64; scroll.scrollLeft = 7
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ selection: { anchor: 3, head: 8 }, searchQuery: { search: 'beta', caseSensitive: false, regexp: false, wholeWord: false }, scrollTop: 64, scrollLeft: 7 })
    view.unmount()
    native.anchorNode = null; native.focusNode = null
    const restored = render(<TextPreview {...props} location={{ line: 1, column: 1 }} />)
    const restoredScroll = restored.container.querySelector<HTMLElement>('[data-code-scroll]')!
    expect(restoredScroll.scrollTop).toBe(64); expect(restoredScroll.scrollLeft).toBe(7)
    expect(native.anchorOffset).toBe(3); expect(native.focusOffset).toBe(5)
    expect(native.anchorNode!.getRootNode()).toBe(harness.host!.shadowRoot)
    fireEvent.keyDown(harness.host!.closest('[data-code-preview]')!, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('textbox', { name: '搜索源码' })).toHaveValue('beta')
    await waitFor(() => expect(useFilePreviewStore.getState().views[id].selection).toEqual({ anchor: 3, head: 8 }))
  })

  it('搜索选中实际 token 跨节点范围，保留正则/大小写/全字并报告非法表达式', () => {
    const id = tab(), view = render(<TextPreview text="beta BETAS beta" name="example.py" tabId={id} />)
    fireEvent.keyDown(view.container.querySelector('[data-code-preview]')!, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: '搜索源码' }), { target: { value: 'beta' } })
    fireEvent.click(screen.getByRole('button', { name: '全字匹配' }))
    fireEvent.click(screen.getByRole('button', { name: '区分大小写' }))
    fireEvent.click(screen.getByRole('button', { name: '下一个匹配' }))
    expect(useFilePreviewStore.getState().views[id].selection).toEqual({ anchor: 0, head: 4 })
    expect(native.anchorNode!.textContent).toBe('bet'); expect(native.anchorOffset).toBe(0)
    expect(native.focusNode!.textContent).toBe('a BETAS beta'); expect(native.focusOffset).toBe(1)
    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索源码' }), { key: 'Enter' })
    expect(useFilePreviewStore.getState().views[id].selection).toEqual({ anchor: 11, head: 15 })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect((globalThis.CSS as typeof CSS & { highlights: Map<string, unknown> }).highlights.size).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '正则表达式' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索源码' }), { target: { value: '[' } })
    expect(screen.getByText(/搜索表达式无效/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一个匹配' })).toBeDisabled()
    expect(useFilePreviewStore.getState().views[id].searchQuery).toEqual({ search: '[', caseSensitive: true, regexp: true, wholeWord: true })
  })

  it('行列与行范围作用于真实Shadow行，越界明确报告，同目标对象更新不跳回', () => {
    const id = tab(), props = { text: 'first\r\nsecond\r\nthird', name: 'example.py', tabId: id }
    const view = render(<TextPreview {...props} location={{ line: 2, column: 3 }} />)
    expect(screen.getByText('已定位：第 2 行，第 3 列')).toBeInTheDocument()
    expect(useFilePreviewStore.getState().views[id].selection).toEqual({ anchor: 9, head: 9 })
    expect((native.anchorNode!.parentElement!.parentElement!).dataset.line).toBe('2')
    view.rerender(<TextPreview {...props} location={{ line: 2, endLine: 3 }} />)
    expect(screen.getByText('已定位：第 2～3 行')).toBeInTheDocument()
    expect(useFilePreviewStore.getState().views[id].selection).toEqual({ anchor: 7, head: 20 })
    const before = native.setBaseAndExtent.mock.calls.length
    view.rerender(<TextPreview {...props} location={{ line: 2, endLine: 3 }} />)
    expect(native.setBaseAndExtent).toHaveBeenCalledTimes(before)
    view.rerender(<TextPreview {...props} location={{ line: 9 }} />)
    expect(screen.getByText('行号超出当前文件范围，已打开文件')).toBeInTheDocument()
    view.rerender(<TextPreview {...props} location={{ line: 2, column: 9 }} />)
    expect(screen.getByText('列号超出当前行范围，已打开文件')).toBeInTheDocument()
  })

  it('未挂载的远行先按公开高度滚动，复制完整原文范围；隐藏不覆盖已保存滚动', () => {
    harness.last = 1
    const id = tab(), text = Array.from({ length: 100 }, (_, index) => 'line-' + index).join('\n')
    const view = render(<TextPreview text={text} name="example.py" tabId={id} location={{ line: 80, endLine: 90 }} />)
    const scroll = view.container.querySelector<HTMLElement>('[data-code-scroll]')!
    expect(scroll.scrollTop).toBe(1590)
    expect(harness.instance.getLineHeight).toHaveBeenCalledWith(79)
    const setData = vi.fn(), event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData } })
    scroll.dispatchEvent(event)
    expect(setData).toHaveBeenCalledWith('text/plain', Array.from({ length: 11 }, (_, index) => 'line-' + (index + 79)).join('\n'))
    scroll.scrollTop = 432; fireEvent.scroll(scroll)
    view.rerender(<TextPreview text={text} name="example.py" tabId={id} active={false} location={{ line: 80, endLine: 90 }} />)
    scroll.scrollTop = 0; fireEvent.scroll(scroll)
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id].scrollTop).toBe(432)
    view.rerender(<TextPreview text={text} name="example.py" tabId={id} active location={{ line: 80, endLine: 90 }} />)
    expect(scroll.scrollTop).toBe(432)
    view.unmount()
    expect((globalThis.CSS as typeof CSS & { highlights: Map<string, unknown> }).highlights.size).toBe(0)
  })
})
