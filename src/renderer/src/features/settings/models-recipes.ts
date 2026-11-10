/**
 * 模型设置分区的共用配方与纯函数（2026-11-10 从 ModelsSection.tsx 拆出）：
 * ModelsSection 拆分件（ModelDialog / ContextWindowSlider / ProviderModelRow /
 * 两个 Detail / ApiKeyField / FormatSelect）的最小公约层 —— 字段标签/间距与
 * 徽标样式配方、token 数缩写文案。只放无状态、无 React 依赖的常量/纯函数，
 * 拆分件之间不互相 import 这些零碎，共用物全部下沉到这里，避免组件环。
 */

/** 字段标签字号（模型分区表单字段统一 13px） */
export const FIELD_LABEL = 'text-[13px]'

/** 字段块纵向间距（首个字段之后的每个字段块 mt-5） */
export const FIELD_GAP = 'mt-5'

/** 列表行/徽标共用配方（行容器 divide-y 分隔，圆角由外层容器裁） */
export const BADGE = 'rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'

/** 上下文窗口徽标文案：200000 → 200K，1048576 → 1M */
export function formatContext(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.floor(tokens / 1000)}K`
}
