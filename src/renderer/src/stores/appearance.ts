/**
 * 外观偏好 store（zustand + persist → localStorage: cogent-appearance）——
 * 与 theme store 同层定调：纯渲染端视觉偏好，不进引擎/协议/settings.json
 * （跨设备同步是真墙：引擎侧无设置同步通道）。
 * 消费点：App 层 effect（html.dark / html[data-code-wrap] / --chrome-accent）、
 * markdown.tsx（lineNumbers / shikiTheme）、ChatTheme（isDark 选套 +
 * buildUserTokens 用户覆盖合并进编译）。
 * 持久化读取是信任边界（约定.md §1.1）：merge 校验字段形状，坏档回落默认。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ThemeTokens } from '@/lib/theme/tokens'

/** 界面明暗三档；system = 跟随 OS（matchMedia 监听在 App 层 effect） */
export type ColorMode = 'light' | 'dark' | 'system'

/** 内容字体档：id → (拉丁族, 中文族)；theme = 跟随主题不覆盖 */
type ContentFontId = 'theme' | 'inter' | 'segoe' | 'georgia' | 'system'
const CONTENT_FONTS: Record<Exclude<ContentFontId, 'theme'>, { label: string; latin: string; cjk: string }> = {
  inter: { label: 'Inter + 鸿蒙', latin: 'Inter', cjk: 'HarmonyOS Sans SC' },
  segoe: { label: 'Segoe UI + 微软雅黑', latin: 'Segoe UI', cjk: 'Microsoft YaHei' },
  georgia: { label: 'Georgia + 宋体（衬线）', latin: 'Georgia', cjk: 'SimSun' },
  system: { label: '系统界面字体', latin: 'system-ui', cjk: 'system-ui' },
}

/** 代码字体档：id → 等宽族；theme = 跟随主题不覆盖 */
type CodeFontId = 'theme' | 'jetbrains' | 'consolas' | 'cascadia' | 'mono'
const CODE_FONTS: Record<Exclude<CodeFontId, 'theme'>, { label: string; latin: string }> = {
  jetbrains: { label: 'JetBrains Mono', latin: 'JetBrains Mono' },
  consolas: { label: 'Consolas', latin: 'Consolas' },
  cascadia: { label: 'Cascadia Code', latin: 'Cascadia Code' },
  mono: { label: '系统等宽', latin: 'ui-monospace' },
}

/** 强调色板：每色亮/暗双值（深底下同亮度色会糊，按面调两档）；default = 品牌蓝不覆盖 */
type AccentId = 'default' | 'violet' | 'green' | 'teal' | 'orange' | 'red' | 'pink'
const ACCENTS: Record<Exclude<AccentId, 'default'>, { label: string; light: string; dark: string }> = {
  violet: { label: '紫', light: '#7c3aed', dark: '#a78bfa' },
  green: { label: '绿', light: '#059669', dark: '#34d399' },
  teal: { label: '青', light: '#0d9488', dark: '#2dd4bf' },
  orange: { label: '橙', light: '#ea580c', dark: '#fb923c' },
  red: { label: '红', light: '#dc2626', dark: '#f87171' },
  pink: { label: '粉', light: '#db2777', dark: '#f472b6' },
}

/** UI 侧枚举出口（下拉/色板渲染用；保持 id 序 = 展示序） */
export const CONTENT_FONT_OPTIONS = (Object.keys(CONTENT_FONTS) as Array<Exclude<ContentFontId, 'theme'>>).map(
  (id) => ({ value: id, label: CONTENT_FONTS[id].label }),
)
export const CODE_FONT_OPTIONS = (Object.keys(CODE_FONTS) as Array<Exclude<CodeFontId, 'theme'>>).map((id) => ({
  value: id,
  label: CODE_FONTS[id].label,
}))
export const ACCENT_OPTIONS = (Object.keys(ACCENTS) as Array<Exclude<AccentId, 'default'>>).map((id) => ({
  value: id,
  label: ACCENTS[id].label,
  light: ACCENTS[id].light,
  dark: ACCENTS[id].dark,
}))
/** 代码字号档（px）；null = 跟随主题/回落 */
export const CODE_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18] as const

/** 强调色取值（按当前明暗选面）；default 档返回 null = 不覆盖变量（用主题两面的品牌蓝） */
export function accentValue(id: AccentId, dark: boolean): string | null {
  if (id === 'default') return null
  return dark ? ACCENTS[id].dark : ACCENTS[id].light
}

interface AppearanceState {
  colorMode: ColorMode
  /** 对话内容代码块行号（Streamdown lineNumbers prop；默认关 = 主流聊天惯例） */
  showLineNumbers: boolean
  /** 代码长行自动换行（html[data-code-wrap] 门控 → pre-wrap；默认关 = 横向滚动） */
  codeWrap: boolean
  /** 代码字号（px；null = 跟随主题与回落） */
  codeFontSize: number | null
  /** 对话内容字体档（root.fontLatin/Cjk 覆盖） */
  contentFont: ContentFontId
  /** 代码字体档（codeBlock/inlineCode 的 fontLatin 覆盖） */
  codeFont: CodeFontId
  /** 强调色档（--chrome-accent 覆盖，亮暗双值） */
  accent: AccentId
  setColorMode: (mode: ColorMode) => void
  setShowLineNumbers: (show: boolean) => void
  setCodeWrap: (wrap: boolean) => void
  setCodeFontSize: (size: number | null) => void
  setContentFont: (font: ContentFontId) => void
  setCodeFont: (font: CodeFontId) => void
  setAccent: (accent: AccentId) => void
}

/** 明暗裁决（纯函数）：dark 直选；system 看 OS；App effect 与 main.tsx 防闪白共用 */
export function isDarkMode(mode: ColorMode, systemDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && systemDark)
}

/** 用户覆盖 → 主题令牌（ChatTheme 编译前合并；优先级 用户 > 主题包 > 消费表回落） */
export function buildUserTokens(a: {
  codeFontSize: number | null
  contentFont: ContentFontId
  codeFont: CodeFontId
}): ThemeTokens {
  const tokens: ThemeTokens = {}
  if (a.codeFontSize !== null) tokens['codeBlock.size'] = `${a.codeFontSize}px`
  if (a.contentFont !== 'theme') {
    tokens['root.fontLatin'] = CONTENT_FONTS[a.contentFont].latin
    tokens['root.fontCjk'] = CONTENT_FONTS[a.contentFont].cjk
  }
  if (a.codeFont !== 'theme') {
    const latin = CODE_FONTS[a.codeFont].latin
    tokens['codeBlock.fontLatin'] = latin
    tokens['inlineCode.fontLatin'] = latin
  }
  return tokens
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      colorMode: 'light',
      showLineNumbers: false,
      codeWrap: false,
      codeFontSize: null,
      contentFont: 'theme',
      codeFont: 'theme',
      accent: 'default',
      setColorMode: (colorMode) => set({ colorMode }),
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
        const raw = persisted as Partial<AppearanceState> | undefined
        return {
          ...current,
          colorMode:
            raw?.colorMode === 'dark' || raw?.colorMode === 'system' ? raw.colorMode : 'light',
          showLineNumbers: raw?.showLineNumbers === true,
          codeWrap: raw?.codeWrap === true,
          // 字号是受控下拉写入的整数；越界/非整（手改档）按"跟随主题"处理
          codeFontSize:
            typeof raw?.codeFontSize === 'number' &&
            (CODE_FONT_SIZES as readonly number[]).includes(raw.codeFontSize)
              ? raw.codeFontSize
              : null,
          contentFont:
            raw?.contentFont !== undefined && (raw.contentFont === 'theme' || raw.contentFont in CONTENT_FONTS)
              ? raw.contentFont
              : 'theme',
          codeFont:
            raw?.codeFont !== undefined && (raw.codeFont === 'theme' || raw.codeFont in CODE_FONTS)
              ? raw.codeFont
              : 'theme',
          accent:
            raw?.accent !== undefined && (raw.accent === 'default' || raw.accent in ACCENTS)
              ? raw.accent
              : 'default',
        }
      },
    },
  ),
)
