/** 悬停过渡时长档（ms）：外观偏好「开启过渡效果」的滑杆范围与钳制（上限 2000ms，2026-11-28 用户定调）。滑动动画只有开关、无参数。 */
export const HOVER_TRANSITION_MS_MIN = 50
export const HOVER_TRANSITION_MS_MAX = 2000
export const HOVER_TRANSITION_MS_STEP = 50
export const DEFAULT_HOVER_TRANSITION_MS = 150

/** 钳到范围内并对齐步长（50ms）：手改档与拖动落点都归到滑杆刻度上。 */
export function clampHoverTransitionMs(value: number): number {
  const clamped = Math.min(HOVER_TRANSITION_MS_MAX, Math.max(HOVER_TRANSITION_MS_MIN, Math.round(value)))
  return Math.round(clamped / HOVER_TRANSITION_MS_STEP) * HOVER_TRANSITION_MS_STEP
}
