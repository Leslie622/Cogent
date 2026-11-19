/** shadcn Nova 组合框：保留弹层搜索所用的原生部件。 */
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { cn } from "cn"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { InputGroup, InputGroupInput } from "@/components/ui/input-group"

const Combobox = ComboboxPrimitive.Root
const ComboboxStatus = ComboboxPrimitive.Status

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn("[&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      {children}
      <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
    </ComboboxPrimitive.Trigger>
  )
}

function ComboboxInput(props: ComboboxPrimitive.Input.Props) {
  return (
    <InputGroup className="w-auto">
      <ComboboxPrimitive.Input render={<InputGroupInput />} {...props} />
    </InputGroup>
  )
}

function ComboboxContent({
  className,
  align = "start",
  ...props
}: ComboboxPrimitive.Popup.Props & Pick<ComboboxPrimitive.Positioner.Props, "align">) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner sideOffset={6} align={align} className="isolate z-50">
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "group/combobox-content relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-[calc(var(--anchor-width)+--spacing(7))] origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 *:data-[slot=input-group]:m-1 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-8 *:data-[slot=input-group]:border-input/30 *:data-[slot=input-group]:bg-input/30 *:data-[slot=input-group]:shadow-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("no-scrollbar max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0", className)}
      {...props}
    />
  )
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn("relative flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50", className)}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />}
      >
        <CheckIcon className="size-4" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxEmpty(props: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className="hidden w-full justify-center py-2 text-center text-sm text-muted-foreground group-data-empty/combobox-content:flex"
      {...props}
    />
  )
}

export { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxStatus, ComboboxTrigger }
