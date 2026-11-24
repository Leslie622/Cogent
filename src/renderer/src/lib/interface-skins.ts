/** 界面主题色为头部与两级侧栏提供连续底色；明暗成对，缩略图共用色板。 */
import type { HexColor } from '@/lib/hex-color'

export interface InterfacePalette {
  start: HexColor
  middle: HexColor
  end: HexColor
  detail: HexColor
}

interface InterfaceSkin {
  name: string
  light: InterfacePalette
  dark: InterfacePalette
}

export const INTERFACE_SKINS = {
  // 相邻色阶收窄明度差，浅色保留轻染色、深色避免压黑；墨色保持中性灰。
  ink: {
    name: '墨色',
    light: { start: '#efefef', middle: '#f5f5f5', end: '#f9f9f9', detail: '#171717' },
    dark: { start: '#2b2b2b', middle: '#252525', end: '#202020', detail: '#e5e5e5' },
  },
  mint: {
    name: '薄荷',
    light: { start: '#e2f3eb', middle: '#edf6f1', end: '#f5faf7', detail: '#398c79' },
    dark: { start: '#263b34', middle: '#23322c', end: '#202925', detail: '#87cbb6' },
  },
  honey: {
    name: '蜜蜂',
    light: { start: '#f5edcf', middle: '#f8f4e5', end: '#f7f9f7', detail: '#9b8433' },
    dark: { start: '#3c3525', middle: '#332f25', end: '#2b2c27', detail: '#d4bd72' },
  },
  parchment: {
    name: '羊皮纸',
    light: { start: '#f4e7dc', middle: '#f8f0e7', end: '#fcf8f1', detail: '#b16b4c' },
    dark: { start: '#3c3029', middle: '#342c26', end: '#2c2723', detail: '#d6a286' },
  },
  sea: {
    name: '海盐',
    light: { start: '#e1edf9', middle: '#edf4fb', end: '#f6f9fd', detail: '#557da6' },
    dark: { start: '#2a3a4d', middle: '#263343', end: '#222c38', detail: '#92b8df' },
  },
  dusk: {
    name: '暮紫',
    light: { start: '#eee5f8', middle: '#f4eefb', end: '#faf7fd', detail: '#8a6aa5' },
    dark: { start: '#3a3047', middle: '#322b3c', end: '#2a2632', detail: '#bda3d8' },
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

/** 试验：主窗口垫系统材质时，外壳基底保留的不透明度（越小越透）；缩略图仍用实色。 */
const BACKDROP_ALPHA = 0.7

export function interfaceSkinVariables(id: InterfaceSkinId, dark: boolean, backdrop = false) {
  const palette = INTERFACE_SKINS[id][dark ? 'dark' : 'light']
  const channel = (hex: HexColor) => {
    const value = Number.parseInt(hex.slice(1), 16)
    return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`
  }
  const paint = (hex: HexColor) => backdrop ? `rgb(${channel(hex)} / ${BACKDROP_ALPHA})` : hex
  return {
    // 椭圆半径跟随宽高：顶部右端与左栏底部都能走完整段色阶，不把末色藏在正文下面。
    '--chrome-surface': `radial-gradient(ellipse 100% 100% at 0% 0% in oklab, ${paint(palette.start)} 0%, ${paint(palette.middle)} 58%, ${paint(palette.end)} 100%)`,
    '--sidebar': paint(palette.middle),
    '--visual-radio-color': palette.detail,
  }
}
