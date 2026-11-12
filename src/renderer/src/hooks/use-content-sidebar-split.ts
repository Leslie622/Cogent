/**
 * content-sidebar 分栏控制器（AppShell 专用）：纯像素宽状态机 + localStorage 记忆。
 *
 * 侧栏不参与 react-resizable-panels 的百分比引擎（RRP 靠 JS 追赶校正，窗口缩放
 * 画脏帧抖动，且 4.18.1 的 groupResizeBehavior="preserve-pixel-size" 实测无效 ——
 * 裸库探针三组全部按比例跟动）：宽度是 React 状态里的一个像素值，窗口缩放零
 * JS 参与。拖拽由 components/SidebarResizeHandle 自绘（pointer capture + rAF
 * 直写 DOM），手势结束才经 commit 进状态并落盘 —— 记忆天然只记用户意图，
 * 不存在 RRP onLayoutChanged 里「哪些提交该存」的时序辨析。
 *
 * 读取是持久化边界（约定 §1.1「持久化读取」行）：形状/范围校验，损坏回落默认
 * —— 布局记忆丢了只是回到 300px/展开，不值得按「报错而非静默重建」炸整个应用。
 */
import { useRef, useState } from 'react'

/** 侧栏宽度夹值区间；SidebarResizeHandle 的 min/max 同源取这两个常量 */
export const SIDEBAR_WIDTH_MIN = 240
export const SIDEBAR_WIDTH_MAX = 360

/** 双击把手恢复的默认宽 */
export const SIDEBAR_WIDTH_DEFAULT = 300

const STORAGE_KEY = 'cogent.ui.content-sidebar-layout'

type SidebarLayout = { widthPx: number; collapsed: boolean }

const DEFAULT_LAYOUT: SidebarLayout = { widthPx: SIDEBAR_WIDTH_DEFAULT, collapsed: false }

function load(): SidebarLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<SidebarLayout>
      if (
        typeof saved.widthPx === 'number' &&
        saved.widthPx >= SIDEBAR_WIDTH_MIN &&
        saved.widthPx <= SIDEBAR_WIDTH_MAX &&
        typeof saved.collapsed === 'boolean'
      )
        return { widthPx: saved.widthPx, collapsed: saved.collapsed }
    }
  } catch {
    // 非法 JSON 等损坏：回落默认（理由见文件头）
  }
  return DEFAULT_LAYOUT
}

export function useContentSidebarSplit() {
  // 挂载读一次盘即定初值：宽度/折叠态都直接渲染到位，无 imperative 补挂
  const [initial] = useState(load)
  const [widthPx, setWidthPx] = useState(initial.widthPx)
  const [collapsed, setCollapsed] = useState(initial.collapsed)

  // 裁剪窗（外层，宽度承载折叠动画）与内容层（保宽防动画逐帧回流）的 DOM 引用：
  // 拖拽期间 SidebarResizeHandle 经 writeWidth 直写两者，绕开 React 渲染
  const clipRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const persist = (layout: SidebarLayout) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  }

  /** 拖拽/键盘实时写：直写 DOM。折叠（0）只写裁剪窗 —— 内容层保住上次宽度，
      展开时原样回来（与 RRP 时代「内容保形被裁」同一视觉） */
  const writeWidth = (px: number) => {
    if (clipRef.current) clipRef.current.style.width = `${px}px`
    if (px > 0 && contentRef.current) contentRef.current.style.width = `${px}px`
  }

  /** 实时宽（折叠 = 0）：拖拽起点基准，动画中读的也是真实值 */
  const readWidth = () => clipRef.current?.getBoundingClientRect().width ?? widthPx

  /** 手势结束提交：进 React 状态 + 落盘。px = 0 即折叠（宽度记忆保留原值） */
  const commit = (px: number) => {
    if (px === 0) {
      setCollapsed(true)
      persist({ widthPx, collapsed: true })
    } else {
      setWidthPx(px)
      setCollapsed(false)
      persist({ widthPx: px, collapsed: false })
    }
  }

  /** header 折叠开关：宽度记忆不动，展开自然回到原宽 */
  const toggle = () => {
    setCollapsed(!collapsed)
    persist({ widthPx, collapsed: !collapsed })
  }

  /** 双击把手：回到默认宽（折叠态下即展开到默认宽） */
  const reset = () => {
    setWidthPx(SIDEBAR_WIDTH_DEFAULT)
    setCollapsed(false)
    persist({ widthPx: SIDEBAR_WIDTH_DEFAULT, collapsed: false })
  }

  return { clipRef, contentRef, widthPx, collapsed, writeWidth, readWidth, commit, toggle, reset }
}
