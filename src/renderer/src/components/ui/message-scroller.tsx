import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { ArrowDownIcon } from "lucide-react"

/** Root/Viewport/Content 三层间的 ref 共享（useStreamingBottomPin 接线用） */
const ScrollerRefsContext = React.createContext<{
  viewportRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
} | null>(null)

/**
 * 流式吸底（唯一跟随源）：贴底必须在"引起增长的那个渲染帧"内完成 ——
 * 内容长 N px 而滚动未跟的帧会先把中间态绘制上屏（流底内容下探 N px），
 * 下一帧弹回，逐 delta 高频往复即"工作中行上下抖动"。真机 CDP 逐帧采样
 * （真机数据为本注释依据）：库 autoScroll 的 RO→rAF→scrollTo 慢一帧；而
 * **ResizeObserver 的交付在 paint 之后**（旧版以为"布局后绘制前"），RO 回调
 * 里贴底同样晚一帧、中间态照样上屏。所以主贴底走 **MutationObserver 微任务**：
 * React commit 改完 DOM 的微任务检查点同步执行，读 scrollHeight（强制同步
 * 布局拿到新值）后立即赋 scrollTop —— 布局/绘制发生时滚动已就位，中间态
 * 不上屏。RO 留作兜底（不经 DOM 变化的纯高度变化，幂等）。
 * atBottom 记账是**用户意图驱动**，不是位置反推：旧版"scroll 事件按 2px 容差
 * 判定"会被程序滚动击穿 —— 贴底（scrollTop=scrollHeight）触发的 scroll 事件
 * 异步派发时内容又长了几 px，dist>2px 即误判"用户滚走"，一次性击穿后钩子
 * 永久退出、抖动回归（真机采样实锤：RO 时刻 dist 从 0.8 一路涨到 1000+）。
 * 现只有用户输入（滚轮/触摸/滚动键）产生的滚动才改记账；程序向上滚
 * （scrollToMessage 锚点定位 = 显式离开底部）同样灭跟随；程序向下滚
 * （贴底/scrollToEnd）不动记账。
 */
function useStreamingBottomPin(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  contentRef: React.RefObject<HTMLDivElement | null>
) {
  React.useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (viewport === null || content === null) return
    let atBottom = true
    let userDriven = false
    let lastTop = viewport.scrollTop
    const SCROLL_KEYS = new Set([
      "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " ",
    ])
    const markUser = () => {
      userDriven = true
    }
    const onScroll = () => {
      const dist = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const went = viewport.scrollTop - lastTop
      lastTop = viewport.scrollTop
      // 程序向上滚 = scrollToMessage 类显式离开；小幅回缩（边界回弹）忽略
      const programLeave = !userDriven && went < -8
      if (userDriven || programLeave) {
        atBottom = dist <= 2
        // 用户滚回底部 = 回到跟随态；programLeave 保持离开直到用户/显式回底
        if (atBottom) userDriven = false
      }
    }
    const pinToBottom = () => {
      if (atBottom) viewport.scrollTop = viewport.scrollHeight
    }
    const mutations = new MutationObserver(pinToBottom)
    mutations.observe(content, { childList: true, subtree: true, characterData: true })
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            pinToBottom()
            // 不跟随时刷新基准：防把后续程序贴底误判成基准跳变
            lastTop = viewport.scrollTop
          })
    observer?.observe(content)
    viewport.addEventListener("scroll", onScroll, { passive: true })
    viewport.addEventListener("wheel", markUser, { passive: true, capture: true })
    viewport.addEventListener("touchstart", markUser, { passive: true, capture: true })
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) markUser()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      mutations.disconnect()
      observer?.disconnect()
      viewport.removeEventListener("scroll", onScroll)
      viewport.removeEventListener("wheel", markUser, { capture: true })
      viewport.removeEventListener("touchstart", markUser, { capture: true })
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [viewportRef, contentRef])
}

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  // viewport/content ref 在根组件创建（Root/Viewport/Content 三层的公共祖先），
  // 经 context 下发 —— 兄弟组件（Viewport/Content）间传递，多实例互不串扰
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  useStreamingBottomPin(viewportRef, contentRef)
  return (
    <ScrollerRefsContext.Provider value={{ viewportRef, contentRef }}>
      <MessageScrollerPrimitive.Root
        data-slot="message-scroller"
        className={cn(
          "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
          className
        )}
        {...props}
      />
    </ScrollerRefsContext.Provider>
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  const refs = React.useContext(ScrollerRefsContext)
  return (
    <MessageScrollerPrimitive.Viewport
      ref={(node) => {
        if (refs) refs.viewportRef.current = node
      }}
      data-slot="message-scroller-viewport"
      className={cn(
        "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent data-pending-scroll:invisible",
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
  const refs = React.useContext(ScrollerRefsContext)
  return (
    <MessageScrollerPrimitive.Content
      ref={(node) => {
        if (refs) refs.contentRef.current = node
      }}
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
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <MessageScrollerPrimitive.Button
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
          <ArrowDownIcon
          />
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
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
