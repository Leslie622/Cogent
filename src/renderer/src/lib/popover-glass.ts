/** 轻量浮层毛玻璃强度（0–100%，0% 为关闭）与明暗 CSS 变量投影。 */
export const POPOVER_GLASS_MIN = 0
export const POPOVER_GLASS_MAX = 100
export const DEFAULT_POPOVER_GLASS = 60

export function clampPopoverGlass(value: number): number {
  return Math.min(POPOVER_GLASS_MAX, Math.max(POPOVER_GLASS_MIN, Math.round(value)))
}

/** 将 1–100% 强度映射为毛玻璃面层透明度与模糊度；0% 由 data-popover-glass 门控回落实色。 */
export function popoverGlassVariables(intensity: number, dark: boolean) {
  const ratio = clampPopoverGlass(intensity) / 100
  const round = (n: number) => Number(n.toFixed(3))
  // 浅色 60% 强度 ≈ 0.628（贴近原手工微调透光）；深色略提不透明度以抑制底层高反差透脏。
  const baseAlpha = dark ? round(0.94 - ratio * 0.42) : round(0.94 - ratio * 0.52)
  const subAlpha = dark ? round(Math.min(0.96, baseAlpha + 0.1)) : round(Math.min(0.96, baseAlpha + 0.16))
  const blurPx = Math.round(4 + ratio * 20)
  const saturate = round(1 + ratio * 0.6)
  const channel = dark ? '0.205 0 0' : '1 0 0'
  return {
    '--popover-glass': `oklch(${channel} / ${baseAlpha})`,
    '--popover-glass-sub': `oklch(${channel} / ${subAlpha})`,
    '--popover-glass-blur': `${blurPx}px`,
    '--popover-glass-saturate': `${saturate}`,
  }
}
