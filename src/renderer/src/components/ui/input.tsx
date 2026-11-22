// 普通表单保留统一轮廓；自定义外壳内的输入使用 embedded 档，避免重新叠加焦点框。
import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const inputVariants = cva(
  "h-auto min-h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-placeholder disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50",
  {
    variants: {
      variant: {
        default: "",
        embedded: "border-0 bg-transparent px-0 shadow-none dark:bg-transparent",
      },
      size: {
        default: "",
        // 工具栏与 xs 按钮共用紧凑档；数字输入不额外叠加原生步进钮。
        xs: "min-h-6 rounded-[min(var(--radius-md),10px)] px-1 py-0.5 text-xs text-center tabular-nums md:text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Input({ className, type, variant = "default", size = "default", ...props }: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-variant={variant}
      data-size={size}
      className={cn(inputVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Input }
