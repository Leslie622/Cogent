/** 只管理源码视图的 DOM 生命周期；滚动、原生选择与虚拟行都归当前文件标签。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { File as PierreFile, VirtualizedFile, VirtualFileMetrics } from '@pierre/diffs'
import { useFilePreviewStore, type FileViewState, type Preview } from '@/stores/file-preview'
import { applyCodeSelection, clearCodeHighlights, readCodeSelection, updateCodeHighlights, visibleCodeRanges } from './code-dom'
import { clampCodeSelection, codeLineAt, type CodeDocument, type CodeMatch, type CodeSearchQuery, type CodeSelection } from './code-text'

export function useCodeView(source: CodeDocument, tabId: string | undefined, active: boolean, query: CodeSearchQuery, matches: CodeMatch[], highlightName: string) {
  const container = useRef<HTMLDivElement>(null)
  const initial = useRef(tabId === undefined ? undefined : useFilePreviewStore.getState().views[tabId])
  const generation = useRef(tabId === undefined ? undefined : (useFilePreviewStore.getState().byTab[tabId] as Preview | undefined)?.generation).current
  const [selection, setSelection] = useState(() => clampCodeSelection(initial.current?.selection ?? { anchor: 0, head: 0 }, source.text.length))
  const [lineHeight, setLineHeight] = useState(20)
  const metrics = useRef<VirtualFileMetrics>({ lineHeight: 20, hunkLineCount: 50, diffHeaderHeight: 0, hunkSeparatorHeight: 0, fileGap: 0 })
  const rendered = useRef<{ node: HTMLElement; instance: VirtualizedFile } | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ active, query, matches, selection })
  latest.current = { active, query, matches, selection }
  const lastScroll = useRef({ scrollTop: initial.current?.scrollTop ?? 0, scrollLeft: initial.current?.scrollLeft ?? 0 })
  const restoringScroll = useRef(true)
  const pendingSelection = useRef(initial.current?.selection !== undefined)
  const target = useRef<number | null>(null)
  const targetScrollTop = useRef<number | null>(null)
  const frame = useRef<number | null>(null)

  const write = useCallback((patch: FileViewState) => {
    if (tabId !== undefined) useFilePreviewStore.getState().setView(tabId, patch, generation)
  }, [tabId, generation])

  const refresh = useCallback(() => {
    const view = rendered.current, scroll = scroller.current
    if (view === null || scroll === null || !latest.current.active) return
    const root = view.node.shadowRoot
    if (root === null || root.querySelector('[data-line]') === null) return
    if (restoringScroll.current) {
      scroll.scrollTop = lastScroll.current.scrollTop
      scroll.scrollLeft = lastScroll.current.scrollLeft
      restoringScroll.current = false
    }
    if (target.current !== null) {
      const index = codeLineAt(source, target.current)
      const line = root.querySelector<HTMLElement>(`[data-line][data-line-index="${index}"]`)
      const rect = line?.getBoundingClientRect()
      if (rect !== undefined && rect.height > 0) {
        scroll.scrollTop = Math.max(0, scroll.scrollTop + rect.top - scroll.getBoundingClientRect().top + rect.height / 2 - scroll.clientHeight / 2)
        target.current = null
      } else {
        // 未挂载的行先用实例公开的累计高度进入视口，下一次 onPostRender 再以真实行纠偏。
        let top = view.instance.top ?? 0
        for (let previous = 0; previous < index; previous++) top += view.instance.getLineHeight(previous)
        scroll.scrollTop = Math.max(0, top + view.instance.getLineHeight(index) / 2 - scroll.clientHeight / 2)
      }
      targetScrollTop.current = scroll.scrollTop
      lastScroll.current = { scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft }
    }
    const current = latest.current.selection
    updateCodeHighlights(highlightName, visibleCodeRanges(root, source, latest.current.matches))
    updateCodeHighlights(highlightName + '-selection', visibleCodeRanges(root, source, [{ from: Math.min(current.anchor, current.head), to: Math.max(current.anchor, current.head) }]))
    if (pendingSelection.current && applyCodeSelection(root, source, current)) pendingSelection.current = false
  }, [source, highlightName])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const postRender = useCallback((node: HTMLElement, instance: PierreFile) => {
    // File 在 Virtualizer 上下文中公开返回 VirtualizedFile；不访问其私有缓存。
    rendered.current = { node, instance: instance as VirtualizedFile }
    refreshRef.current()
  }, [])

  const choose = useCallback((value: CodeSelection, center = true) => {
    latest.current.selection = value
    setSelection(value)
    pendingSelection.current = true
    if (center) target.current = Math.min(value.anchor, value.head)
    write({ selection: value })
    refreshRef.current()
  }, [write])

  useLayoutEffect(() => {
    const scroll = container.current!.firstElementChild as HTMLDivElement
    scroller.current = scroll
    scroll.dataset.codeScroll = ''
    scroll.tabIndex = 0
    scroll.setAttribute('aria-label', '源码内容')
    const currentSelection = () => {
      const root = rendered.current?.node.shadowRoot
      return latest.current.active && !pendingSelection.current && root != null ? readCodeSelection(root, source) ?? latest.current.selection : latest.current.selection
    }
    const save = () => {
      const current = latest.current
      if (current.active && !restoringScroll.current) lastScroll.current = { scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft }
      // selectionchange 与 scroll 都可能尚在事件队列；退出信号读取现有 DOM，而不等待事件。
      current.selection = currentSelection()
      write({ ...lastScroll.current, selection: current.selection, searchQuery: current.query })
    }
    const onScroll = () => {
      if (!latest.current.active || restoringScroll.current) return
      if (target.current !== null && scroll.scrollTop !== targetScrollTop.current) target.current = null
      lastScroll.current = { scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft }
      write(lastScroll.current)
    }
    const onSelection = () => {
      const view = rendered.current
      if (!latest.current.active || view === null || view.node.shadowRoot === null || pendingSelection.current) return
      const value = readCodeSelection(view.node.shadowRoot, source)
      if (value === null) return
      latest.current.selection = value
      setSelection(value)
      write({ selection: value })
    }
    const onPointerDown = () => {
      // 用户开始新选区后，停止补写旧的程序选区，交还原生文本选择。
      pendingSelection.current = false
      target.current = null
    }
    const onCopy = (event: ClipboardEvent) => {
      const value = currentSelection()
      if (!latest.current.active || value.anchor === value.head || event.clipboardData === null) return
      event.preventDefault()
      event.clipboardData.setData('text/plain', source.text.slice(Math.min(value.anchor, value.head), Math.max(value.anchor, value.head)))
    }
    const measure = () => {
      const computed = getComputedStyle(container.current!), value = Number.parseFloat(computed.lineHeight)
      // JSDOM 无排版；真实 Chromium 返回 px 行高。空值不应覆盖实例现有度量。
      if (!Number.isFinite(value) || value <= 0 || metrics.current.lineHeight === value) return
      restoringScroll.current = true
      pendingSelection.current = latest.current.selection.anchor !== latest.current.selection.head
      metrics.current = { ...metrics.current, lineHeight: value }
      setLineHeight(value)
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    scroll.addEventListener('pointerdown', onPointerDown)
    scroll.addEventListener('copy', onCopy)
    document.addEventListener('selectionchange', onSelection)
    window.addEventListener('workspace:save-view-state', save)
    const resize = new ResizeObserver(measure)
    resize.observe(container.current!)
    const appearance = new MutationObserver(measure)
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    measure()
    refreshRef.current()
    return () => {
      save()
      resize.disconnect(); appearance.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      scroll.removeEventListener('pointerdown', onPointerDown)
      scroll.removeEventListener('copy', onCopy)
      document.removeEventListener('selectionchange', onSelection)
      window.removeEventListener('workspace:save-view-state', save)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      clearCodeHighlights(highlightName, highlightName + '-selection')
      scroller.current = null
    }
  }, [source, write, highlightName])

  useLayoutEffect(() => {
    if (active) {
      restoringScroll.current = true
      pendingSelection.current = latest.current.selection.anchor !== latest.current.selection.head || initial.current?.selection !== undefined
      refreshRef.current()
    } else clearCodeHighlights(highlightName, highlightName + '-selection')
  }, [active, highlightName])

  useEffect(() => {
    if (!active) return
    const activation = requestAnimationFrame(() => {
      const view = rendered.current
      if (view === null || container.current!.getBoundingClientRect().height === 0) return
      // Pierre隐藏时删掉code但保留renderRange；同范围恢复会跳过绘制。
      // IO回调可能晚于此帧，先用公开可见性接口恢复，再强制重建当前范围。
      view.instance.setVisibility(true)
      view.instance.rerender()
      view.instance.reconcileHeights()
      refreshRef.current()
    })
    return () => cancelAnimationFrame(activation)
  }, [active, lineHeight])

  useEffect(() => {
    write({ searchQuery: query })
    if (!active) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      rendered.current?.instance.reconcileHeights()
      refreshRef.current()
    })
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }
  }, [active, query, matches, selection, lineHeight, write])

  return { container, selection, choose, postRender, metrics: metrics.current, lineHeight, hasSavedSelection: initial.current?.selection !== undefined }
}
