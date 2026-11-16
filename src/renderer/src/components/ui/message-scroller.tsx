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

/**
 * 流式吸底的预绘制同步（库 autoScroll 的补帧，docs/计划/对话过程呈现打磨.md
 * §3.4 后续实测）：库的跟随链路是 ResizeObserver → rAF 下一帧 → scrollTo
 * —— 内容增长的那一帧先绘制"滚动未跟上"的中间态（流底内容下探），下一帧
 * 才弹回底部，逐 delta 高频触发即观感"工作中行闪动"。本钩子把修正搬进 RO
 * 回调内（浏览器在布局后、绘制前回调 RO），增长当帧直接 scrollTop 贴底，
 * 中间态不上屏。跟随判定 = 增长前是否贴底（scroll 事件持续记账，2px 容差
 * 同库的 J 常量）：用户上翻即停止跟随，库的 rAF 补帧与本钩子不冲突（其后
 * 变为空转）。
 */
function useStreamingBottomPin(viewportRef: React.RefObject<HTMLDivElement | null>) {
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null || typeof ResizeObserver === "undefined") return
    // 增长前的贴底记账：用户滚离底部（含程序化 scrollToMessage）即 false
    let atBottom = true
    const onScroll = () => {
      atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2
    }
    const observer = new ResizeObserver(() => {
      if (atBottom) {
        viewport.scrollTop = viewport.scrollHeight
        atBottom = true // 贴底后距离恒 0，scroll 事件会再确认
      } else {
        onScroll()
      }
    })
    observer.observe(viewport)
    viewport.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      observer.disconnect()
      viewport.removeEventListener("scroll", onScroll)
    }
  }, [viewportRef])
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
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  useStreamingBottomPin(viewportRef)
  return (
    <MessageScrollerPrimitive.Viewport
      ref={(node) => {
        viewportRef.current = node
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
  return (
    <MessageScrollerPrimitive.Content
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
