import * as React from "react"
import { cn } from "cn"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ChevronRightIcon } from "lucide-react"

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-md *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none",
        className
      )}
      {...props}
    />
  )
}

/* select-none：消息流容器为正文放开了 select-text（UI 方针 5），轨迹行
   （用时/工作中/思考/工具行头）是 chrome —— 行上收回选中，拖划正文
   不把这些行蓝选成片（zcode 同向：时间戳等 chrome select-none，正文用
   data-conversation-selectable 圈选区 ConversationRowView.tsx:1508/1613）。
   折叠体内容不在本行，保持可选 */
function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending"
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-2 text-sm select-none text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer",
        className
      )}
      {...props}
    />
  )
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ml-1",
        className
      )}
      {...props}
    />
  )
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-title"
      className={cn("min-w-0 truncate motion-reduce:shimmer-none", className)}
      {...props}
    />
  )
}

function TraceDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn(
        "shrink-0 text-muted-foreground/70 tabular-nums",
        className
      )}
      {...props}
    />
  )
}

function TraceCollapsible({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "open"> &
  (
    | { open?: undefined }
    | {
        open: boolean
        onOpenChange: NonNullable<
          React.ComponentProps<typeof Collapsible>["onOpenChange"]
        >
      }
  )) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      className={cn("flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  )
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "group/trace-collapsible-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left text-muted-foreground transition-colors duration-(--hover-transition-duration) outline-none hover:text-foreground has-[[data-status=error]]:text-destructive",
        className
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90">
        <ChevronRightIcon />
      </TraceIcon>
    </CollapsibleTrigger>
  )
}

function TraceCollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      /* keepMounted：收起不卸载（内容 hidden 常驻 DOM）。关闭即卸载时每次
         展开都要在点击任务里同步重挂载整棵子树（RunTrace 折叠体 = Streamdown
         解析 + Shiki 高亮 + 全部工具卡）—— 折叠卡顿主源之一（2026-11-16
         用户实测）。zcode 同问题的手法是 300ms 延迟卸载（ToolLayout.tsx:
         196-203 / reasoning.tsx:178-183，Radix 高度动画期间要保住内容高度）；
         grid 轨道开合不读内容高度，可以更进一步直接常驻：hidden 不参与
         布局不绘制，只剩 DOM 节点内存，换来展开只剩浏览器 layout+paint。
         挂载成本转移到收尾翻转（live 平铺 → 终态折叠体），那一帧本就是
         全组重渲染时刻 */
      keepMounted
      /* 开合动画 = grid 轨道 minmax(0,0fr)↔minmax(0,1fr) 过渡（fr 可插值，
         免高度测量；grid 子项必须 min-h-0 + overflow-hidden 才能被轨道
         连续裁切；间距用 padding 不用 margin —— margin 不随轨道裁切，
         收起后会残留空隙）。
         必须 minmax(0,…) 而非裸 0fr/1fr：裸 fr 带自动最小尺寸
         （minmax(auto,fr)），min-h-0 只消内容贡献、消不掉内层 padding
         （12px）——轨道收到 12px 即触地板，末段永远无动画、收尾靠
         hidden 瞬跳，即「收到 90% 卡住、剩下直接跳完」（2026-11-16
         fold-lab 逐帧采样定位，t=146ms 起高度钉死 12px 至 transitionend）。
         动画期间轨道分母 = 内容自然高度，必须**恒定**：折叠体内条目不得带
         content-visibility（渲染态翻转会中途改分母，见 TurnGroup 终态
         分支与决定 17）；zcode 同为高度过渡（300ms keyframes）且折叠体
         是纯 div，同此约束 */
      /* group/trace-collapsible：内层 padding 过渡要读本节点（面板）的开合态 */
      className="group/trace-collapsible grid min-w-0 grid-rows-[minmax(0,0fr)] transition-[grid-template-rows] duration-200 ease-out data-open:grid-rows-[minmax(0,1fr)] data-starting-style:grid-rows-[minmax(0,0fr)] data-ending-style:grid-rows-[minmax(0,0fr)] motion-reduce:transition-none"
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          /* 平级无缩进（2026-11-16 用户定调，决定 18）：不再用
             ml+border-l+pl-4 的导线缩进（23px 层级），折叠体与头条同级
             左缘 0；头条下的分隔由消费方自理（RunTrace 挂**常驻**分割线，
             在折叠机构外，收起不折）。
             live 过程流容器（TurnGroup）同步平级 —— 收尾翻折叠横向零位移
             的约束不变，只是两侧从 23px 一同归 0。zcode 的 border-l 导线
             （reasoning.tsx:457）被否。
             纵向 pt/pb **随开合同曲线过渡**（不用 mt/mb：margin 不随轨道
             裁切，收起后会残留空隙）：padding 若静态，收起尾段裁的全是
             空 padding——没有内容在折，观感"留一点高度然后 opacity 式
             消失"（2026-11-16 用户实测）；随轨道一起收拢后，尾段首行
             内容顶到裁切边被吃掉，折叠感保持到最后一像素（zcode 同病
             对照：ToolLayout.tsx:348 padding 挂动画节点上"主体归零后
             仍停在 8px"） */
          "min-h-0 min-w-0 overflow-hidden pr-1 leading-relaxed wrap-break-word text-muted-foreground transition-[padding] duration-200 ease-out group-data-open/trace-collapsible:pt-2 group-data-open/trace-collapsible:pb-1 motion-reduce:transition-none",
          className
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  )
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
}
