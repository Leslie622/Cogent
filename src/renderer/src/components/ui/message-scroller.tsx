/** 聊天滚动壳：controller 独占跟随与贴底，流内状态的根内副本只负责视觉。 */
import * as React from "react"
import { createPortal } from "react-dom"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller as usePrimitiveMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { ArrowDownIcon } from "lucide-react"

/** Provider 级跟随意图：发送、索引、按钮与流内状态的视觉副本共用。 */
type FollowingStore = {
  get: () => boolean
  subscribe: (listener: () => void) => () => void
  set: (next: boolean) => void
}

function createFollowingStore(): FollowingStore {
  let current = true
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      if (current === next) return
      current = next
      listeners.forEach((listener) => listener())
    },
  }
}

const NOOP_PIN = () => {}

type ScrollPosition = { top: number; height: number; viewportHeight: number; viewportWidth: number }
type ReadingIntent = ScrollPosition & { source: "wheel" | "keyboard" | "touch" | "scrollbar"; moved: boolean }

const ScrollerRefsContext = React.createContext<{
  contentRef: React.RefObject<HTMLDivElement | null>
  following: FollowingStore
  pin: React.RefObject<() => void>
  afterPin: Set<() => void>
  readingIntent: React.RefObject<ReadingIntent | null>
  programmaticScroll: React.RefObject<"none" | "smooth" | "interrupted">
  release: () => void
} | null>(null)

const ScrollerNodesContext = React.createContext<{
  viewport: HTMLDivElement | null
  content: HTMLDivElement | null
  setViewport: (node: HTMLDivElement | null) => void
  setContent: (node: HTMLDivElement | null) => void
} | null>(null)

/** RO 只把真实尺寸变化交给同一个 pin owner。
 * translate 只抵消贴底后的有限量化残差，不改变正文行高或阅读态定位。
 */
function useStreamingBottomPin() {
  const refs = React.useContext(ScrollerRefsContext)!
  const { viewport, content } = React.useContext(ScrollerNodesContext)!
  React.useLayoutEffect(() => {
    // null 是 DOM 撤销/尚未提交的生命周期信号；节点就绪会重新注册，而非跳过初始化。
    if (viewport === null || content === null) return
    const position = (): ScrollPosition => ({ top: viewport.scrollTop, height: viewport.scrollHeight,
      viewportHeight: viewport.clientHeight, viewportWidth: viewport.clientWidth })
    const sameLayout = (a: ScrollPosition, b: ScrollPosition): boolean =>
      a.height === b.height && a.viewportHeight === b.viewportHeight && a.viewportWidth === b.viewportWidth
    const interruptProgrammaticScroll = () => {
      if (refs.programmaticScroll.current !== "smooth") return
      refs.programmaticScroll.current = "interrupted"
      // 只中断本地API发起的旧平滑目标；capture之后浏览器仍执行本次原生输入。
      viewport.scrollTo({ top: viewport.scrollTop, behavior: "instant" })
    }
    const towardBottom = (source: ReadingIntent["source"]) => {
      if (refs.following.get()) return
      const current = position()
      // 已到底时原生输入不会再产生位移/scroll；明确向下就是主动回底。
      // 滚动条按下尚无方向，仍须等后面的真实下行位移。
      if (source !== "scrollbar" && current.height - current.top - current.viewportHeight <= 2) {
        refs.readingIntent.current = null
        refs.following.set(true)
        pin()
        return
      }
      refs.readingIntent.current = { ...current, source, moved: false }
    }
    /** 高频轻量贴底：只写显式整数目标，零测量零样式写 —— rAF 每帧调用。
     *  整数目标 ≤ maxScroll 不走浏览器钳制路径（钳制会对齐到分数设备像素
     *  网格，落点随换行漂移）；底部恒留 <1px 无感空隙换取落点确定。 */
    const pinScroll = () => {
      if (!refs.following.get()) return
      viewport.scrollTop = Math.round(viewport.scrollHeight - viewport.clientHeight)
    }
    const pin = () => {
      if (!refs.following.get()) {
        const intent = refs.readingIntent.current
        if (intent !== null && !sameLayout(intent, position())) refs.readingIntent.current = null
        return
      }
      content.style.translate = ""
      pinScroll()
      const residual = content.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom
      if (viewport.scrollHeight > viewport.clientHeight && Math.abs(residual) <= 2) {
        content.style.translate = `0 ${-residual}px`
      }
      // 装饰只在本次贴底完成后读取边沿，不能拿增长后、贴底前的源坐标判裁切。
      refs.afterPin.forEach((listener) => listener())
    }
    refs.pin.current = pin
    // rAF 驱动贴底（2026-11-18）：ResizeObserver 在 Chromium 的 paint 之后
    // 交付，RO 里写 scrollTop 慢一帧 —— 每次换行「未贴底半途位置」被 paint
    // 出来（±行高单帧跳）。rAF 在 paint 前执行，同帧完成修正（use-stick-to-bottom
    // 库 / dsh use-chat-viewport 同路线）。完整 pin（残差补偿 + 装饰通知）
    // 仍由 RO / 事件路径按需触发，高频路径不做测量。
    let raf = 0
    const frame = () => {
      pinScroll()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const onScroll = () => {
      const intent = refs.readingIntent.current
      if (intent === null || refs.following.get()) return
      const current = position()
      // RO/终态折叠改变的滚动范围不算用户回底，旧程序scroll也没有输入资格。
      if (!sameLayout(intent, current)) {
        refs.readingIntent.current = null
        return
      }
      const toward = current.top > intent.top
      refs.readingIntent.current = { ...current, source: intent.source, moved: intent.moved || toward }
      if (toward && current.height - current.top - current.viewportHeight <= 2) {
        refs.readingIntent.current = null
        refs.following.set(true)
        pin()
      }
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      interruptProgrammaticScroll()
      if (event.deltaY < 0) refs.release()
      else towardBottom("wheel")
    }
    let scrollbarActive = false
    const onPointerDown = (event: PointerEvent) => {
      // 只在原生滚动条轨道交还阅读权，正文点击不改变跟随。
      const bounds = viewport.getBoundingClientRect()
      if (event.clientX >= bounds.left + viewport.clientWidth) {
        interruptProgrammaticScroll()
        refs.release()
        scrollbarActive = true
        towardBottom("scrollbar")
      }
    }
    const onPointerUp = () => {
      if (!scrollbarActive) return
      onScroll()
      scrollbarActive = false
      if (refs.readingIntent.current?.source === "scrollbar") refs.readingIntent.current = null
    }
    const onPointerMove = () => {
      if (scrollbarActive) towardBottom("scrollbar")
    }
    const onPointerCancel = () => {
      scrollbarActive = false
      if (refs.readingIntent.current?.source === "scrollbar") refs.readingIntent.current = null
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== viewport) return
      const away = ["PageUp", "Home", "ArrowUp"].includes(event.key) || (event.key === " " && event.shiftKey)
      const toward = ["PageDown", "End", "ArrowDown"].includes(event.key) || (event.key === " " && !event.shiftKey)
      if (!away && !toward) return
      interruptProgrammaticScroll()
      if (away) refs.release()
      else towardBottom("keyboard")
    }
    let touchY: number | null = null
    const onTouchStart = (event: TouchEvent) => {
      interruptProgrammaticScroll()
      refs.release()
      touchY = event.touches[0].clientY
    }
    const onTouchMove = (event: TouchEvent) => {
      const previousY = touchY
      touchY = event.touches[0].clientY
      if (previousY === null) return
      if (touchY > previousY) refs.release()
      else if (touchY < previousY) towardBottom("touch")
    }
    const onTouchEnd = () => { touchY = null }
    const onTouchCancel = () => {
      touchY = null
      if (refs.readingIntent.current?.source === "touch") refs.readingIntent.current = null
    }
    const onScrollEnd = () => {
      // 旧程序平滑被截停后可能迟到一个scrollend，不能撤销新登记的原生手势。
      if (refs.programmaticScroll.current !== "none") {
        refs.programmaticScroll.current = "none"
        return
      }
      const intent = refs.readingIntent.current
      if (intent !== null && intent.moved && !(intent.source === "scrollbar" && scrollbarActive)) {
        refs.readingIntent.current = null
      }
    }
    const observer = new ResizeObserver(pin)
    observer.observe(content)
    observer.observe(viewport)
    viewport.addEventListener("scroll", onScroll, { passive: true })
    viewport.addEventListener("wheel", onWheel, { passive: true, capture: true })
    viewport.addEventListener("touchstart", onTouchStart, { passive: true, capture: true })
    viewport.addEventListener("touchmove", onTouchMove, { passive: true, capture: true })
    viewport.addEventListener("touchend", onTouchEnd, { passive: true, capture: true })
    viewport.addEventListener("touchcancel", onTouchCancel, { passive: true, capture: true })
    viewport.addEventListener("keydown", onKeyDown, true)
    viewport.addEventListener("pointerdown", onPointerDown, true)
    viewport.addEventListener("scrollend", onScrollEnd, { passive: true })
    window.addEventListener("pointerup", onPointerUp, true)
    window.addEventListener("pointermove", onPointerMove, true)
    window.addEventListener("pointercancel", onPointerCancel, true)
    pin()
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      if (refs.pin.current === pin) {
        refs.pin.current = NOOP_PIN
        refs.readingIntent.current = null
        refs.programmaticScroll.current = "none"
      }
      content.style.translate = ""
      viewport.removeEventListener("scroll", onScroll)
      viewport.removeEventListener("wheel", onWheel, true)
      viewport.removeEventListener("touchstart", onTouchStart, true)
      viewport.removeEventListener("touchmove", onTouchMove, true)
      viewport.removeEventListener("touchend", onTouchEnd, true)
      viewport.removeEventListener("touchcancel", onTouchCancel, true)
      viewport.removeEventListener("keydown", onKeyDown, true)
      viewport.removeEventListener("pointerdown", onPointerDown, true)
      viewport.removeEventListener("scrollend", onScrollEnd)
      window.removeEventListener("pointerup", onPointerUp, true)
      window.removeEventListener("pointermove", onPointerMove, true)
      window.removeEventListener("pointercancel", onPointerCancel, true)
    }
  }, [refs, viewport, content])
}

function MessageScrollerProvider({ children, ...props }: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>) {
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const [viewport, updateViewport] = React.useState<HTMLDivElement | null>(null)
  const [content, updateContent] = React.useState<HTMLDivElement | null>(null)
  const [following] = React.useState(createFollowingStore)
  const pin = React.useRef<() => void>(NOOP_PIN)
  const readingIntent = React.useRef<ReadingIntent | null>(null)
  const programmaticScroll = React.useRef<"none" | "smooth" | "interrupted">("none")
  const [afterPin] = React.useState(() => new Set<() => void>())
  // 稳定 ref 避免普通父更新产生 detach；状态通知消费者处理真正的卸载和节点替换。
  const setViewport = React.useCallback((node: HTMLDivElement | null) => {
    updateViewport(node)
  }, [])
  const setContent = React.useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node
    updateContent(node)
  }, [])
  const nodes = React.useMemo(() => ({ viewport, content, setViewport, setContent }), [viewport, content, setViewport, setContent])
  const refs = React.useMemo(() => ({
    contentRef,
    following,
    pin,
    afterPin,
    readingIntent,
    programmaticScroll,
    release: () => {
      readingIntent.current = null
      following.set(false)
      const currentContent = contentRef.current
      // DOM detach 是合法生命周期边界；下一节点代次会由 pin effect 接管。
      if (currentContent !== null) currentContent.style.translate = ""
    },
  }), [following, afterPin])
  return <ScrollerRefsContext.Provider value={refs}>
    <ScrollerNodesContext.Provider value={nodes}>
      <MessageScrollerPrimitive.Provider {...props} autoScroll={false}>{children}</MessageScrollerPrimitive.Provider>
    </ScrollerNodesContext.Provider>
  </ScrollerRefsContext.Provider>
}

/** 订阅 Provider 级跟随意图，不决定流内业务状态是否存在。 */
function useMessageScrollerFollowing(): boolean {
  const refs = React.useContext(ScrollerRefsContext)!
  return React.useSyncExternalStore(refs.following.subscribe, refs.following.get, refs.following.get)
}

/** 流内源保留布局与唯一读屏文本；仅溢出跟随时把同一视觉内容画到根内。
 * 副本以 viewport 下缘与源的尾部间距定位，持续 delta 不复制源的小数 y。
 * 本组件不写 scrollTop；节点代次、真实尺寸和主题变化才重测装饰几何。
 */
function MessageScrollerDecoration({ children }: { children: React.ReactNode }) {
  const refs = React.useContext(ScrollerRefsContext)!
  const { viewport, content } = React.useContext(ScrollerNodesContext)!
  const [source, setSource] = React.useState<HTMLDivElement | null>(null)
  const [decoration, setDecoration] = React.useState<{ root: HTMLElement; style: React.CSSProperties } | null>(null)

  React.useLayoutEffect(() => {
    if (viewport === null || content === null || source === null) return
    // Root 不合并外传 ref；从同代 viewport 找根，保留库自己的节点登记。
    const root = viewport.closest<HTMLElement>('[data-slot="message-scroller"]')!
    let active = false
    let previousInset = 0
    const hide = () => {
      source.style.opacity = ""
      if (!active) return
      active = false
      setDecoration(null)
    }
    const sync = (remeasure = false) => {
      if (!refs.following.get() || viewport.scrollHeight <= viewport.clientHeight) {
        hide()
        return
      }
      const sourceBox = source.getBoundingClientRect()
      const viewportBox = viewport.getBoundingClientRect()
      if (sourceBox.height === 0 || sourceBox.top < viewportBox.top || sourceBox.bottom > viewportBox.bottom) {
        hide()
        return
      }
      const inset = content.getBoundingClientRect().bottom - sourceBox.bottom
      // 正文与源共同平移时尾距不变；仅尾项改变尾距才重定位，忽略小于布局单位的浮点误差。
      // 检查裁切放在 pin 后，但绝不把每批 source 的小数 y 直接抄给副本。
      if (active && !remeasure && Math.abs(inset - previousInset) < 1 / 64) return
      previousInset = inset
      const rootBox = root.getBoundingClientRect()
      const computed = getComputedStyle(source)
      const variables = Object.fromEntries(Array.from(computed)
        .filter((name) => name.startsWith('--'))
        .map((name) => [name, computed.getPropertyValue(name)]))
      const style: React.CSSProperties = {
        ...variables,
        left: sourceBox.left - rootBox.left - root.clientLeft,
        top: viewportBox.bottom - rootBox.top - root.clientTop - inset - sourceBox.height,
        width: sourceBox.width,
        color: computed.color,
        font: computed.font,
        lineHeight: computed.lineHeight,
      }
      active = true
      source.style.opacity = "0"
      setDecoration({ root, style })
    }
    const afterPin = () => sync()
    const onSize = () => sync(true)
    const observer = new ResizeObserver(onSize)
    observer.observe(root)
    observer.observe(viewport)
    observer.observe(source)
    const unsubscribe = refs.following.subscribe(afterPin)
    refs.afterPin.add(afterPin)

    // 只观察祖先的主题属性；pin 写入 translate 不能触发每批正文重测。
    const ancestors: HTMLElement[] = []
    for (let node = source.parentElement; node !== null; node = node.parentElement) ancestors.push(node)
    const themeKey = () => ancestors.map((node) => `${node.className}|${Array.from(node.style)
      .filter((name) => name !== 'translate')
      .map((name) => `${name}:${node.style.getPropertyValue(name)}`).join(';')}`).join('\n')
    let previousTheme = themeKey()
    const themes = new MutationObserver(() => {
      const nextTheme = themeKey()
      if (nextTheme === previousTheme) return
      previousTheme = nextTheme
      sync(true)
    })
    ancestors.forEach((node) => themes.observe(node, { attributes: true, attributeFilter: ['class', 'style'] }))
    sync()
    return () => {
      unsubscribe()
      refs.afterPin.delete(afterPin)
      observer.disconnect()
      themes.disconnect()
      source.style.opacity = ""
      setDecoration(null)
    }
  }, [refs, viewport, content, source])

  return <>
    <div ref={setSource} data-slot="message-scroller-decoration-source">{children}</div>
    {decoration !== null && createPortal(
      <div data-slot="message-scroller-decoration" aria-hidden="true"
        className="pointer-events-none absolute" style={decoration.style}>{children}</div>, decoration.root
    )}
  </>
}

function useMessageScroller() {
  const primitive = usePrimitiveMessageScroller()
  const refs = React.useContext(ScrollerRefsContext)!
  return React.useMemo(() => ({
    scrollToEnd: () => {
      refs.readingIntent.current = null
      refs.programmaticScroll.current = "none"
      refs.following.set(true)
      // 库清除定位 spacer；实际跟随与残差仍只由 pin controller 接管。
      const result = primitive.scrollToEnd({ behavior: "instant" })
      refs.pin.current()
      return result
    },
    scrollToMessage: (...args: Parameters<typeof primitive.scrollToMessage>) => {
      refs.release()
      const result = primitive.scrollToMessage(...args)
      refs.programmaticScroll.current = result && args[1]?.behavior === "smooth" ? "smooth" : "none"
      return result
    },
    scrollToStart: (...args: Parameters<typeof primitive.scrollToStart>) => {
      refs.release()
      const result = primitive.scrollToStart(...args)
      refs.programmaticScroll.current = result && args[0]?.behavior === "smooth" ? "smooth" : "none"
      return result
    },
  }), [primitive, refs])
}

function MessageScroller({ className, ...props }: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  useStreamingBottomPin()
  return <MessageScrollerPrimitive.Root data-slot="message-scroller"
    className={cn("group/message-scroller relative flex min-h-0 w-full flex-1 flex-col overflow-hidden", className)} {...props} />
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  const nodes = React.useContext(ScrollerNodesContext)!
  return (
    <MessageScrollerPrimitive.Viewport
      ref={nodes.setViewport}
      data-slot="message-scroller-viewport"
      className={cn(
        // overflow-anchor:none（2026-11-18）：Chromium scroll anchoring 会在内容
        // 增长时以任意小数微调 scrollTop 补偿锚点，与显式贴底目标打架（落点
        // 二态的加成项）；dsh use-chat-viewport 同款处理
        "min-h-0 min-w-0 flex-1 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content [overflow-anchor:none] data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent data-pending-scroll:invisible",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  const nodes = React.useContext(ScrollerNodesContext)!
  return (
    <MessageScrollerPrimitive.Content
      ref={nodes.setContent}
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        "min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  render,
  variant = "secondary",
  size = "icon-sm",
  onClick,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  const controller = useMessageScroller()
  return (
    <MessageScrollerPrimitive.Button
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        event.preventDefault()
        if (direction === "end") controller.scrollToEnd()
        else controller.scrollToStart()
      }}
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        "absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  MessageScrollerDecoration,
  useMessageScroller,
  useMessageScrollerFollowing,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
