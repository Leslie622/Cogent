/**
 * content-main 的首页内容（UI 件 5，区域代号见 AGENTS.md）：横向再分两区 ——
 *   content-main ─┬─ 主要区（HomeChat）：会话三段式，头部/对话流/输入框
 *                 └─ 标签页区（HomeTabs）：浏览器式工作区壳，可拖可折叠
 * 分栏与 content-sidebar 同一套（react-resizable-panels v4 + GlowResizeHandle）：
 * 拖过下限折成 0、再向外拖恢复，折叠后把手贴主要区右缘即展开抓取点。差别只有
 * 默认态 —— 标签页区平时收起（v4 没有 defaultCollapsed 入参，挂载后 imperative
 * collapse 一次补上）。折叠开关在主要区头部（HomeChat 的标签页折叠钮），状态走
 * onResize 同源，与 AppShell 的 content-sidebar 开关同一手法。
 * 文件打开时由 FilePanel 使用同一区域；窄窗转 Dialog，其余标签工具仍由 HomeTabs 占位。
 */
import { useEffect, useRef, useState } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { GlowResizeHandle } from '@/components/GlowResizeHandle'
import { HomeChat } from '@/features/home/HomeChat'
import { HomeTabs } from '@/features/home/HomeTabs'
import { useWindowMediaQuery } from '@/hooks/use-window-media-query'
import { useFilePreviewStore } from '@/stores/file-preview'
import { useChatStore } from '@/stores/chat'
import { FilePanel } from './files/FilePanel'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'

export function HomeMain() {
  const tabsPanel = usePanelRef()
  const splitRoot = useRef<HTMLDivElement | null>(null)
  const [tabsCollapsed, setTabsCollapsed] = useState(true)
  const autoCollapsed = useWindowMediaQuery('(max-width: 1100px)')
  const preview = useFilePreviewStore((state) => state.current)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const previewLayout = useRef<{ collapsed: boolean; widthPx: number } | null>(null)
  const wideLayout = useRef({ collapsed: true, widthPx: 380 })
  const suspendedLayout = useRef<typeof wideLayout.current | null>(null)
  const restoredWidth = useRef<number | null>(null)

  // 默认折叠：面板注册完成后收一次（子组件先挂载，父 effect 时面板已可用）
  useEffect(() => {
    tabsPanel.current?.collapse()
  }, [tabsPanel])

  useEffect(() => {
    if (preview !== null && preview.scope.sessionId !== activeSessionId) useFilePreviewStore.getState().close()
  }, [activeSessionId, preview])
  useEffect(() => {
    const unsubscribe = window.cogent.onEngineEvent((event) => {
      if (event.method === 'files.invalidated') useFilePreviewStore.getState().close()
    })
    return () => { unsubscribe(); useFilePreviewStore.getState().close() }
  }, [])
  useEffect(() => {
    const panel = tabsPanel.current!
    if (autoCollapsed) {
      restoredWidth.current = null
      suspendedLayout.current = { ...wideLayout.current }
      panel.collapse()
    } else if (suspendedLayout.current !== null) {
      const saved = suspendedLayout.current
      if (saved.collapsed) panel.collapse()
      else {
        restoredWidth.current = saved.widthPx
        panel.resize(`${saved.widthPx}px`)
      }
      suspendedLayout.current = null
    }
  }, [autoCollapsed, tabsPanel])

  // 响应式先还原布局，再落实本次明确打开意图，避免旧折叠快照覆盖文件预览。
  useEffect(() => {
    const panel = tabsPanel.current!
    if (preview !== null) {
      previewLayout.current ??= { collapsed: panel.isCollapsed(), widthPx: wideLayout.current.widthPx }
      if (!autoCollapsed) { wideLayout.current.collapsed = false; panel.resize(`${wideLayout.current.widthPx}px`) }
    } else if (previewLayout.current !== null) {
      const saved = previewLayout.current; previewLayout.current = null; wideLayout.current = saved
      if (!autoCollapsed) { if (saved.collapsed) panel.collapse(); else panel.resize(`${saved.widthPx}px`) }
    }
  }, [preview?.generation, autoCollapsed, tabsPanel])

  useEffect(() => {
    const root = splitRoot.current!
    // 左栏恢复有宽度动画，右栏不能只按动画首帧的 group 宽度换算一次百分比。
    // 恢复期间随真实 group 尺寸保持原像素宽；下一次用户输入即归还 RRP 手动布局。
    const observer = new ResizeObserver(() => {
      if (!autoCollapsed && restoredWidth.current !== null) tabsPanel.current!.resize(`${restoredWidth.current}px`)
    })
    const release = () => { restoredWidth.current = null }
    observer.observe(root)
    root.addEventListener('pointerdown', release, true)
    root.addEventListener('keydown', release, true)
    return () => {
      observer.disconnect()
      root.removeEventListener('pointerdown', release, true)
      root.removeEventListener('keydown', release, true)
    }
  }, [autoCollapsed, tabsPanel])

  // 点钮折叠/展开：命令走 imperative API；状态由 onResize 统一同步（见文件头）
  const toggleTabs = () => {
    if (autoCollapsed) return
    restoredWidth.current = null
    const panel = tabsPanel.current
    if (!panel) return
    if (panel.isCollapsed()) {
      wideLayout.current.collapsed = false
      panel.resize(`${wideLayout.current.widthPx}px`)
    } else {
      wideLayout.current = { collapsed: true, widthPx: panel.getSize().inPixels }
      panel.collapse()
    }
  }

  return (
    <><ResizablePanelGroup elementRef={splitRoot} orientation="horizontal" className="h-full" data-home-split>
      {/* 主要区：不设 min/max，吃满剩余宽度（参考稿里对话是主视角） */}
      <ResizablePanel>
        <HomeChat tabsCollapsed={autoCollapsed || tabsCollapsed} tabsToggleDisabled={autoCollapsed} onToggleTabs={toggleTabs} />
      </ResizablePanel>
      {/* 1px 线 + 把手 + 拖拽光带，同 content-sidebar 分界 */}
      <GlowResizeHandle withHandle disabled={autoCollapsed} className={autoCollapsed ? 'hidden' : undefined} />
      <ResizablePanel
        panelRef={tabsPanel}
        onResize={(size) => {
          setTabsCollapsed(size.inPixels === 0)
          // 缩窗引起的收拢与恢复都不是用户选择，不覆盖宽窗布局快照。
          // 仅真实分割线手势修改宽度意图；窗口 resize 的比例重算不能改原宽。
          if (!autoCollapsed && suspendedLayout.current === null && splitRoot.current?.querySelector('[data-separator=active]')) {
            wideLayout.current = {
              collapsed: size.inPixels === 0,
              widthPx: size.inPixels > 0 ? size.inPixels : wideLayout.current.widthPx,
            }
          }
        }}
        collapsible
        collapsedSize={0}
        minSize="280px"
        maxSize="520px"
        defaultSize="380px"
        className="bg-muted/50"
      >
        <div className="h-full" inert={autoCollapsed || tabsCollapsed} data-home-tabs>{preview !== null && !autoCollapsed ? <FilePanel key={preview.descriptor?.fileId ?? 'pending'} /> : <HomeTabs />}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
    {autoCollapsed && preview !== null && <Dialog open onOpenChange={(open) => { if (!open) useFilePreviewStore.getState().close() }}>
      <DialogContent className="h-[85vh] sm:max-w-3xl" showCloseButton={false}>
        <DialogTitle className="sr-only">文件预览</DialogTitle><DialogDescription className="sr-only">查看当前文件并执行桌面文件操作</DialogDescription>
        <FilePanel key={preview.descriptor?.fileId ?? 'pending'} />
      </DialogContent>
    </Dialog>}</>
  )
}
