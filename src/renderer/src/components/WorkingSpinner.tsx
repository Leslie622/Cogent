/**
 * 工作行三叶 spinner（WorkingLine 图标槽的**动效座**，2026-11-18 定调）：
 * css-loaders l5 原版动画逐字保留（样式与 keyframes 全在 globals.css 的
 * .working-spinner 块：整盒三角 + ::before/::after 继承、4s/2s、转轴
 * 66%），产品化只做了颜色（前景近黑，shadcn 黑白系）与尺寸（1em 派生，
 * text-xs，2026-11-20 用户定调比行内正文小一号）。呼吸/分相/转轴实验系全数被否回退，缘由见 CSS 块注释。
 * **换新动效的约定**：只替换本文件 + globals.css 对应块，WorkingLine /
 * TraceIcon 接线不动 —— 历史候选（ClockIcon / 双弧 / blur 光环 / zcode
 * 粒子球·变C / blob）的可运行实现留档在 tmp/spinner-preview/gen.mjs。
 */
import type { ComponentProps } from 'react'
import { cn } from 'cn'

export function WorkingSpinner({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('working-spinner text-xs', className)} {...props} />
}
