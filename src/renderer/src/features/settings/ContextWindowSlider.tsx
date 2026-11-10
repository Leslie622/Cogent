/**
 * 上下文窗口滑杆（ModelDialog 专用）：StopSlider（components/，通用档位
 * 滑杆）的域适配层 —— 只定义业务参数：档位 200K/400K/1M（2026-11-10 用户
 * 定稿，1M 顶格对标参考稿）、token 数缩写文案。几何/交互/样式全在通用件。
 * 目录精确值（如 131072）经 StopSlider 的最近档显示语义原样保留，只在
 * 用户交互后才改写为档位值。
 */
import { StopSlider } from '@/components/StopSlider'
import { formatContext } from './models-recipes'

/** 上下文窗口档位：只认 200K / 400K / 1M 三档 */
const CONTEXT_STOPS = [200_000, 400_000, 1_000_000] as const

/** 上下文窗口滑杆：三档吸附（值域与视觉规格见 StopSlider） */
export function ContextWindowSlider({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  return (
    <StopSlider
      value={value}
      onChange={onChange}
      max={CONTEXT_STOPS[CONTEXT_STOPS.length - 1]}
      stops={CONTEXT_STOPS}
      formatValue={formatContext}
      ariaLabel="上下文窗口"
    />
  )
}
