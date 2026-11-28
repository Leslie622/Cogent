/** Nova Tabs；工作区档为带同级关闭按钮的标签项，默认设置页形态保持独立。 */
import { useRef, type ComponentProps } from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { useHorizontalScrollFade } from "@/hooks/use-horizontal-scroll-fade"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      // 坑（registry 随附即坏）：base-ui 只设 data-orientation，裸
      // data-horizontal:/data-vertical: 变体编译成 [data-horizontal] 存在式
      // 选择器永远不匹配（2026-11-15 MCP 弹窗 Tabs 渲染成左右分栏实测）——
      // 下方全部 data-[orientation=*] 显式值匹配
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
        workspace: "scroll-fade-x scroll-fade-edges w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden group-data-[orientation=horizontal]/tabs:h-full",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ref,
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  const viewport = useRef<HTMLDivElement>(null)
  useHorizontalScrollFade(viewport, variant === "workspace", children)
  return useRender({
    render: <TabsPrimitive.List {...props} />,
    ref: [viewport, ref ?? null],
    props: {
      "data-slot": "tabs-list",
      "data-variant": variant,
      className: cn(tabsListVariants({ variant }), className),
      children,
    },
  })
}

function TabsTrigger({ className, variant = "default", ...props }: TabsPrimitive.Tab.Props & { variant?: "default" | "workspace" }) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        variant === "workspace" ? "relative inline-flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm font-normal outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4" : [
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all duration-(--hover-transition-duration) group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        ],
        className
      )}
      {...props}
    />
  )
}

/** 关闭钮与 Tab 同级，避免按钮嵌套；整项共同显示激活底色。 */
function TabsItem({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="tabs-item" className={cn("group flex h-8 w-44 shrink-0 items-center rounded-lg text-muted-foreground transition-colors duration-(--hover-transition-duration) hover:bg-muted/60 has-data-active:bg-muted has-data-active:text-foreground", className)} {...props} />
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsItem, TabsContent, tabsListVariants }
