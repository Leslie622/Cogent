/**
 * 模型设置 master-detail 左栏（供应商清单）控制器：像素宽状态机 + localStorage
 * 记忆，机制同 hooks/use-content-sidebar-split（自绘拖拽条、拖拽直写 DOM、松手
 * 提交落盘）—— 左栏是像素语义（要折成固定 48px 图标栏，RRP 百分比引擎给不了
 * 固定像素折叠目标），按 UI布局.md 的双引擎分工走自绘方案。差异仅在折叠目标：
 * 不折成 0，而是折成 RAIL_COLLAPSED 图标栏（品牌标 + 状态点）。
 *
 * 读取是持久化边界（约定 §1.1「持久化读取」行）：形状/范围校验，损坏回落默认
 * —— 布局记忆丢了只是回到默认宽/展开，不值得按「报错而非静默重建」炸整个应用。
 */
import { useRef, useState } from 'react'

/** 左栏夹值区间；SidebarResizeHandle 的 min/max 同源取这两个常量。
    下限之下是折叠阻力区（拖过 min/2 才折），不设更窄的中间态 */
export const RAIL_WIDTH_MIN = 176
export const RAIL_WIDTH_MAX = 320

/** 双击把手恢复的默认宽（原固定 w-72 = 288 偏宽挤占右侧详情，收窄为首发默认） */
export const RAIL_WIDTH_DEFAULT = 208

/** 折叠态（图标栏）宽：36px 图标钮 + 两侧 6px 内距 */
export const RAIL_COLLAPSED = 48

const STORAGE_KEY = 'cogent.ui.models-rail-layout'

type RailLayout = { widthPx: number; collapsed: boolean }

const DEFAULT_LAYOUT: RailLayout = { widthPx: RAIL_WIDTH_DEFAULT, collapsed: false }

function load(): RailLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<RailLayout>
      if (
        typeof saved.widthPx === 'number' &&
        saved.widthPx >= RAIL_WIDTH_MIN &&
        saved.widthPx <= RAIL_WIDTH_MAX &&
        typeof saved.collapsed === 'boolean'
      )
        return { widthPx: saved.widthPx, collapsed: saved.collapsed }
    }
  } catch {
    // 非法 JSON 等损坏：回落默认（理由见文件头）
  }
  return DEFAULT_LAYOUT
}

export function useProviderRailSplit() {
  // 挂载读一次盘即定初值：宽度/折叠态都直接渲染到位，无 imperative 补挂
  const [initial] = useState(load)
  const [widthPx, setWidthPx] = useState(initial.widthPx)
  const [collapsed, setCollapsed] = useState(initial.collapsed)
  // collapsed 的同步镜像：writeWidth 在 rAF 回调里逐帧跑，闭包里的 state 会滞后
  const collapsedRef = useRef(initial.collapsed)
  // 换挡动画的 data-snap 门闩计时器（见 writeWidth）
  const snapTimerRef = useRef(0)

  // 栏本体（裁剪窗）与清单层 DOM 引用：拖拽期间 SidebarResizeHandle 经
  // writeWidth 直写两层宽度，绕开 React 渲染
  const railRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const persist = (layout: RailLayout) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  }

  /** 拖拽/键盘实时写：直写 DOM。展开区间两层同写（清单随拖动逐帧回流）；
      折叠落点只写裁剪窗 —— 清单层保住宽度被裁出画外，收拢动画里行不换行。
      跨过换挡点的瞬间再补两件事 ——
      1) 当场翻转内容层（一次重渲染），宽度与显示模式永不同相；
      2) 给栏打 data-snap 放行 200ms 宽度过渡：容器把手 active 期间本会杀掉
         过渡（拖拽要跟手），换挡的收拢动画是这一规则的唯一例外。
      展开方向还要把拖拽宽同步进 widthPx —— 重渲染会读该状态回写行内宽，
      不同步会把用户拖到的宽度回跳成记忆宽 */
  const writeWidth = (px: number) => {
    const rail = railRef.current
    if (rail) rail.style.width = `${px}px`
    if (px !== RAIL_COLLAPSED && listRef.current) listRef.current.style.width = `${px}px`
    const nextCollapsed = px === RAIL_COLLAPSED
    if (nextCollapsed !== collapsedRef.current) {
      collapsedRef.current = nextCollapsed
      setCollapsed(nextCollapsed)
      if (!nextCollapsed) setWidthPx(px)
      if (rail) {
        rail.dataset.snap = 'true'
        window.clearTimeout(snapTimerRef.current)
        snapTimerRef.current = window.setTimeout(() => {
          delete rail.dataset.snap
        }, 220)
      }
    }
  }

  /** 实时宽：拖拽起点基准，动画中读的也是真实值 */
  const readWidth = () => railRef.current?.getBoundingClientRect().width ?? widthPx

  /** 手势结束提交：进 React 状态 + 落盘。RAIL_COLLAPSED = 折叠（宽度记忆保留原值；
      模式多半已被 writeWidth 翻过，这里幂等收尾并镜像同步） */
  const commit = (px: number) => {
    if (px === RAIL_COLLAPSED) {
      collapsedRef.current = true
      setCollapsed(true)
      persist({ widthPx, collapsed: true })
    } else {
      collapsedRef.current = false
      setCollapsed(false)
      setWidthPx(px)
      persist({ widthPx: px, collapsed: false })
    }
  }

  /** 双击把手：回到默认宽（折叠态下即展开到默认宽） */
  const reset = () => {
    collapsedRef.current = false
    setWidthPx(RAIL_WIDTH_DEFAULT)
    setCollapsed(false)
    persist({ widthPx: RAIL_WIDTH_DEFAULT, collapsed: false })
  }

  return { railRef, listRef, widthPx, collapsed, writeWidth, readWidth, commit, reset }
}
