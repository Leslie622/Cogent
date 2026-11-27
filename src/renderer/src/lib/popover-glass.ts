/** 轻量浮层毛玻璃独立维度（不透明度 / 模糊半径 / 饱和度）与明暗 CSS 变量投影。 */
export const POPOVER_GLASS_OPACITY_MIN = 0
export const POPOVER_GLASS_OPACITY_MAX = 100
export const DEFAULT_POPOVER_GLASS_OPACITY = 60

export const POPOVER_GLASS_BLUR_MIN = 0
export const POPOVER_GLASS_BLUR_MAX = 32
export const DEFAULT_POPOVER_GLASS_BLUR = 10

export const POPOVER_GLASS_SATURATE_MIN = 100
export const POPOVER_GLASS_SATURATE_MAX = 250
export const DEFAULT_POPOVER_GLASS_SATURATE = 140

export interface PopoverGlassOptions {
  opacity: number
  blur: number
  saturate: number
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampPopoverGlassOpacity(value: number): number {
  return clampInt(value, POPOVER_GLASS_OPACITY_MIN, POPOVER_GLASS_OPACITY_MAX)
}

export function clampPopoverGlassBlur(value: number): number {
  return clampInt(value, POPOVER_GLASS_BLUR_MIN, POPOVER_GLASS_BLUR_MAX)
}

export function clampPopoverGlassSaturate(value: number): number {
  return clampInt(value, POPOVER_GLASS_SATURATE_MIN, POPOVER_GLASS_SATURATE_MAX)
}

/** 将不透明度（%）、模糊半径（px）与饱和度（%）投影为毛玻璃 CSS 变量；总开关关闭时由 data-popover-glass 门控回落实色。 */
export function popoverGlassVariables(options: PopoverGlassOptions, dark: boolean) {
  const round = (n: number) => Number(n.toFixed(3))
  const baseAlpha = round(clampPopoverGlassOpacity(options.opacity) / 100)
  // 子菜单面层略实一级，避免与父菜单透出面叠色发灰
  const subAlpha = round(Math.min(0.96, baseAlpha + 0.14))
  const blurPx = clampPopoverGlassBlur(options.blur)
  const saturate = round(clampPopoverGlassSaturate(options.saturate) / 100)
  const channel = dark ? '0.205 0 0' : '1 0 0'
  return {
    '--popover-glass': `oklch(${channel} / ${baseAlpha})`,
    '--popover-glass-sub': `oklch(${channel} / ${subAlpha})`,
    '--popover-glass-blur': `${blurPx}px`,
    '--popover-glass-saturate': `${saturate}`,
  }
}
