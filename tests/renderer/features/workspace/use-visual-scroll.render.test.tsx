/** 直接验证真实React ref清理顺序、退出信号和异步排版门控，不模拟hook内部实现。 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVisualScroll } from '@/features/home/files/visual/use-visual-scroll'
import { useFilePreviewStore } from '@/stores/file-preview'
import { useWorkspaceStore } from '@/stores/workspace'

function Viewer({ tabId, active = true, ready = true, rendered = false }: { tabId: string; active?: boolean; ready?: boolean; rendered?: boolean }) {
  const scroll = useVisualScroll(tabId, active, ready, rendered)
  return <div ref={scroll.ref} onScroll={scroll.onScroll} data-reading-viewport />
}
function tab(name: string) {
  return useWorkspaceStore.getState().openFile({ scope: { sessionId: 'scroll-session', refs: [] }, target: name }, 'scroll-session')
}
beforeEach(() => {
  window.cogent = { fileViewsRequest: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.cogent
  useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset(); useWorkspaceStore.getState().setScope('scroll-session')
})
afterEach(() => { cleanup(); useFilePreviewStore.getState().resetAll(); useWorkspaceStore.getState().reset() })

describe('可视化阅读位置生命周期', () => {
  it('React清除ref后的卸载flush仍保存未派发scroll的最终位置，重挂恢复且不串标签', () => {
    const id = tab('manual.docx'), other = tab('other.docx')
    useFilePreviewStore.getState().setView(id, { scrollTop: 20, scrollLeft: 3 })
    useFilePreviewStore.getState().setView(other, { scrollTop: 99, scrollLeft: 7 })
    const view = render(<Viewer tabId={id} />)
    const viewport = view.container.querySelector<HTMLDivElement>('[data-reading-viewport]')!
    expect(viewport.scrollTop).toBe(20)
    // 没有scroll或退出事件；依赖真实卸载时ref已经清空后的cleanup保存。
    viewport.scrollTop = 64; viewport.scrollLeft = 11
    view.unmount()
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ scrollTop: 64, scrollLeft: 11 })
    expect(useFilePreviewStore.getState().views[other]).toMatchObject({ scrollTop: 99, scrollLeft: 7 })
    const restored = render(<Viewer tabId={id} />)
    expect(restored.container.querySelector<HTMLDivElement>('[data-reading-viewport]')!.scrollTop).toBe(64)
  })

  it('隐藏和未排版时的夹零scroll/退出信号不覆盖阅读位置，重新就绪恢复', () => {
    const id = tab('slides.pptx')
    useFilePreviewStore.getState().setView(id, { scrollTop: 321, scrollLeft: 13 })
    const view = render(<Viewer tabId={id} />)
    const viewport = view.container.querySelector<HTMLDivElement>('[data-reading-viewport]')!
    view.rerender(<Viewer tabId={id} active={false} />)
    viewport.scrollTop = 0; viewport.scrollLeft = 0; fireEvent.scroll(viewport)
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ scrollTop: 321, scrollLeft: 13 })
    view.rerender(<Viewer tabId={id} ready={false} />)
    fireEvent.scroll(viewport)
    expect(viewport.scrollTop).toBe(0)
    view.rerender(<Viewer tabId={id} />)
    expect(viewport.scrollTop).toBe(321); expect(viewport.scrollLeft).toBe(13)
  })

  it('Markdown渲染位置保存/退出flush不覆盖同一标签的源码位置', () => {
    const id = tab('readme.md')
    useFilePreviewStore.getState().setView(id, { scrollTop: 40, scrollLeft: 2, renderScrollTop: 200, renderScrollLeft: 5 })
    const view = render(<Viewer tabId={id} rendered />)
    const viewport = view.container.querySelector<HTMLDivElement>('[data-reading-viewport]')!
    expect(viewport.scrollTop).toBe(200); expect(viewport.scrollLeft).toBe(5)
    viewport.scrollTop = 456; viewport.scrollLeft = 9
    act(() => { window.dispatchEvent(new Event('workspace:save-view-state')) })
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ scrollTop: 40, scrollLeft: 2, renderScrollTop: 456, renderScrollLeft: 9 })
    viewport.scrollTop = 789
    view.unmount()
    expect(useFilePreviewStore.getState().views[id]).toMatchObject({ scrollTop: 40, renderScrollTop: 789 })
  })
})
