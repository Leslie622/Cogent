/** 仅记录当前文件的阅读位置；隐藏、异步排版和关闭flush不能覆盖另一标签。 */
import { useCallback, useEffect, useRef } from 'react'
import { useFilePreviewStore, type FileViewState, type Preview } from '@/stores/file-preview'

export function useVisualScroll(tabId: string, active: boolean, ready: boolean, rendered = false) {
  const generation = useRef((useFilePreviewStore.getState().byTab[tabId] as Preview | undefined)?.generation).current
  const ref = useRef<HTMLDivElement>(null)
  const retained = useRef<HTMLDivElement | null>(null)
  const enabled = useRef(false)
  enabled.current = active && ready
  const restore = useCallback(() => {
    const element = ref.current
    if (element === null || !enabled.current) return
    retained.current = element
    const saved = useFilePreviewStore.getState().views[tabId] as FileViewState | undefined
    element.scrollTop = (rendered ? saved?.renderScrollTop : saved?.scrollTop) ?? 0
    element.scrollLeft = (rendered ? saved?.renderScrollLeft : saved?.scrollLeft) ?? 0
  }, [tabId, rendered])
  const save = useCallback(() => {
    // React先清ref后运行passive cleanup；保留实际滚动节点，才能flush最后尚未派发的scroll。
    const element = ref.current ?? retained.current
    if (element === null || !enabled.current) return
    retained.current = element
    useFilePreviewStore.getState().setView(tabId, rendered
      ? { renderScrollTop: element.scrollTop, renderScrollLeft: element.scrollLeft }
      : { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft }, generation)
  }, [tabId, rendered, generation])
  useEffect(() => { restore() }, [restore, active, ready])
  useEffect(() => {
    window.addEventListener('workspace:save-view-state', save)
    return () => { save(); window.removeEventListener('workspace:save-view-state', save) }
  }, [save])
  return { ref, onScroll: save, restore }
}
