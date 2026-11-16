/**
 * 提示气泡（原生 title 属性的 shadcn 替代，2026-11-16 全量换装）：
 * 架构位置 = components/ 通用小件，包 tooltip 原语四件套为单组件；
 * 职责边界 = 纯呈现（hover/focus 出黑底白字气泡），文案由调用方给 ——
 * 简洁准确（名词 / 一句话，不带句号堆叠说明）。rich 内容（多行 + 交互钮）
 * 不走本件，直接用 tooltip 原语（tool.tsx 的失败原因 Tooltip 同款）。
 * 包 Provider 是 base-ui 要求（共享延迟配置）；本件自带，调用处零样板。
 * delay 400ms（2026-11-16 用户定调）：默认 0 立即弹，工具行一划过满屏闪气泡
 * —— 停留才出提示，快速划过不弹（主流产品惯例 300–500ms 取中）；
 * closeDelay 0 保持即走即收。
 */
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const HINT_DELAY_MS = 400

export function Hint({
  tip,
  children,
  side = 'top',
}: {
  /** 气泡文案：简洁准确 —— 图标钮给名词（「运行时控制台」），内容件给一句话 */
  tip: ReactNode
  children: React.ReactElement
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <TooltipProvider delay={HINT_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger render={children} />
        <TooltipContent side={side}>{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
