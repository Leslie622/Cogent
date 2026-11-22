/**
 * 对话耗时的统一格式化：单位语言由消费点指定，偏好只控制秒位小数。
 * 先按精度舍入再拆分秒，避免出现 60 秒；小时档省略秒，不受秒位精度影响。
 */
export type DurationPrecision = 0 | 1 | 2

export function formatDuration(
  ms: number,
  precision: DurationPrecision = 2,
  units: 'short' | 'chinese' = 'short',
): string {
  const [hourUnit, minuteUnit, secondUnit] = units === 'chinese' ? [' 时', ' 分', ' 秒'] : ['h', 'm', 's']
  if (ms >= 3_600_000) {
    return `${Math.floor(ms / 3_600_000)}${hourUnit} ${Math.floor((ms % 3_600_000) / 60_000)}${minuteUnit}`
  }
  const scale = 10 ** precision
  const ticks = Math.round(ms / (1000 / scale))
  const minuteTicks = 60 * scale
  const minutes = Math.floor(ticks / minuteTicks)
  if (minutes === 60) return `1${hourUnit} 0${minuteUnit}`
  const seconds = ((ticks % minuteTicks) / scale).toFixed(precision)
  return minutes > 0 ? `${minutes}${minuteUnit} ${seconds}${secondUnit}` : `${seconds}${secondUnit}`
}
