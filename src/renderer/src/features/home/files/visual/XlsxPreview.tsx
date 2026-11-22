/** 与Zcode使用同一Canvas/WASM查看器；组件只拥有阅读状态，文件字节与租约由上游持有。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from 'react'
import { XlsxViewer, setWasmSource, useXlsxViewerController, type XlsxViewerController } from '@extend-ai/react-xlsx'
import wasmUrl from '@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/Hint'
import { useIsDarkMode } from '@/stores/appearance'
import { useFilePreviewStore } from '@/stores/file-preview'
import { documentUrl, installDocumentLinks } from './links'
import { useVisualScroll } from './use-visual-scroll'
import type { VisualPreviewProps } from './types'

// 绝对URL也能从生产file协议的module worker加载，不能相对worker目录再拼一次assets。
setWasmSource(new URL(wasmUrl, document.baseURI).href)
const MAX_BYTES = 25 * 1024 * 1024
type ScrollerProps = Parameters<NonNullable<ComponentProps<typeof XlsxViewer>['renderScroller']>>[0]
type ReadingScroll = ReturnType<typeof useVisualScroll>

function XlsxScrollport({ children, viewportProps, reading }: ScrollerProps & { reading: ReadingScroll }) {
  const libraryRef = viewportProps.ref
  const ref = useCallback((node: HTMLDivElement | null) => {
    reading.ref.current = node
    if (typeof libraryRef === 'function') {
      const cleanup = libraryRef(node)
      return () => { reading.ref.current = null; if (typeof cleanup === 'function') cleanup(); else libraryRef(null) }
    }
    if (libraryRef !== null) libraryRef.current = node
    return () => { reading.ref.current = null; if (libraryRef !== null) libraryRef.current = null }
  }, [libraryRef, reading.ref])
  return <div {...viewportProps} ref={ref} data-xlsx-scrollport onScroll={event => {
    viewportProps.onScroll?.(event)
    reading.onScroll()
  }}>{children}</div>
}

function SheetTabs({ controller, select }: { controller: XlsxViewerController; select: (index: number) => void }) {
  if (controller.tabs.length <= 1) return null
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = controller.tabs.length
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
      : event.key === 'ArrowLeft' ? (index - 1 + count) % count : event.key === 'ArrowRight' ? (index + 1) % count : null
    if (next === null) return
    event.preventDefault()
    select(next)
    event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus()
  }
  return <div role="tablist" aria-label="工作表" className="flex shrink-0 gap-1 overflow-x-auto px-2 py-1">
    {controller.tabs.map((tab, index) => <Hint key={tab.id} tip={tab.name}><Button type="button" role="tab" size="sm"
      variant={index === controller.activeTabIndex ? 'secondary' : 'ghost'}
      className="max-w-48 shrink-0 truncate" aria-selected={index === controller.activeTabIndex}
      tabIndex={index === controller.activeTabIndex ? 0 : -1} onClick={() => select(index)} onKeyDown={event => keyDown(event, index)}>{tab.name}</Button></Hint>)}
  </div>
}

function WorkbookPreview({ buffer, name, tabId, active, onOpenUrl }: VisualPreviewProps) {
  const root = useRef<HTMLDivElement>(null)
  const dark = useIsDarkMode()
  const controller = useXlsxViewerController({ file: buffer, fileName: name, readOnly: true, maxFileSizeBytes: MAX_BYTES })
  // 只在新字节/标签开始时截取恢复目标，后续默认第一表不能覆盖尚待恢复的表名。
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 动态tabId尚可没有偏好，Record索引未启用noUncheckedIndexedAccess。
  const request = useMemo(() => ({ sheet: useFilePreviewStore.getState().views[tabId]?.sheet }), [buffer, tabId])
  const [restored, setRestored] = useState<typeof request | null>(null)
  const ready = restored === request && !controller.isLoading && controller.error === null
  const { ref: scrollRef, onScroll, restore } = useVisualScroll(tabId, active, ready)
  const reading = useMemo(() => ({ ref: scrollRef, onScroll, restore }), [scrollRef, onScroll, restore])
  const sheet = controller.activeTab?.name

  useEffect(() => {
    if (!active || controller.isLoading || controller.error !== null || controller.tabs.length === 0) return
    if (restored !== request) {
      const index = request.sheet === undefined ? -1 : controller.tabs.findIndex(tab => tab.name === request.sheet)
      if (index >= 0 && index !== controller.activeTabIndex) { controller.setActiveTabIndex(index); return }
      // Chartsheet可能比普通worksheet晚到，不能先把它当成已删除的工作表。
      if (index < 0 && request.sheet !== undefined && controller.isChartsLoading) return
      setRestored(request)
      return
    }
    if (sheet !== undefined) useFilePreviewStore.getState().setView(tabId, { sheet })
  }, [active, controller.isLoading, controller.error, controller.tabs, controller.activeTabIndex, controller.isChartsLoading, controller.setActiveTabIndex, request, restored, sheet, tabId])

  const select = useCallback((index: number) => {
    controller.setActiveTabIndex(index)
    setRestored(request)
    useFilePreviewStore.getState().setView(tabId, { sheet: controller.tabs[index].name })
  }, [controller.setActiveTabIndex, controller.tabs, request, tabId])
  const toolbar = useCallback((value: XlsxViewerController) => <SheetTabs controller={value} select={select} />, [select])
  const openLink = useCallback((value: string) => {
    const url = documentUrl(value)
    if (url !== null) onOpenUrl(url)
  }, [onOpenUrl])
  useEffect(() => installDocumentLinks(root.current!, onOpenUrl), [onOpenUrl])
  const scroller = useCallback((props: ScrollerProps) => <XlsxScrollport {...props} reading={reading} />, [reading])

  return <div ref={root} data-office-preview-kind="excel" data-xlsx-preview={tabId} className="h-full min-h-0 min-w-0 overflow-hidden">
    <XlsxViewer controller={controller} height="100%" isDark={dark} readOnly rounded={false} showDefaultToolbar={false}
      toolbar={toolbar} renderScroller={scroller} onOpenLink={openLink}
      loadingState={<div role="status" aria-busy="true" className="p-3 text-sm text-muted-foreground">正在加载电子表格…</div>}
      errorState={error => <div role="alert" className="p-3 text-sm text-destructive">无法显示电子表格：{error.message}</div>}
      fileTooLargeState={<div role="alert" className="p-3 text-sm text-destructive">电子表格超过25 MiB，无法预览，请使用系统打开。</div>}
    />
  </div>
}

export default function XlsxPreview(props: VisualPreviewProps) {
  if (props.buffer.byteLength > MAX_BYTES) return <div role="alert" className="p-3 text-sm text-destructive">电子表格超过25 MiB，无法预览，请使用系统打开。</div>
  return <WorkbookPreview {...props} />
}
