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

/** 导航列表常驻以保留嵌套项目状态；开合由原语管理，过渡只负责呈现。 */
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
        "grid min-w-0 grid-rows-[minmax(0,0fr)] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-out data-open:grid-rows-[minmax(0,1fr)] data-open:opacity-100 data-starting-style:grid-rows-[minmax(0,0fr)] data-starting-style:opacity-0 data-ending-style:grid-rows-[minmax(0,0fr)] data-ending-style:opacity-0 motion-reduce:transition-none",
        "[&>div]:transition-[padding] [&>div]:duration-200 [&>div]:ease-out data-open:[&>div]:pt-0.5 data-starting-style:[&>div]:pt-0 data-ending-style:[&>div]:pt-0 motion-reduce:[&>div]:transition-none",
        className
      ) : className}
      {...props}
    >
      {navigation ? (
        <div className="flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden">
          {children}
        </div>
      ) : children}
    </CollapsiblePrimitive.Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
