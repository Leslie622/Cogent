import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useDividerGlow } from '@/hooks/use-divider-glow'

interface SidebarResizeHandleProps {
  min: number
  max: number
  /** 中央胶囊只作拖拽提示，隐藏时仍由整条分割线承接交互。 */
  withHandle?: boolean
  /** 折叠目标宽（px）。content-sidebar 折成 0（缺省）；模型设置左栏折成
      48px 图标栏 —— 拖过 min/2 落到该值而非 0 */
  collapsedWidth?: number
  /** 读当前实时宽度（px；折叠 = collapsedWidth）。拖拽起点以此为准，不依赖 React 状态 */
  readWidth: () => number
  /** 拖拽/键盘实时写宽度（px；collapsedWidth = 折叠）—— 直写 DOM 绕开 React 渲染 */
  writeWidth: (px: number) => void
  /** 手势结束提交一次（此时才进 React 状态并持久化；collapsedWidth = 折叠） */
  onCommit: (px: number) => void
  /** 双击恢复默认宽度 */
  onReset: () => void
}

type SeparatorState = 'inactive' | 'hover' | 'active'

/**
 * 水平拖拽光标，与库（react-resizable-panels）同选：Chromium/Gecko 上 ew-resize
 * 渲染为系统标准「左右箭头」，WebKit 上该字形异常故回落 col-resize。
 */
let cursorCache: string | undefined
function horizontalResizeCursor(): string {
  if (cursorCache === undefined) {
    const ua = typeof window !== 'undefined' ? window.navigator.userAgent : ''
    cursorCache = ua.includes('Chrome') || ua.includes('Firefox') ? 'ew-resize' : 'col-resize'
  }
  return cursorCache
}

/**
 * 自绘像素宽拖拽条（content-sidebar 与模型设置供应商栏共用，方案移植自
 * Themd）。不参与 react-resizable-panels 的百分比引擎（引擎靠 JS 追赶校正，
 * 窗口缩放画脏帧抖动，且 4.18.1 的 preserve-pixel-size 实测无效），宽度是
 * 纯 CSS 像素值，拖拽在此直写 DOM：pointer capture + rAF 节流，松手才
 * onCommit 进 React 状态与持久化。
 *
 * 交互对齐 RRP 时代的既定手感：拖过下限先钉在下限（阻力区），继续拖过
 * min/2 才折叠（落点 collapsedWidth，缺省 0；模型设置左栏 = 图标栏宽）、
 * 折叠后向外拖过 min/2 恢复（对齐库 collapsedThreshold 默认，见
 * docs/UI布局.md）；键盘 ←/→ 步进 ±16px（折叠态 → 右键展开到下限），
 * 双击回默认。
 *
 * 样式对齐 shadcn ResizableHandle，中央胶囊由 withHandle 控制；data-separator
 * 状态机（hover/active）与库同构 —— use-divider-glow 的光带与 AppShell 容器的
 * 「拖拽杀过渡」:has() 选择器都以它为观察源，自绘后光带/过渡行为不变。
 */
export function SidebarResizeHandle({ min, max, withHandle = true, collapsedWidth = 0, readWidth, writeWidth, onCommit, onReset }: SidebarResizeHandleProps) {
  const frame = useRef<number | null>(null)
  const elementRef = useDividerGlow()

  const setState = (state: SeparatorState) => {
    if (elementRef.current) elementRef.current.dataset.separator = state
  }

  /** 与库一致：hover/active 期间全局锁定光标并禁选中，离开/松手恢复 */
  const setGlobalCursor = (cursor: string | null) => {
    document.body.style.cursor = cursor ?? ''
    document.body.style.userSelect = cursor ? 'none' : ''
  }

  const resizeCursor = horizontalResizeCursor()

  /** 拖拽落点规则（对齐 RRP collapsedThreshold 默认语义 = collapsedSize 与
      minSize 间距之半）：拖到下限以下先钉在下限（阻力感 —— 拒绝继续变窄），
      继续拖过 min/2 才折叠；反向对称 —— 折叠后拖出 min/2 才展开。没这段的话
      拖到下限瞬间就折，一点阻力没有。折叠落点 = collapsedWidth（0 或图标栏宽） */
  const resolve = (raw: number) => {
    if (raw < min / 2) return collapsedWidth
    if (raw < min) return min
    return Math.min(max, raw)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setState('active')
    setGlobalCursor(resizeCursor)
    const startX = event.clientX
    // 起点以实测宽度为准（折叠 = 0），不依赖任何 React 状态
    const startWidth = readWidth()
    let pendingWidth = resolve(startWidth)

    const onMove = (moveEvent: PointerEvent) => {
      pendingWidth = resolve(startWidth + moveEvent.clientX - startX)
      if (frame.current != null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        writeWidth(pendingWidth)
      })
    }
    const finish = (upEvent: PointerEvent) => {
      if (frame.current != null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
      const final = resolve(startWidth + upEvent.clientX - startX)
      // 松手同步直写，防止最后一次 rAF 被取消后宽度回跳一格
      writeWidth(final)
      cleanup()
      // 指针仍在线上则回到 hover，否则 inactive（与库状态机一致）
      const rect = elementRef.current?.getBoundingClientRect()
      const stillInside = rect && upEvent.clientX >= rect.left && upEvent.clientX <= rect.right
      setState(stillInside ? 'hover' : 'inactive')
      setGlobalCursor(null)
      onCommit(final)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const handlePointerEnter = () => {
    if (elementRef.current?.dataset.separator !== 'active') {
      setState('hover')
      setGlobalCursor(resizeCursor)
    }
  }

  const handlePointerLeave = () => {
    if (elementRef.current?.dataset.separator !== 'active') {
      setState('inactive')
      setGlobalCursor(null)
    }
  }

  /** 键盘微调（对齐库 Separator 的可操作性）：±16px；折叠态右键 = 展开到下限，
      展开态左键低于下限 = 折叠（collapsedWidth）；每次按键即提交（进状态 + 持久化） */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const current = readWidth()
    let next: number
    if (event.key === 'ArrowRight') {
      next = current <= collapsedWidth ? min : Math.min(max, current + 16)
    } else {
      next = current - 16 < min ? collapsedWidth : current - 16
    }
    writeWidth(next)
    onCommit(next)
  }

  return (
    <div
      ref={elementRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      tabIndex={0}
      data-slot="resizable-handle"
      data-separator="inactive"
      onPointerDown={handlePointerDown}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      /* 类名与 components/ui/resizable.tsx 的 Separator 逐字一致（省略库托管的
         水平/纵向变体），仅补 shrink-0 —— shadcn 形态下由库注入 */
      className="divider-glow bg-border relative flex w-px shrink-0 items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2"
      style={{ touchAction: 'none' }}
    >
      {withHandle && <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />}
    </div>
  )
}
