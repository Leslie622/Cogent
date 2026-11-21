/** 折叠原语：导航变体统一承载列表过渡，其他消费方保持各自的呈现。 */
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import { cn } from "cn"

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  )
}

/** 导航列表常驻以保留嵌套项目状态；起步态只用于恢复显示，反向开合从当前高度续接。 */
function CollapsibleContent({
  variant = "default",
  className,
  children,
  ...props
}: CollapsiblePrimitive.Panel.Props & { variant?: "default" | "navigation" }) {
  const navigation = variant === "navigation"
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      keepMounted={navigation}
      className={navigation ? cn(
        "grid min-w-0 grid-rows-[minmax(0,0fr)] transition-[grid-template-rows] duration-200 ease-out data-open:grid-rows-[minmax(0,1fr)] data-starting-style:starting:grid-rows-[minmax(0,0fr)] data-ending-style:grid-rows-[minmax(0,0fr)] motion-reduce:transition-none",
        className
      ) : className}
      {...props}
    >
      {navigation ? (
        <div className="min-h-0 min-w-0 overflow-hidden">
          {/* 裁剪层不做 flex 容器，避免收拢轨道压缩行高；间距随完整列表一起被裁。 */}
          <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
            {children}
          </div>
        </div>
      ) : children}
    </CollapsiblePrimitive.Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
