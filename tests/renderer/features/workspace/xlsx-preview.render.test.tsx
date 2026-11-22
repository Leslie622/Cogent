/** 只验证XLSX适配层的导航/恢复/链接与生命周期；真正WASM、样式及图形由产品夹具验证。 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UseXlsxViewerControllerOptions, XlsxViewerController, XlsxViewerProps } from '@extend-ai/react-xlsx'
import XlsxPreview from '@/features/home/files/visual/XlsxPreview'
import { useFilePreviewStore } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'

interface WorkbookState {
  tabs: Array<{ id: string; name: string }>
  activeTabIndex: number
  isLoading: boolean
  isChartsLoading: boolean
  error: Error | null
}
type ViewerProps = XlsxViewerProps & { onOpenLink?: (url: string) => void }
const harness = vi.hoisted(() => ({
  models: new Map<ArrayBuffer, WorkbookState>(),
  listeners: new Map<ArrayBuffer, Set<() => void>>(),
  props: new Map<ArrayBuffer, ViewerProps>(),
  options: new Map<ArrayBuffer, UseXlsxViewerControllerOptions>(),
  selections: [] as Array<{ buffer: ArrayBuffer; index: number }>,
  wasm: [] as unknown[], mounts: 0, unmounts: 0, dark: false,
  libraryScroll: vi.fn(),
}))
vi.mock('@/stores/appearance', () => ({ useIsDarkMode: () => harness.dark }))
vi.mock('@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url', () => ({ default: '/assets/xlsx.wasm' }))
vi.mock('@extend-ai/react-xlsx', async () => {
  const React = await import('react')
  return {
    setWasmSource: (source: unknown) => { harness.wasm.push(source) },
    useXlsxViewerController: (options: UseXlsxViewerControllerOptions) => {
      const buffer = options.file!
      harness.options.set(buffer, options)
      const subscribe = React.useCallback((listener: () => void) => {
        const listeners = harness.listeners.get(buffer) ?? new Set<() => void>()
        harness.listeners.set(buffer, listeners); listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [buffer])
      const state = React.useSyncExternalStore(subscribe, () => harness.models.get(buffer)!)
      const setActiveTabIndex = React.useCallback((index: number) => {
        harness.selections.push({ buffer, index })
        harness.models.set(buffer, { ...harness.models.get(buffer)!, activeTabIndex: index })
        harness.listeners.get(buffer)?.forEach(listener => listener())
      }, [buffer])
      return { ...state, activeTab: state.tabs[state.activeTabIndex], setActiveTabIndex, file: buffer } as unknown as XlsxViewerController
    },
    XlsxViewer: (props: ViewerProps) => {
      const controller = props.controller!, buffer = controller.file!
      harness.props.set(buffer, props)
      const viewport = React.useRef<HTMLDivElement>(null)
      React.useEffect(() => { harness.mounts++; return () => { harness.unmounts++ } }, [])
      if (controller.isLoading) return props.loadingState
      if (controller.error !== null) return typeof props.errorState === 'function' ? props.errorState(controller.error) : props.errorState
      return <div data-mock-xlsx={buffer.byteLength}>
        {typeof props.toolbar === 'function' ? props.toolbar(controller) : props.toolbar}
        {props.renderScroller!({
          children: <canvas data-xlsx-grid />,
          viewportProps: { ref: viewport, style: { overflow: 'auto' }, tabIndex: 0, role: 'grid', onScroll: harness.libraryScroll },
        })}
      </div>
    },
  }
})

function workbook(names = ['汇总', '明细'], patch: Partial<WorkbookState> = {}) {
  const buffer = new ArrayBuffer(8 + harness.models.size)
  harness.models.set(buffer, { tabs: names.map((name, index) => ({ id: 'sheet-' + index, name })), activeTabIndex: 0, isLoading: false, isChartsLoading: false, error: null, ...patch })
  return buffer
}
function update(buffer: ArrayBuffer, patch: Partial<WorkbookState>) {
  act(() => {
    harness.models.set(buffer, { ...harness.models.get(buffer)!, ...patch })
    harness.listeners.get(buffer)?.forEach(listener => listener())
  })
}
function tab(name: string) {
  return useWorkspaceStore.getState().openFile({ scope: { sessionId: 'xlsx-session', refs: [] }, target: 'C:/项目/' + name }, 'xlsx-session')
}
beforeEach(() => {
  harness.models.clear(); harness.listeners.clear(); harness.props.clear(); harness.options.clear(); harness.selections.length = 0
  harness.mounts = 0; harness.unmounts = 0; harness.dark = false; harness.libraryScroll.mockClear()
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset(); useWorkspaceStore.getState().setScope('xlsx-session')
})
afterEach(() => { cleanup(); useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset() })

describe('XLSX宿主适配', () => {
  it('将原始buffer交给同版只读查看器，明暗与隐藏切换不重建网格', () => {
    const buffer = workbook(), tabId = tab('book.xlsx'), open = vi.fn()
    const view = render(<XlsxPreview buffer={buffer} name="book.xlsx" tabId={tabId} active onOpenUrl={open} />)
    const canvas = view.container.querySelector('canvas')
    expect(harness.options.get(buffer)).toEqual({ file: buffer, fileName: 'book.xlsx', readOnly: true, maxFileSizeBytes: 25 * 1024 * 1024 })
    expect(harness.props.get(buffer)).toMatchObject({ readOnly: true, rounded: false, showDefaultToolbar: false, height: '100%', isDark: false })
    expect(harness.props.get(buffer)?.experimentalCanvas).toBeUndefined()
    expect(harness.props.get(buffer)?.showImages).toBeUndefined()
    expect(harness.wasm[0]).toBe(new URL('/assets/xlsx.wasm', document.baseURI).href)
    harness.dark = true
    view.rerender(<XlsxPreview buffer={buffer} name="book.xlsx" tabId={tabId} active={false} onOpenUrl={open} />)
    view.rerender(<XlsxPreview buffer={buffer} name="book.xlsx" tabId={tabId} active onOpenUrl={open} />)
    expect(view.container.querySelector('canvas')).toBe(canvas)
    expect(harness.props.get(buffer)?.isDark).toBe(true)
    expect(harness.mounts).toBe(1); expect(harness.unmounts).toBe(0)
    view.unmount(); expect(harness.unmounts).toBe(1)
  })
  it('只读工作表支持循环方向键、Home/End和焦点，不显示单表导航', () => {
    const buffer = workbook(['甲', '乙', '丙']), tabId = tab('keys.xlsx')
    const view = render(<XlsxPreview buffer={buffer} name="keys.xlsx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: '甲' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: '丙' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: '丙' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByRole('tab', { name: '丙' }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: '甲' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: '甲' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: '乙' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: '乙' }), { key: 'End' })
    expect(useFilePreviewStore.getState().views[tabId].sheet).toBe('丙')
    expect(screen.getByRole('tab', { name: '甲' })).toHaveAttribute('tabindex', '-1')
    view.unmount()
    render(<XlsxPreview buffer={workbook(['唯一'])} name="single.xlsx" tabId={tab('single.xlsx')} active onOpenUrl={vi.fn()} />)
    expect(screen.queryByRole('tablist')).toBeNull()
  })
  it('等待延迟chartsheet恢复，不让默认第一表覆盖旧偏好', async () => {
    const buffer = workbook([], { isLoading: true }), tabId = tab('restore.xlsx')
    useFilePreviewStore.getState().setView(tabId, { sheet: '图表页' })
    render(<XlsxPreview buffer={buffer} name="restore.xlsx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载')
    update(buffer, { tabs: [{ id: 'first', name: '汇总' }], isLoading: false, isChartsLoading: true })
    expect(useFilePreviewStore.getState().views[tabId].sheet).toBe('图表页')
    expect(harness.selections).toHaveLength(0)
    update(buffer, { tabs: [{ id: 'first', name: '汇总' }, { id: 'chart', name: '图表页' }], isChartsLoading: false })
    await waitFor(() => expect(screen.getByRole('tab', { name: '图表页' })).toHaveAttribute('aria-selected', 'true'))
    expect(harness.selections.map(value => value.index)).toEqual([1])
    expect(useFilePreviewStore.getState().views[tabId].sheet).toBe('图表页')
  })
  it('显式选择可以覆盖待恢复目标，其他文件标签的sheet不被改动', () => {
    const first = workbook(['甲', '乙'], { isChartsLoading: true }), second = workbook(['甲', '乙'])
    const a = tab('a.xlsx'), b = tab('b.xlsx')
    useFilePreviewStore.getState().setView(a, { sheet: '待到达图表' }); useFilePreviewStore.getState().setView(b, { sheet: '乙' })
    const view = render(<><XlsxPreview buffer={first} name="a.xlsx" tabId={a} active onOpenUrl={vi.fn()} /><XlsxPreview buffer={second} name="b.xlsx" tabId={b} active={false} onOpenUrl={vi.fn()} /></>)
    const firstRoot = view.container.querySelector<HTMLElement>(`[data-xlsx-preview="${a}"]`)!
    fireEvent.click(within(firstRoot).getByRole('tab', { name: '乙' }))
    update(first, { isChartsLoading: false })
    expect(useFilePreviewStore.getState().views[a].sheet).toBe('乙')
    expect(useFilePreviewStore.getState().views[b].sheet).toBe('乙')
    expect(harness.models.get(second)?.activeTabIndex).toBe(0)
  })
  it('保存实际grid滚动并在激活恢复，隐藏期间零尺寸不覆盖原位置', () => {
    const buffer = workbook(), tabId = tab('scroll.xlsx'), open = vi.fn()
    useFilePreviewStore.getState().setView(tabId, { sheet: '明细', scrollTop: 160, scrollLeft: 64 })
    const view = render(<XlsxPreview buffer={buffer} name="scroll.xlsx" tabId={tabId} active onOpenUrl={open} />)
    const grid = screen.getByRole('grid')
    expect(grid.scrollTop).toBe(160); expect(grid.scrollLeft).toBe(64)
    grid.scrollTop = 211; fireEvent.scroll(grid)
    expect(harness.libraryScroll).toHaveBeenCalled()
    expect(useFilePreviewStore.getState().views[tabId].scrollTop).toBe(211)
    view.rerender(<XlsxPreview buffer={buffer} name="scroll.xlsx" tabId={tabId} active={false} onOpenUrl={open} />)
    grid.scrollTop = 0; fireEvent.scroll(grid)
    expect(useFilePreviewStore.getState().views[tabId].scrollTop).toBe(211)
    view.rerender(<XlsxPreview buffer={buffer} name="scroll.xlsx" tabId={tabId} active onOpenUrl={open} />)
    expect(screen.getByRole('grid')).toBe(grid); expect(grid.scrollTop).toBe(211)
    grid.scrollLeft = 97
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[tabId].scrollLeft).toBe(97)
  })
  it('Canvas回调与DOM链接都只经HTTP(S)宿主出口，卸载后移除DOM守卫', () => {
    const buffer = workbook(), tabId = tab('links.xlsx'), open = vi.fn()
    const view = render(<XlsxPreview buffer={buffer} name="links.xlsx" tabId={tabId} active onOpenUrl={open} />)
    const callback = harness.props.get(buffer)!.onOpenLink!
    for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'cogent-preview://token/a', '#明细!A1', 'https://user:secret@example.org']) callback(url)
    expect(open).not.toHaveBeenCalled()
    callback('https://example.org/path')
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.org/path')
    const root = view.container.querySelector<HTMLElement>('[data-xlsx-preview]')!, anchor = document.createElement('a')
    anchor.href = 'https://example.org/dom'; anchor.textContent = '链接'; root.append(anchor)
    fireEvent.click(anchor)
    expect(open).toHaveBeenLastCalledWith('https://example.org/dom')
    view.unmount(); open.mockClear(); anchor.addEventListener('click', event => event.preventDefault()); fireEvent.click(anchor)
    expect(open).not.toHaveBeenCalled()
  })
  it('超限在解析前拒绝，坏工作簿显示错误而不写入工作表偏好', () => {
    const tooLarge = new ArrayBuffer(25 * 1024 * 1024 + 1), tabId = tab('large.xlsx')
    const view = render(<XlsxPreview buffer={tooLarge} name="large.xlsx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('超过25 MiB')
    expect(harness.options.size).toBe(0)
    const invalid = workbook([], { error: new Error('工作簿已损坏') })
    view.rerender(<XlsxPreview buffer={invalid} name="large.xlsx" tabId={tabId} active onOpenUrl={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('工作簿已损坏')
    expect(useFilePreviewStore.getState().views[tabId]).toBeUndefined()
  })
})
