/** Nova 单选原语；预览卡形态在本体定义，调用处只提供预览内容与布局。 */
import type { ReactNode } from 'react'
import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cn } from "cn"

function RadioGroup<Value>({ className, ...props }: RadioGroupPrimitive.Props<Value>) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-2", className)}
      {...props}
    />
  )
}

function RadioGroupItem<Value>({ className, ...props }: RadioPrimitive.Root.Props<Value>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input outline-none after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="flex size-4 items-center justify-center"
      >
        <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  )
}

function RadioGroupCard<Value>({
  label, children, className, ...props
}: Omit<RadioPrimitive.Root.Props<Value>, 'children'> & { label: string; children: ReactNode }) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-card"
      aria-label={label}
      className={cn('group/visual-radio relative flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg text-center text-sm disabled:pointer-events-none disabled:opacity-50', className)}
      {...props}
    >
      <span
        data-slot="radio-card-preview"
        aria-hidden="true"
        className="relative block w-full overflow-hidden rounded-lg border border-border transition-[border-color,box-shadow] duration-150 group-hover/visual-radio:border-(--visual-radio-color) group-data-checked/visual-radio:border-(--visual-radio-color) group-data-checked/visual-radio:shadow-[0_0_0_1px_var(--visual-radio-color)] motion-reduce:transition-none"
      >
        {children}
        <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full border border-foreground/20 bg-background group-data-checked/visual-radio:border-(--visual-radio-color) group-data-checked/visual-radio:bg-(--visual-radio-color)">
          <RadioPrimitive.Indicator className="size-1.5 rounded-full bg-background" />
        </span>
      </span>
      <span className="text-muted-foreground group-data-checked/visual-radio:font-semibold group-data-checked/visual-radio:text-foreground">{label}</span>
    </RadioPrimitive.Root>
  )
}

export { RadioGroup, RadioGroupItem, RadioGroupCard }
