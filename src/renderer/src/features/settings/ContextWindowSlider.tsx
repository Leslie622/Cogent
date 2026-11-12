/**
 * 上下文窗口滑杆（ModelDialog 专用）：StopSlider（components/，通用档位
 * 滑杆）的域适配层 —— 只定义业务参数：档位 100K/200K/400K/1M（200K/400K/1M
 * 三档 2026-11-10 用户定稿，1M 顶格对标参考稿；100K 2026-11-12 为压缩验证
 * 补入 —— 触发线仍是 90%（ctx > 80K 占比线恒取胜，引擎 compaction.ts 注释
 * 同口径），但堆到触发线的对话量只需 200K 的一半，测试省轮次）、token 数
 * 缩写文案。
 * 几何/交互/样式全在通用件。目录精确值（如 131072）经 StopSlider 的最近档
 * 显示语义原样保留，只在用户交互后才改写为档位值。
 */
import { StopSlider } from '@/components/StopSlider'
import { formatContext } from './models-recipes'

/** 上下文窗口档位：只认 100K / 200K / 400K / 1M 四档 */
const CONTEXT_STOPS = [100_000, 200_000, 400_000, 1_000_000] as const

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
