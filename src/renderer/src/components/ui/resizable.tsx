"use client"

import { useLayoutEffect, useState } from "react"
import { cn } from "cn"
import * as ResizablePrimitive from "react-resizable-panels"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  /* 过渡放行门控：挂载首帧 RRP 先渲染 flexBasis 兜底尺寸、注册布局后切换到
     flexGrow 驱动 —— 若过渡常开，这次属性交接会在每次挂载时放一段
     0 → 目标宽的生长动画。等两轮宏任务再放行（React 副 effect 与调度器刷新
     都先于定时器跑完，布局必然已落定）。不用 rAF：页面不可见时 rAF 停发，
     门控会永远卡死（过渡整体失效）。 */
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    let timer2 = 0
    const timer1 = setTimeout(() => {
      timer2 = setTimeout(() => setReady(true), 0)
    }, 0)
    return () => {
      clearTimeout(timer1)
      clearTimeout(timer2)
    }
  }, [])

  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        /* 折叠/展开过渡：RRP 布局注册后用内联 flexGrow 承载面板尺寸（flexBasis
           恒 0、仅挂载兜底用，过渡它不动 —— 踩过），对 flex-grow 做 CSS 过渡即得
           平滑收放。拖拽期间必须杀掉：RRP 逐帧写 flexGrow，200ms 缓动会把跟手
           拖成延迟；库在真实拖拽时把把手置 data-separator=active（权威状态，
           同 use-divider-glow 的观察源），:has() 命中即过渡失效 */
        ready &&
          "[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-200 [&>[data-panel]]:ease-out",
        "[&:has([data-separator=active])>[data-panel]]:transition-none",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
