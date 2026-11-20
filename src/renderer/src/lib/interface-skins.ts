/** 界面主题色提供头部、两级侧栏与取色器配色；明暗成对，共用同一份色板。 */
import type { HexColor } from '@/lib/hex-color'

export interface InterfacePalette {
  start: HexColor
  middle: HexColor
  end: HexColor
  sidebar: HexColor
  detail: HexColor
}

interface InterfaceSkin {
  name: string
  light: InterfacePalette
  dark: InterfacePalette
}

export const INTERFACE_SKINS = {
  forest: {
    name: '森林',
    light: { start: '#dce9df', middle: '#eaf0e9', end: '#f6f8f3', sidebar: '#eff4ed', detail: '#4d7560' },
    dark: { start: '#20392d', middle: '#1c2c24', end: '#181e1a', sidebar: '#202d24', detail: '#9bc6a6' },
  },
  mint: {
    name: '薄荷',
    light: { start: '#e0f3e9', middle: '#eef7f2', end: '#fbfdfb', sidebar: '#f2f8f4', detail: '#398c79' },
    dark: { start: '#1b3a35', middle: '#1b2f2b', end: '#17221f', sidebar: '#20302b', detail: '#87cbb6' },
  },
  honey: {
    name: '蜜蜂',
    light: { start: '#f2eac0', middle: '#f5f0da', end: '#e7eef1', sidebar: '#f7f4e6', detail: '#9b8433' },
    dark: { start: '#3c3420', middle: '#302d22', end: '#1d282d', sidebar: '#302e23', detail: '#d4bd72' },
  },
  parchment: {
    name: '羊皮纸',
    light: { start: '#f1e2d8', middle: '#f7eee6', end: '#fcf8f2', sidebar: '#f8f2e9', detail: '#b16b4c' },
    dark: { start: '#3c2d26', middle: '#302823', end: '#24201e', sidebar: '#302923', detail: '#d6a286' },
  },
  sea: {
    name: '海盐',
    light: { start: '#dce9f5', middle: '#eaf1f8', end: '#f5f8fc', sidebar: '#eef4fa', detail: '#557da6' },
    dark: { start: '#22364c', middle: '#202d3d', end: '#1a222d', sidebar: '#222e3d', detail: '#92b8df' },
  },
  dusk: {
    name: '暮紫',
    light: { start: '#e8e0f2', middle: '#f1ebf7', end: '#faf7fc', sidebar: '#f4eff8', detail: '#8a6aa5' },
    dark: { start: '#352b44', middle: '#2b2535', end: '#211e28', sidebar: '#2c2636', detail: '#bda3d8' },
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

export function interfaceSkinVariables(id: InterfaceSkinId, dark: boolean) {
  const palette = INTERFACE_SKINS[id][dark ? 'dark' : 'light']
  return {
    '--chrome-surface': `linear-gradient(135deg, ${palette.start} 0%, ${palette.middle} 45%, ${palette.end} 100%)`,
    '--sidebar': palette.middle,
    '--content-sidebar': palette.sidebar,
    '--visual-radio-color': palette.detail,
  }
}
