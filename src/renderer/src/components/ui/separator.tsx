import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "cn"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      // 坑（registry 随附即坏，与 tabs.tsx 同根）：base-ui 只设 data-orientation，
      // 裸 data-horizontal:/data-vertical: 变体编译成 [data-horizontal] 存在式
      // 选择器永远不匹配（细线曾因此无尺寸不可见）—— 显式渲染属性 + 值匹配
      data-orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
