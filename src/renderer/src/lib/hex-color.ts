/** 取色输入用六位 RGB；持久化另外允许最后两位存透明度。 */
export type HexColor = `#${string}`

export function isHexColor(value: unknown, allowAlpha = false): value is HexColor {
  return typeof value === 'string' && (allowAlpha ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/i : /^#[0-9a-f]{6}$/i).test(value)
}
