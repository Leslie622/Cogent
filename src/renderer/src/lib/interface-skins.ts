/** 界面主题色为头部与两级侧栏提供连续底色；明暗成对，缩略图共用色板。 */
import type { HexColor } from '@/lib/hex-color'

export interface InterfacePalette {
  start: HexColor
  middle: HexColor
  end: HexColor
  glow: HexColor
  detail: HexColor
}

interface InterfaceSkin {
  name: string
  light: InterfacePalette
  dark: InterfacePalette
}

export const INTERFACE_SKINS = {
  // 微跨色相 + 左上柔光晕：浅色通透清亮、深色保留低明度色相光感；墨色保持微冷高级灰。
  ink: {
    name: '墨色',
    light: { start: '#dfe3e8', middle: '#eceff3', end: '#f6f7f9', glow: '#ffffff', detail: '#171717' },
    dark: { start: '#2c3036', middle: '#212429', end: '#181a1e', glow: '#788294', detail: '#e5e5e5' },
  },
  mint: {
    name: '薄荷',
    light: { start: '#c9f0e4', middle: '#dff4f2', end: '#eef6fb', glow: '#a5f3e0', detail: '#398c79' },
    dark: { start: '#163b36', middle: '#172c30', end: '#161f24', glow: '#2d8c78', detail: '#87cbb6' },
  },
  honey: {
    name: '蜜蜂',
    light: { start: '#f7e8be', middle: '#f9f1d8', end: '#f6f8f2', glow: '#ffe194', detail: '#9b8433' },
    dark: { start: '#40341a', middle: '#2e291b', end: '#20201b', glow: '#9e8034', detail: '#d4bd72' },
  },
  parchment: {
    name: '羊皮纸',
    light: { start: '#f6dfd0', middle: '#f9ebe1', end: '#fcf6f0', glow: '#ffceb0', detail: '#b16b4c' },
    dark: { start: '#422b20', middle: '#31241e', end: '#231d1a', glow: '#9c6044', detail: '#d6a286' },
  },
  sea: {
    name: '海盐',
    light: { start: '#cde4fc', middle: '#e2ecfb', end: '#f1f2fc', glow: '#a6d4ff', detail: '#557da6' },
    dark: { start: '#17324f', middle: '#1a2840', end: '#171d2c', glow: '#4080c8', detail: '#92b8df' },
  },
  dusk: {
    name: '暮紫',
    light: { start: '#e2d6fb', middle: '#f1e4f8', end: '#faf2f6', glow: '#d4b8ff', detail: '#8a6aa5' },
    dark: { start: '#31214a', middle: '#2b1f38', end: '#1f1a28', glow: '#7e58b8', detail: '#bda3d8' },
  },
} as const satisfies Record<string, InterfaceSkin>

export type InterfaceSkinId = keyof typeof INTERFACE_SKINS
export const INTERFACE_SKIN_IDS = Object.keys(INTERFACE_SKINS) as InterfaceSkinId[]
export const DEFAULT_INTERFACE_SKIN: InterfaceSkinId = 'mint'

export function interfaceThemeColors(dark: boolean) {
  return INTERFACE_SKIN_IDS.map((id) => ({
    name: INTERFACE_SKINS[id].name,
    color: INTERFACE_SKINS[id][dark ? 'dark' : 'light'].detail,
  }))
}

/** 仅用于本地持久化读取边界，旧档缺字段继续使用原有薄荷配色。 */
export function isInterfaceSkinId(value: unknown): value is InterfaceSkinId {
  return INTERFACE_SKIN_IDS.some((id) => id === value)
}

/** 主窗口垫系统材质时，外壳基底不透明度范围（%）与默认值；缩略图仍用实色。 */
export const SHELL_OPACITY_MIN = 40
export const SHELL_OPACITY_MAX = 100
export const DEFAULT_SHELL_OPACITY = 65
const GLOW_ALPHA_LIGHT = 0.22
const GLOW_ALPHA_DARK = 0.16

export function clampShellOpacity(value: number): number {
  return Math.min(SHELL_OPACITY_MAX, Math.max(SHELL_OPACITY_MIN, Math.round(value)))
}

export function interfaceSkinVariables(
  id: InterfaceSkinId,
  dark: boolean,
  backdrop = false,
  opacity = DEFAULT_SHELL_OPACITY,
) {
  const palette = INTERFACE_SKINS[id][dark ? 'dark' : 'light']
  const channel = (hex: HexColor) => {
    const value = Number.parseInt(hex.slice(1), 16)
    return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`
  }
  const alpha = clampShellOpacity(opacity) / 100
  const glowAlpha = dark ? GLOW_ALPHA_DARK : GLOW_ALPHA_LIGHT
  const paint = (hex: HexColor) => (backdrop && alpha < 1 ? `rgb(${channel(hex)} / ${alpha})` : hex)
  return {
    // 宽幅漫射：顶部偏左大范围柔光晕 + 135deg 对角微跨色相渐变，避免色彩聚在左上死角。
    '--chrome-surface': `radial-gradient(ellipse 90% 70% at 18% 0% in oklab, rgb(${channel(palette.glow)} / ${glowAlpha}) 0%, transparent 72%), linear-gradient(135deg in oklab, ${paint(palette.start)} 0%, ${paint(palette.middle)} 48%, ${paint(palette.end)} 100%)`,
    '--sidebar': paint(palette.middle),
    '--visual-radio-color': palette.detail,
  }
}
