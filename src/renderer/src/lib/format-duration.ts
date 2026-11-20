/**
 * 对话耗时的统一格式化：单位由时长决定，偏好只控制秒位小数。
 * 先按精度舍入再拆分秒，避免出现 60s；小时档省略秒，不受秒位精度影响。
 */
export type DurationPrecision = 0 | 1 | 2

export function formatDuration(ms: number, precision: DurationPrecision = 2): string {
  if (ms >= 3_600_000) {
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
  }
  const scale = 10 ** precision
  const ticks = Math.round(ms / (1000 / scale))
  const minuteTicks = 60 * scale
  const minutes = Math.floor(ticks / minuteTicks)
  if (minutes === 60) return '1h 0m'
  const seconds = ((ticks % minuteTicks) / scale).toFixed(precision)
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}
