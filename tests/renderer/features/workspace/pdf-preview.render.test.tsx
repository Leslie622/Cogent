/** react-pdf owns canvas/worker disposal；这里守住宿主页码、隐藏卸载和换版代次。真实文字层另由Electron验证。 */
import { useEffect, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PdfPreview from '@/features/home/files/PdfPreview'
import { useFilePreviewStore, type Preview } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'

const pdf = vi.hoisted(() => ({
  getPage: vi.fn(), dispose: vi.fn(), success: new Map<string, (value: unknown) => void>(),
  renders: [] as { page: number; scale: number; complete: () => void }[]
}))
afterEach(() => {
  cleanup(); useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
  Document: ({ file, children, onLoadSuccess }: { file: string; children: ReactNode; onLoadSuccess: (value: unknown) => void }) => {
    useEffect(() => { pdf.success.set(file, onLoadSuccess) }, [file, onLoadSuccess])
    return <div data-pdf-file={file}>{children}</div>
  },
  Page: ({ pageNumber, scale, renderTextLayer, onRenderSuccess }: { pageNumber: number; scale: number; renderTextLayer: boolean; onRenderSuccess: () => void }) => {
    useEffect(() => {
      // getPage 元数据与 Canvas 真正完成是两个独立边界；每一代只能由测试显式完成。
      pdf.renders.push({ page: pageNumber, scale, complete: onRenderSuccess })
    }, [pageNumber, scale])
    useEffect(() => {
      return () => { pdf.dispose() }
    }, [])
    return <div aria-label={`PDF 第 ${pageNumber} 页`} data-text-layer={String(renderTextLayer)} />
  }
}))

beforeEach(() => {
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  pdf.dispose.mockClear(); pdf.success.clear(); pdf.renders.length = 0
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1)
  pdf.getPage.mockReset().mockResolvedValue({ getViewport: () => ({ width: 612, height: 792 }) })
})
async function loaded(file: string, numPages = 5) {
  await act(async () => { pdf.success.get(file)!({ numPages, getPage: pdf.getPage }); await Promise.resolve() })
}
function tab() {
  return useWorkspaceStore.getState().openFile({ scope: { sessionId: 'pdf-view', refs: [] }, target: 'manual.pdf' }, 'pdf-view')
}

describe('PDF查看器合同', () => {
  it('同一标签换文件后，旧Document迟到的页数夹取不能写入新文件', async () => {
    const id = tab()
    const source: Preview = { tabId: id, leaseId: null, scope: { sessionId: 'pdf-view', refs: [] }, rawTarget: 'old.pdf', operationId: 'old-op', generation: 1, descriptor: null, loading: false, error: null, text: null, encoding: null, url: 'blob:old-owner', document: null, bytes: 0, touchedAt: 0, evicted: false }
    useFilePreviewStore.setState({ byTab: { [id]: source } })
    useFilePreviewStore.getState().setView(id, { page: 3 })
    const view = render(<PdfPreview url="blob:old-owner" tabId={id} active />)
    const stale = pdf.success.get('blob:old-owner')!
    act(() => {
      useFilePreviewStore.setState({ byTab: { [id]: { ...source, generation: 2, rawTarget: 'new.pdf', url: 'blob:new-owner' } } })
      useFilePreviewStore.getState().setView(id, { page: 2 })
    })
    view.rerender(<PdfPreview url="blob:new-owner" tabId={id} active />)
    await loaded('blob:new-owner', 5)
    act(() => { stale({ numPages: 1, getPage: pdf.getPage }) })
    expect(useFilePreviewStore.getState().views[id].page).toBe(2)
    expect(screen.getByRole('spinbutton', { name: 'PDF页码' })).toHaveValue(2)
  })
  it('隐藏不挂Page，激活恢复页码/文字层，隐藏由库卸载释放活动页面', async () => {
    const id = tab(); useFilePreviewStore.getState().setView(id, { page: 3, zoom: 1.5 })
    const view = render(<PdfPreview url="blob:pdf" tabId={id} active={false} />)
    await loaded('blob:pdf')
    expect(pdf.getPage).not.toHaveBeenCalled()
    view.rerender(<PdfPreview url="blob:pdf" tabId={id} active />)
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(3))
    expect(await screen.findByLabelText('PDF 第 3 页')).toHaveAttribute('data-text-layer', 'true')
    view.rerender(<PdfPreview url="blob:pdf" tabId={id} active={false} />)
    expect(screen.queryByLabelText('PDF 第 3 页')).toBeNull()
    expect(pdf.dispose).toHaveBeenCalledTimes(1)
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ page: 3, zoom: 1.5 })
  })
  it('换文件隔离迟到Document，页码与缩放仍由当前标签持有', async () => {
    const id = tab()
    const view = render(<PdfPreview url="blob:old" tabId={id} active />)
    const stale = pdf.success.get('blob:old')!
    view.rerender(<PdfPreview url="blob:new" tabId={id} active />)
    await loaded('blob:new', 2)
    act(() => { stale({ numPages: 99, getPage: pdf.getPage }) })
    expect(screen.getByText('/ 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ page: 2, zoom: 1.25 })
  })

  it('紧凑页码输入、图标翻页和键盘翻页共用当前页且拒绝越界输入', async () => {
    const id = tab()
    render(<PdfPreview url="blob:pagination" tabId={id} active />)
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    await loaded('blob:pagination', 3)
    const input = screen.getByRole('spinbutton', { name: 'PDF页码' })
    fireEvent.change(input, { target: { value: '3' } })
    await screen.findByLabelText('PDF 第 3 页')
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    expect(useFilePreviewStore.getState().views[id].page).toBe(3)
    for (const value of ['0', '4', '1.5']) fireEvent.change(input, { target: { value } })
    expect(input).toHaveValue(3)
    expect(useFilePreviewStore.getState().views[id].page).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    const second = await screen.findByLabelText('PDF 第 2 页')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(useFilePreviewStore.getState().views[id].page).toBe(2)
    fireEvent.keyDown(second, { key: 'ArrowRight' })
    await screen.findByLabelText('PDF 第 3 页')
    expect(useFilePreviewStore.getState().views[id].page).toBe(3)
  })

  it('倍率百分比以适配宽度为100%，点击倍率恢复适配且保留当前页', async () => {
    const id = tab()
    useFilePreviewStore.getState().setView(id, { page: 2 })
    render(<PdfPreview url="blob:zoom-controls" tabId={id} active />)
    await loaded('blob:zoom-controls')
    await screen.findByLabelText('PDF 第 2 页')
    const fitScale = pdf.renders.at(-1)!.scale
    expect(screen.getByRole('button', { name: '适配' })).toHaveTextContent('100%')
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(screen.getByRole('button', { name: '适配' })).toHaveTextContent('125%')
    expect(pdf.renders.at(-1)!.scale).toBeCloseTo(fitScale * 1.25)
    fireEvent.click(screen.getByRole('button', { name: '缩小' }))
    expect(screen.getByRole('button', { name: '适配' })).toHaveTextContent('100%')
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    fireEvent.click(screen.getByRole('button', { name: '适配' }))
    expect(screen.getByRole('button', { name: '适配' })).toHaveTextContent('100%')
    expect(pdf.renders.at(-1)!.scale).toBeCloseTo(fitScale)
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ page: 2, zoom: 1 })
  })

  it('连续缩放保留同一Page实例，不重复进入页面加载；翻页仍更换页面', async () => {
    render(<PdfPreview url="blob:stable-page" active />)
    await loaded('blob:stable-page')
    const first = await screen.findByLabelText('PDF 第 1 页')
    for (let index = 0; index < 8; index++) {
      fireEvent.click(screen.getByRole('button', { name: '放大' }))
      expect(screen.getByLabelText('PDF 第 1 页')).toBe(first)
    }
    expect(screen.getByRole('button', { name: '适配' })).toHaveTextContent('300%')
    expect(pdf.getPage).toHaveBeenCalledExactlyOnceWith(1)
    expect(pdf.dispose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findByLabelText('PDF 第 2 页')
    expect(pdf.dispose).toHaveBeenCalledTimes(1)
    expect(first.isConnected).toBe(false)
  })

  it('长页元数据或上一代Canvas完成不能保存占位滚动，当前Canvas完成才恢复位置', async () => {
    const id = tab()
    useFilePreviewStore.getState().setView(id, { scrollTop: 432, scrollLeft: 19 })
    const view = render(<PdfPreview url="blob:long" tabId={id} active />)
    const viewport = view.container.querySelector<HTMLDivElement>('[data-pdf-viewport]')!
    // 模拟 Chromium 在页面仍是占位时把滚动夹到0；JSDOM自身没有滚动范围排版。
    viewport.scrollTop = 0; fireEvent.scroll(viewport)
    await loaded('blob:long')
    await screen.findByLabelText('PDF 第 1 页')
    const oldCanvas = pdf.renders.at(-1)!
    fireEvent.scroll(viewport)
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ scrollTop: 432, scrollLeft: 19 })
    expect(viewport.scrollTop).toBe(0)

    act(() => { oldCanvas.complete() })
    expect(viewport.scrollTop).toBe(432); expect(viewport.scrollLeft).toBe(19)
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    const newCanvas = pdf.renders.at(-1)!
    expect(newCanvas).not.toBe(oldCanvas)
    expect(newCanvas.scale).toBeGreaterThan(oldCanvas.scale)
    viewport.scrollTop = 0; viewport.scrollLeft = 0
    act(() => { oldCanvas.complete() })
    fireEvent.scroll(viewport)
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ scrollTop: 432, scrollLeft: 19 })
    expect(viewport.scrollTop).toBe(0)
    act(() => { newCanvas.complete() })
    expect(viewport.scrollTop).toBe(432); expect(viewport.scrollLeft).toBe(19)
  })

  it('超过像素预算卸载Canvas期间不保存夹零位置，降低倍率后等待新Canvas恢复', async () => {
    const id = tab()
    useFilePreviewStore.getState().setView(id, { scrollTop: 765, scrollLeft: 8 })
    // 该页面在适配倍率小于40M像素；3倍超过预算，避免依赖运行机器DPR。
    pdf.getPage.mockResolvedValue({ getViewport: () => ({ width: 612, height: 10_000 }) })
    const view = render(<PdfPreview url="blob:pixel-budget" tabId={id} active />)
    await loaded('blob:pixel-budget')
    await screen.findByLabelText('PDF 第 1 页')
    const viewport = view.container.querySelector<HTMLDivElement>('[data-pdf-viewport]')!
    const oldCanvas = pdf.renders.at(-1)!
    act(() => { oldCanvas.complete() })
    expect(viewport.scrollTop).toBe(765)

    act(() => { useFilePreviewStore.getState().setView(id, { zoom: 3 }) })
    expect(screen.getByRole('alert')).toHaveTextContent('页面像素超过预览预算')
    expect(screen.queryByLabelText('PDF 第 1 页')).toBeNull()
    viewport.scrollTop = 0; viewport.scrollLeft = 0; fireEvent.scroll(viewport)
    act(() => { oldCanvas.complete(); window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ scrollTop: 765, scrollLeft: 8 })

    fireEvent.click(screen.getByRole('button', { name: '适配' }))
    await screen.findByLabelText('PDF 第 1 页')
    expect(viewport.scrollTop).toBe(0)
    fireEvent.scroll(viewport)
    expect(useFilePreviewStore.getState().views[id].scrollTop).toBe(765)
    act(() => { pdf.renders.at(-1)!.complete() })
    expect(viewport.scrollTop).toBe(765); expect(viewport.scrollLeft).toBe(8)
  })
})
