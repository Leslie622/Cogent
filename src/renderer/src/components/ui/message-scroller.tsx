/** 聊天滚动壳：controller 独占跟随与贴底，工作行单节点按跟随意图切换定位。 */
import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller as usePrimitiveMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { ArrowDownIcon } from "lucide-react"

/** Provider 级跟随意图：发送、索引和回底按钮共用。 */
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
  following: FollowingStore
  pin: React.RefObject<() => void>
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
 * 不用平移抵消小数坐标：几何归零可能反而破坏图标像素稳定，见 docs/技术笔记/流式呈现动效.md。
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
    const pin = () => {
      if (!refs.following.get()) {
        const intent = refs.readingIntent.current
        if (intent !== null && !sameLayout(intent, position())) refs.readingIntent.current = null
        return
      }
      viewport.scrollTop = viewport.scrollHeight
    }
    refs.pin.current = pin
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
      observer.disconnect()
      if (refs.pin.current === pin) {
        refs.pin.current = NOOP_PIN
        refs.readingIntent.current = null
        refs.programmaticScroll.current = "none"
      }
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
  const [viewport, updateViewport] = React.useState<HTMLDivElement | null>(null)
  const [content, updateContent] = React.useState<HTMLDivElement | null>(null)
  const [following] = React.useState(createFollowingStore)
  const pin = React.useRef<() => void>(NOOP_PIN)
  const readingIntent = React.useRef<ReadingIntent | null>(null)
  const programmaticScroll = React.useRef<"none" | "smooth" | "interrupted">("none")
  // 稳定 ref 避免普通父更新产生 detach；状态通知消费者处理真正的卸载和节点替换。
  const setViewport = React.useCallback((node: HTMLDivElement | null) => {
    updateViewport(node)
  }, [])
  const setContent = React.useCallback((node: HTMLDivElement | null) => {
    updateContent(node)
  }, [])
  const nodes = React.useMemo(() => ({ viewport, content, setViewport, setContent }), [viewport, content, setViewport, setContent])
  const refs = React.useMemo(() => ({
    following,
    pin,
    readingIntent,
    programmaticScroll,
    release: () => {
      readingIntent.current = null
      following.set(false)
    },
  }), [following])
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

/** 保留同一个状态节点和流内高度；仅跟随溢出内容时脱离滚动绘制坐标。
 * fixed 的位置由视口与内容尾距决定，不复制源的小数 y，也不接管 scrollTop。
 */
function MessageScrollerPinnedRow({ children }: { children: React.ReactNode }) {
  const refs = React.useContext(ScrollerRefsContext)!
  const { viewport, content } = React.useContext(ScrollerNodesContext)!
  const slotRef = React.useRef<HTMLDivElement>(null)
  const originRef = React.useRef<HTMLDivElement>(null)
  const rowRef = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    if (viewport === null || content === null) return
    const slot = slotRef.current!
    const row = rowRef.current!
    let previous: { top: number; left: number; width: number; height: number } | null = null
    const release = () => {
      previous = null
      slot.style.height = ""
      row.style.position = ""
      row.style.top = ""
      row.style.left = ""
      row.style.width = ""
    }
    const sync = () => {
      if (!refs.following.get() || viewport.scrollHeight <= viewport.clientHeight) {
        release()
        return
      }
      const slotBox = slot.getBoundingClientRect()
      const viewportBox = viewport.getBoundingClientRect()
      const height = row.getBoundingClientRect().height
      // 两个边沿同属内容坐标，贴底前后尾距不变；RO先后顺序不会把中间态抄给工作行。
      const inset = content.getBoundingClientRect().bottom - slotBox.bottom
      const top = viewportBox.bottom - inset - height
      if (height === 0 || top < viewportBox.top || top + height > viewportBox.bottom) {
        release()
        return
      }
      // Electron 31 的 inline-size 查询容器会成为 fixed 包含块；rect 是窗口坐标，
      // top/left 却相对此包含块。用同级零尺寸锚点测原点，避免聊天面板偏移被重复加算。
      const origin = originRef.current!.getBoundingClientRect()
      const fixedTop = top - origin.top
      const fixedLeft = slotBox.left - origin.left
      // 尾距相减有浮点噪声；同一落点不能因万分之一像素误差跨过绘制舍入边界。
      if (previous !== null && Math.abs(fixedTop - previous.top) < 1 / 64 &&
        Math.abs(fixedLeft - previous.left) < 1 / 64 &&
        Math.abs(slotBox.width - previous.width) < 1 / 64 && Math.abs(height - previous.height) < 1 / 64) return
      previous = { top: fixedTop, left: fixedLeft, width: slotBox.width, height }
      slot.style.height = `${height}px`
      row.style.position = "fixed"
      row.style.top = `${fixedTop}px`
      row.style.left = `${fixedLeft}px`
      row.style.width = `${slotBox.width}px`
    }
    const observer = new ResizeObserver(sync)
    observer.observe(viewport)
    observer.observe(content)
    observer.observe(row)
    observer.observe(slot)
    const unsubscribe = refs.following.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      observer.disconnect()
      release()
    }
  }, [refs, viewport, content])
  return <div ref={slotRef} data-slot="message-scroller-row-slot">
    <div ref={originRef} data-slot="message-scroller-fixed-origin" aria-hidden="true" className="pointer-events-none fixed left-0 top-0 size-0" />
    <div ref={rowRef} data-slot="message-scroller-pinned-row">{children}</div>
  </div>
}

function useMessageScroller() {
  const primitive = usePrimitiveMessageScroller()
  const refs = React.useContext(ScrollerRefsContext)!
  return React.useMemo(() => ({
    scrollToEnd: () => {
      refs.readingIntent.current = null
      refs.programmaticScroll.current = "none"
      refs.following.set(true)
      // 库清除定位 spacer；实际跟随仍只由 pin controller 接管。
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

// 视口不设 containment：与小数滚动组合会引起工作行像素跳动，见 docs/技术笔记/流式呈现动效.md。
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
        "min-h-0 min-w-0 flex-1 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent data-pending-scroll:invisible",
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
        "absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity,outline-color] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
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
  MessageScrollerPinnedRow,
  useMessageScroller,
  useMessageScrollerFollowing,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
