/** .doc 与 Zcode 使用同一个公开 model/editor/viewer 链，保留只读、虚拟化倍率和失败信息。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocModel, DocxEditorViewerProps } from '@extend-ai/react-docx'
import DocxPreview from '@/features/home/files/visual/DocxPreview'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFilePreviewStore } from '@/stores/file-preview'

const library = vi.hoisted(() => ({ model: vi.fn(), editor: vi.fn(), viewer: vi.fn(), wasm: vi.fn(), modern: vi.fn() }))
vi.mock('docx-preview', () => ({ renderAsync: library.modern }))
vi.mock('@extend-ai/react-docx', async () => {
  const { useEffect } = await import('react')
  return {
    setWasmSource: library.wasm, useDocxModel: library.model, useDocxEditor: library.editor,
    DocxEditorViewer: (props: DocxEditorViewerProps) => {
      library.viewer(props)
      useEffect(() => { props.onPageCountChange?.(3) }, [props.onPageCountChange])
      return <div data-docx-page-wrapper data-docx-page-index="0"><p>旧文档可视化内容</p><a href="https://example.com/legacy">文档外链</a><a href="file:///C:/private.txt">禁止的本机外链</a></div>
    }
  }
})
const model = {} as DocModel
function prepare() {
  return useWorkspaceStore.getState().openFile({ scope: { sessionId: 'legacy-doc', refs: [] }, target: 'legacy.doc' }, 'legacy-doc')
}
beforeEach(() => {
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  library.model.mockReset().mockImplementation((file?: ArrayBuffer) => file === undefined ? { isLoading: false } : { isLoading: false, model })
  library.editor.mockReset().mockReturnValue({ model })
  library.viewer.mockReset(); library.modern.mockReset()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(424)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1200)
})
afterEach(() => { cleanup(); useWorkspaceStore.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('旧 .doc 查看适配', () => {
  it('显式走WASM model/editor只读路径，同一fit倍率交给虚拟列表，显隐保留阅读位置', async () => {
    const bytes = new ArrayBuffer(4), id = prepare(), props = { buffer: bytes, name: 'legacy.doc', tabId: id, onOpenUrl: vi.fn() }
    const view = render(<DocxPreview {...props} active={false} />)
    await waitFor(() => expect(library.model).toHaveBeenCalledWith(undefined))
    expect(library.viewer).not.toHaveBeenCalled()
    view.rerender(<DocxPreview {...props} active />)
    await screen.findByText('旧文档可视化内容')
    expect(library.modern).not.toHaveBeenCalled()
    expect(library.wasm).toHaveBeenCalledWith(expect.stringContaining('docx_wasm_bg.wasm'))
    expect(library.editor).toHaveBeenCalledWith({ starterModel: model, initialFileName: 'legacy.doc', initialDocumentTheme: 'light' })
    await waitFor(() => expect(library.viewer).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'read-only', pageVirtualization: { zoomScale: 0.5 } })))
    expect(screen.getByLabelText('文档页码')).toHaveTextContent('1 / 3')
    const viewport = view.container.querySelector('[data-doc-scaled-frame]')!.parentElement!
    viewport.scrollTop = 230; fireEvent.scroll(viewport)
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    await waitFor(() => expect(library.viewer).toHaveBeenLastCalledWith(expect.objectContaining({ pageVirtualization: { zoomScale: 0.75 } })))
    view.rerender(<DocxPreview {...props} active={false} />)
    viewport.scrollTop = 0; fireEvent.scroll(viewport)
    view.rerender(<DocxPreview {...props} active />)
    expect(viewport.scrollTop).toBe(230)
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ zoom: 0.75, scrollTop: 230 })
  })

  it('旧格式渲染出的链接仍交宿主校验，不能导航当前应用到本机文件', async () => {
    const open = vi.fn()
    render(<DocxPreview buffer={new ArrayBuffer(4)} name="legacy.doc" tabId={prepare()} active onOpenUrl={open} />)
    fireEvent.click(await screen.findByText('文档外链'))
    fireEvent.click(screen.getByText('禁止的本机外链'))
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/legacy')
  })

  it('旧格式解析器拒绝输入时显示真实失败，不返回抽取文本冒充成功', async () => {
    library.model.mockReturnValue({ isLoading: false, error: new Error('Unsupported legacy document') })
    render(<DocxPreview buffer={new ArrayBuffer(4)} name="legacy.doc" tabId={prepare()} active onOpenUrl={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported legacy document')
    expect(library.viewer).not.toHaveBeenCalled()
    expect(library.modern).not.toHaveBeenCalled()
  })
})
