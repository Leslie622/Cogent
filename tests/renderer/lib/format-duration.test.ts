/** 耗时显示契约：秒位精度、单位切换和舍入进位共用同一口径。 */
import { describe, expect, it } from 'vitest'
import { formatDuration, type DurationPrecision } from '@/lib/format-duration'

describe('对话耗时格式', () => {
  it.each<[number, DurationPrecision, string, string]>([
    [0, 2, '0.00s', '0.00 秒'],
    [6, 2, '0.01s', '0.01 秒'],
    [140, 2, '0.14s', '0.14 秒'],
    [2_400, 2, '2.40s', '2.40 秒'],
    [2_456, 0, '2s', '2 秒'],
    [2_456, 1, '2.5s', '2.5 秒'],
    [2_456, 2, '2.46s', '2.46 秒'],
    [59_999, 2, '1m 0.00s', '1 分 0.00 秒'],
    [59_500, 0, '1m 0s', '1 分 0 秒'],
    [60_000, 0, '1m 0s', '1 分 0 秒'],
    [65_350, 0, '1m 5s', '1 分 5 秒'],
    [65_350, 1, '1m 5.4s', '1 分 5.4 秒'],
    [65_350, 2, '1m 5.35s', '1 分 5.35 秒'],
    [3_599_999, 2, '1h 0m', '1 时 0 分'],
    [3_600_000, 2, '1h 0m', '1 时 0 分'],
    [3_725_350, 0, '1h 2m', '1 时 2 分'],
    [3_725_350, 1, '1h 2m', '1 时 2 分'],
    [3_725_350, 2, '1h 2m', '1 时 2 分'],
    [3_719_999, 0, '1h 1m', '1 时 1 分'],
    [3_719_999, 2, '1h 1m', '1 时 1 分'],
    [90_000_000, 2, '25h 0m', '25 时 0 分'],
  ])('%dms / %d 位 → %s', (ms, precision, expected, chinese) => {
    expect(formatDuration(ms, precision)).toBe(expected)
    expect(formatDuration(ms, precision, 'chinese')).toBe(chinese)
  })

  it('缺省保留两位秒小数', () => {
    expect(formatDuration(2_400)).toBe('2.40s')
  })
})
