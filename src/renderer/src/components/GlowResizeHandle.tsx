/**
 * 带拖拽光带的 shadcn ResizableHandle：按住拖动时线上有一段跟随指针的强调色
 * 光带，扫过中央把手时把手同步染色（高光逻辑在 hooks/use-divider-glow，
 * 样式在 globals.css 的 .divider-glow 规则）。
 */
import type { ComponentProps } from 'react'
import { cn } from 'cn'
import { ResizableHandle } from '@/components/ui/resizable'
import { useDividerGlow } from '@/hooks/use-divider-glow'

export function GlowResizeHandle({ className, ...props }: ComponentProps<typeof ResizableHandle>) {
  return (
    <ResizableHandle
      {...props}
      elementRef={useDividerGlow()}
      className={cn('divider-glow', className)}
    />
  )
}
