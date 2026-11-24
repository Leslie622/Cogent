/**
 * 外观偏好 store（zustand + persist → localStorage: cogent-appearance）——
 * 与 theme store 同层定调：纯渲染端视觉偏好，不进引擎/协议/settings.json
 * （跨设备同步是真墙：引擎侧无设置同步通道）。
 * 消费点：共享 appearance-dom（明暗/皮肤/换行/强调色/字号，覆盖所有窗口）、
 * ToolCard / 轨迹与统计行（输出详细程度/过程请求详情/耗时精度）、markdown.tsx（lineNumbers / shikiTheme）、ChatTheme（isDark 选套 +
 * buildUserTokens 用户覆盖合并进编译）。
 * 持久化读取是信任边界（约定.md §1.1）：merge 校验字段形状，坏档回落默认。
 */
import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import { persist } from 'zustand/middleware'
import { isHexColor, type HexColor } from '@/lib/hex-color'
import { quoteFontFamily } from '@/lib/theme/compile'
import type { ThemeTokens } from '@/lib/theme/tokens'
import type { DurationPrecision } from '@/lib/format-duration'
import {
  clampShellOpacity,
  DEFAULT_INTERFACE_SKIN,
  DEFAULT_SHELL_OPACITY,
  isInterfaceSkinId,
  SHELL_OPACITY_MAX,
  SHELL_OPACITY_MIN,
  type InterfaceSkinId,
} from '@/lib/interface-skins'

export type OutputVerbosity = 'low' | 'high'

export type LocalFontId = `local:${string}`
export const LOCAL_FONT_PREFIX = 'local:'
export type FontChoice = 'theme' | 'system-ui' | 'ui-monospace' | LocalFontId
export type FontScript = 'latin' | 'cjk'
export type FontPair = Record<FontScript, FontChoice>

function isLocalFont(value: string): value is LocalFontId {
  return value.startsWith(LOCAL_FONT_PREFIX) && value.slice(LOCAL_FONT_PREFIX.length).trim() !== ''
}

/** 界面明暗三档；system = 跟随 OS（由共享外观投影监听） */
export type ColorMode = 'light' | 'dark' | 'system'

const THEME_FONTS: FontPair = { latin: 'theme', cjk: 'theme' }
const LEGACY_CONTENT_FONTS = new Map<string, FontPair>([
  ['inter', { latin: 'local:Inter', cjk: 'local:HarmonyOS Sans SC' }],
  ['segoe', { latin: 'local:Segoe UI', cjk: 'local:Microsoft YaHei' }],
  ['georgia', { latin: 'local:Georgia', cjk: 'local:SimSun' }],
  ['system', { latin: 'system-ui', cjk: 'system-ui' }],
])
const LEGACY_CODE_FONTS = new Map<string, FontPair>([
  ['jetbrains', { latin: 'local:JetBrains Mono', cjk: 'theme' }],
  ['consolas', { latin: 'local:Consolas', cjk: 'theme' }],
  ['cascadia', { latin: 'local:Cascadia Code', cjk: 'theme' }],
  ['mono', { latin: 'ui-monospace', cjk: 'theme' }],
])

function readFontChoice(value: unknown): FontChoice {
  if (typeof value === 'string' && (value === 'system-ui' || value === 'ui-monospace' || isLocalFont(value))) {
    return value
  }
  return 'theme'
}

function readFontPair(value: unknown, legacy: ReadonlyMap<string, FontPair>): FontPair {
  if (typeof value === 'string') {
    return legacy.get(value) ?? { latin: readFontChoice(value), cjk: 'theme' }
  }
  if (typeof value !== 'object' || value === null) return THEME_FONTS
  return {
    latin: 'latin' in value ? readFontChoice(value.latin) : 'theme',
    cjk: 'cjk' in value ? readFontChoice(value.cjk) : 'theme',
  }
}

type Accent = 'default' | HexColor

/** 代码字号档（px）；null = 跟随主题/回落 */
export const CODE_FONT_SIZES = Array.from({ length: 17 }, (_value, index) => index + 8)
export const UI_FONT_SIZES = [11, 12, 13, 14, 15, 16] as const
export const DEFAULT_UI_FONT_SIZE = 14

interface AppearanceState {
  outputVerbosity: OutputVerbosity
  /** 仅控制过程中的单次请求统计；最终回合汇总独立显示，默认关闭。 */
  showProcessUsage: boolean
  durationPrecision: DurationPrecision
  colorMode: ColorMode
  interfaceSkin: InterfaceSkinId
  /** 主窗口外壳（头部与两侧栏）不透明度（40–100%，100% 即完全不透明） */
  shellOpacity: number
  uiFontSize: number
  /** 对话内容代码块行号（Streamdown lineNumbers prop；默认关 = 主流聊天惯例） */
  showLineNumbers: boolean
  /** 代码长行自动换行（html[data-code-wrap] 门控 → pre-wrap；默认关 = 横向滚动） */
  codeWrap: boolean
  /** 代码字号（px；null = 跟随主题与回落） */
  codeFontSize: number | null
  /** 对话内容字体档（root.fontLatin/Cjk 覆盖） */
  contentFont: FontPair
  /** 代码字体档（codeBlock/inlineCode 共用两槽） */
  codeFont: FontPair
  accent: Accent
  setOutputVerbosity: (verbosity: OutputVerbosity) => void
  setShowProcessUsage: (show: boolean) => void
  setDurationPrecision: (precision: DurationPrecision) => void
  setColorMode: (mode: ColorMode) => void
  setInterfaceSkin: (skin: InterfaceSkinId) => void
  setShellOpacity: (opacity: number) => void
  setUiFontSize: (size: number) => void
  setShowLineNumbers: (show: boolean) => void
  setCodeWrap: (wrap: boolean) => void
  setCodeFontSize: (size: number | null) => void
  setContentFont: (font: FontPair) => void
  setCodeFont: (font: FontPair) => void
  setAccent: (accent: Accent) => void
}

/** 明暗裁决（纯函数）：dark 直选；system 看 OS；App effect 与 main.tsx 防闪白共用 */
export function isDarkMode(mode: ColorMode, systemDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && systemDark)
}

function subscribeSystemDark(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export function useIsDarkMode(): boolean {
  const mode = useAppearanceStore((state) => state.colorMode)
  const systemDark = useSyncExternalStore(
    subscribeSystemDark,
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    () => false,
  )
  return isDarkMode(mode, systemDark)
}

/** 用户覆盖 → 主题令牌（ChatTheme 编译前合并；优先级 用户 > 主题包 > 消费表回落） */
export function buildUserTokens(a: Pick<AppearanceState, 'codeFontSize' | 'contentFont' | 'codeFont'>): ThemeTokens {
  const tokens: ThemeTokens = {}
  if (a.codeFontSize !== null) tokens['codeBlock.size'] = `${a.codeFontSize}px`
  for (const [script, suffix] of [['latin', 'fontLatin'], ['cjk', 'fontCjk']] as const) {
    const content = a.contentFont[script]
    const code = a.codeFont[script]
    if (content !== 'theme') tokens[`root.${suffix}`] = fontFamily(content)
    if (code !== 'theme') {
      tokens[`codeBlock.${suffix}`] = fontFamily(code)
      tokens[`inlineCode.${suffix}`] = fontFamily(code)
    }
  }
  return tokens
}

function fontFamily(font: Exclude<FontChoice, 'theme'>): string {
  return isLocalFont(font) ? quoteFontFamily(font.slice(LOCAL_FONT_PREFIX.length)) : font
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      outputVerbosity: 'high',
      showProcessUsage: false,
      durationPrecision: 2,
      colorMode: 'light',
      interfaceSkin: DEFAULT_INTERFACE_SKIN,
      shellOpacity: DEFAULT_SHELL_OPACITY,
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      showLineNumbers: false,
      codeWrap: false,
      codeFontSize: null,
      contentFont: THEME_FONTS,
      codeFont: THEME_FONTS,
      accent: 'default',
      setOutputVerbosity: (outputVerbosity) => set({ outputVerbosity }),
      setShowProcessUsage: (showProcessUsage) => set({ showProcessUsage }),
      setDurationPrecision: (durationPrecision) => set({ durationPrecision }),
      setColorMode: (colorMode) => set({ colorMode }),
      setInterfaceSkin: (interfaceSkin) => set({ interfaceSkin }),
      setShellOpacity: (opacity) => set({ shellOpacity: clampShellOpacity(opacity) }),
      setUiFontSize: (uiFontSize) => set({ uiFontSize }),
      setShowLineNumbers: (showLineNumbers) => set({ showLineNumbers }),
      setCodeWrap: (codeWrap) => set({ codeWrap }),
      setCodeFontSize: (codeFontSize) => set({ codeFontSize }),
      setContentFont: (contentFont) => set({ contentFont }),
      setCodeFont: (codeFont) => set({ codeFont }),
      setAccent: (accent) => set({ accent }),
    }),
    {
      name: 'cogent-appearance',
      merge: (persisted, current) => {
        const raw = persisted as Partial<Record<keyof AppearanceState, unknown>> | undefined
        return {
          ...current,
          outputVerbosity: raw?.outputVerbosity === 'low' ? 'low' : 'high',
          showProcessUsage: raw?.showProcessUsage === true,
          durationPrecision:
            raw?.durationPrecision === 0 || raw?.durationPrecision === 1 ? raw.durationPrecision : 2,
          colorMode:
            raw?.colorMode === 'dark' || raw?.colorMode === 'system' ? raw.colorMode : 'light',
          interfaceSkin: isInterfaceSkinId(raw?.interfaceSkin) ? raw.interfaceSkin : DEFAULT_INTERFACE_SKIN,
          shellOpacity:
            typeof raw?.shellOpacity === 'number' &&
            Number.isInteger(raw.shellOpacity) &&
            raw.shellOpacity >= SHELL_OPACITY_MIN &&
            raw.shellOpacity <= SHELL_OPACITY_MAX
              ? raw.shellOpacity
              : DEFAULT_SHELL_OPACITY,
          uiFontSize:
            typeof raw?.uiFontSize === 'number' && (UI_FONT_SIZES as readonly number[]).includes(raw.uiFontSize)
              ? raw.uiFontSize
              : DEFAULT_UI_FONT_SIZE,
          showLineNumbers: raw?.showLineNumbers === true,
          codeWrap: raw?.codeWrap === true,
          // 字号是受控下拉写入的整数；越界/非整（手改档）按"跟随主题"处理
          codeFontSize:
            typeof raw?.codeFontSize === 'number' &&
            (CODE_FONT_SIZES as readonly number[]).includes(raw.codeFontSize)
              ? raw.codeFontSize
              : null,
          contentFont: readFontPair(raw?.contentFont, LEGACY_CONTENT_FONTS),
          codeFont: readFontPair(raw?.codeFont, LEGACY_CODE_FONTS),
          accent: isHexColor(raw?.accent, true) ? raw.accent : 'default',
        }
      },
    },
  ),
)
