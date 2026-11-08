/**
 * content-main 的首页内容（UI 件 5，区域代号见 AGENTS.md）：横向再分两区 ——
 *   content-main ─┬─ 主要区（HomeChat）：会话三段式，头部/对话流/输入框
 *                 └─ 标签页区（HomeTabs）：浏览器式工作区壳，可拖可折叠
 * 分栏与 content-sidebar 同一套（react-resizable-panels v4 + GlowResizeHandle）：
 * 拖过下限折成 0、再向外拖恢复，折叠后把手贴主要区右缘即展开抓取点。差别只有
 * 默认态 —— 标签页区平时收起（v4 没有 defaultCollapsed 入参，挂载后 imperative
 * collapse 一次补上）。折叠开关在主要区头部（HomeChat 的标签页折叠钮），状态走
 * onResize 同源，与 AppShell 的 content-sidebar 开关同一手法。
 * 标签页区内容（HomeTabs）本件只搭壳：动作全空位，属后续件。
 */
import { useEffect, useState } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { GlowResizeHandle } from '@/components/GlowResizeHandle'
import { HomeChat } from '@/features/home/HomeChat'
import { HomeTabs } from '@/features/home/HomeTabs'

export function HomeMain() {
  const tabsPanel = usePanelRef()
  const [tabsCollapsed, setTabsCollapsed] = useState(true)

  // 默认折叠：面板注册完成后收一次（子组件先挂载，父 effect 时面板已可用）
  useEffect(() => {
    tabsPanel.current?.collapse()
  }, [tabsPanel])

  // 点钮折叠/展开：命令走 imperative API；状态由 onResize 统一同步（见文件头）
  const toggleTabs = () => {
    const panel = tabsPanel.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      {/* 主要区：不设 min/max，吃满剩余宽度（参考稿里对话是主视角） */}
      <ResizablePanel>
        <HomeChat tabsCollapsed={tabsCollapsed} onToggleTabs={toggleTabs} />
      </ResizablePanel>
      {/* 1px 线 + 把手 + 拖拽光带，同 content-sidebar 分界 */}
      <GlowResizeHandle withHandle />
      <ResizablePanel
        panelRef={tabsPanel}
        onResize={(size) => setTabsCollapsed(size.inPixels === 0)}
        collapsible
        collapsedSize={0}
        minSize="280px"
        maxSize="520px"
        defaultSize="380px"
        className="bg-muted/50"
      >
        <HomeTabs />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
