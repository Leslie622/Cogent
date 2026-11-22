/** 工具栏与顶栏统一使用现有按钮、提示组件的原生变体。 */
import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function IconButton({ label, children, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return <Tooltip>
    <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={label} {...props} />}>
      {children}
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
}
