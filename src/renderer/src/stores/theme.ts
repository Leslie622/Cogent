/**
 * 对话内容主题 store（zustand + persist → localStorage: cogent-themes）——
 * 全仓首个 persist store：纯渲染端视觉偏好，不进引擎/协议/磁盘档案，
 * localStorage 是对的层（跨设备同步是真墙：引擎侧无设置同步通道）。
 * 「默认」主题是常量而非存储档：Cogent.themd.json 令牌集（2026-11-19
 * 用户拍板替换原 Theme-Leslie 底座），不占用户存储、不可删除；用户主题包相对
 * Themd 基础样式做稀疏差异，不叠在本底座上（两套观感混合是语义污染）。
 * 持久化读取是信任边界（约定.md §1.1）：merge 时校验形状，损坏档剔除
 * 并报错，激活 id 指向已剔除档时回落默认。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { parseThemeFile, type ThemeFile } from '@/lib/theme/theme-file'

export const DEFAULT_THEME_ID = 'default'

/** 内置默认观感（Cogent.themd.json 的导出令牌照抄，2026-11-19 用户拍板
    替换原 Theme-Leslie 底座；值改动 = 改所有人的默认正文观感） */
const DEFAULT_THEME: ThemeFile = {
  version: 1,
  id: DEFAULT_THEME_ID,
  name: '默认',
  tokens: {
    // 聊天默认密度是宿主选择；导入主题的空缺项仍使用 Themd 基础值。
    'root.size': '14px',
    'codeBlock.size': '14px',
    'p.align': 'start',
    'del.thickness': '2px',
    'a.hoverColor': '#3b82f6',
    'inlineCode.fontLatin': 'JetBrains Mono',
    'inlineCode.fontCjk': 'HarmonyOS Sans SC',
    'task.accent': '#22c55e',
    'task.doneColor': '#22c55e',
    'quote.bg': '#f4f2f2',
    'quote.radius': '5px',
    'quote.padding': '1em',
    'codeBlock.fontLatin': 'JetBrains Mono',
    'codeBlock.fontCjk': 'HarmonyOS Sans SC',
    'cell.rowLine': 'solid',
    'cell.colLine': 'none',
    'table.collapse': 'separate',
    'cell.borderWidth': '1px',
    'table.stripeBg': 'rgba(242, 242, 242, 0.42)',
    'hr.thickness': '1.5px',
    'img.align': 'auto',
    'img.margin': '0.6em',
    'root.fontLatin': 'Inter',
    'root.fontCjk': 'HarmonyOS Sans SC',
    'h1.size': '21px',
    'h2.size': '19px',
    'h3.size': '18px',
    'h4.size': '15px',
    'h5.size': '15px',
    'h6.size': '14px',
    'a.underline': 'always',
    'a.color': '#3b82f6',
    'a.underlineHeight': '1.5px',
    'table.radius': '6px',
    'hr.margin': '1.2em 0em',
    'img.radius': '8px',
  },
  /* 暗色套：整面替换语义（theme-file.ts）—— 与明暗无关的键（字体/尺寸/
     边框样式）照抄，只暗化亮面刺眼值（浅底色 → 暗底色、饱和色提亮度）。
     暗化规则沿用 Theme-Leslie 底座：#3b82f6→#60a5fa、#22c55e→#4ade75、
     浅灰底→oklch 暗灰；stripeBg 亮值是半透明浅灰，暗值取同透明度暗灰 */
  dark: {
    'root.size': '14px',
    'codeBlock.size': '14px',
    'p.align': 'start',
    'del.thickness': '2px',
    'a.hoverColor': '#60a5fa',
    'inlineCode.fontLatin': 'JetBrains Mono',
    'inlineCode.fontCjk': 'HarmonyOS Sans SC',
    'task.accent': '#4ade75',
    'task.doneColor': '#4ade75',
    'quote.bg': 'oklch(0.22 0 0)',
    'quote.radius': '5px',
    'quote.padding': '1em',
    'codeBlock.fontLatin': 'JetBrains Mono',
    'codeBlock.fontCjk': 'HarmonyOS Sans SC',
    'cell.rowLine': 'solid',
    'cell.colLine': 'none',
    'table.collapse': 'separate',
    'cell.borderWidth': '1px',
    'table.stripeBg': 'oklch(0.23 0 0 / 0.42)',
    'hr.thickness': '1.5px',
    'img.align': 'auto',
    'img.margin': '0.6em',
    'root.fontLatin': 'Inter',
    'root.fontCjk': 'HarmonyOS Sans SC',
    'h1.size': '21px',
    'h2.size': '19px',
    'h3.size': '18px',
    'h4.size': '15px',
    'h5.size': '15px',
    'h6.size': '14px',
    'a.underline': 'always',
    'a.color': '#60a5fa',
    'a.underlineHeight': '1.5px',
    'table.radius': '6px',
    'hr.margin': '1.2em 0em',
    'img.radius': '8px',
  },
}

interface ThemeState {
  themes: ThemeFile[]
  activeThemeId: string
  /** 导入主题包文本：形状不合返回 null（调用方报错不落库），成功即激活
      （Themd 同款行为——导入的正是用户想看的）；同 id 重新导入覆盖旧档 */
  importTheme: (raw: string) => string | null
  /** 删除用户主题；删的是激活主题时回落默认 */
  removeTheme: (id: string) => void
  setActive: (id: string) => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themes: [],
      activeThemeId: DEFAULT_THEME_ID,
      importTheme: (raw) => {
        const theme = parseThemeFile(raw)
        if (!theme) return null
        set({
          themes: [...get().themes.filter((t) => t.id !== theme.id), theme],
          activeThemeId: theme.id,
        })
        return theme.id
      },
      removeTheme: (id) =>
        set((s) => ({
          themes: s.themes.filter((t) => t.id !== id),
          activeThemeId: s.activeThemeId === id ? DEFAULT_THEME_ID : s.activeThemeId,
        })),
      setActive: (id) => set({ activeThemeId: id }),
    }),
    {
      name: 'cogent-themes',
      partialize: (s) => ({ themes: s.themes, activeThemeId: s.activeThemeId }),
      merge: (persisted, current) => {
        const raw = persisted as Partial<ThemeState> | undefined
        const isValidTheme = (t: unknown): t is ThemeFile => {
          if (typeof t !== 'object' || t === null) return false
          const { id, name, tokens } = t as Record<string, unknown>
          return (
            typeof id === 'string' &&
            id !== DEFAULT_THEME_ID &&
            typeof name === 'string' &&
            name !== '' &&
            typeof tokens === 'object' &&
            tokens !== null &&
            !Array.isArray(tokens)
          )
        }
        const themes = Array.isArray(raw?.themes) ? raw.themes.filter(isValidTheme) : []
        if (Array.isArray(raw?.themes) && themes.length !== raw.themes.length) {
          console.error('[theme-store] 剔除损坏的主题档案（手改 localStorage？）')
        }
        const activeThemeId =
          typeof raw?.activeThemeId === 'string' &&
          (raw.activeThemeId === DEFAULT_THEME_ID || themes.some((t) => t.id === raw.activeThemeId))
            ? raw.activeThemeId
            : DEFAULT_THEME_ID
        return { ...current, themes, activeThemeId }
      },
    },
  ),
)

/** 激活主题（default 恒在；被删/坏档一律回落默认，不抛） */
export function useActiveTheme(): ThemeFile {
  return useThemeStore((s) =>
    s.activeThemeId === DEFAULT_THEME_ID
      ? DEFAULT_THEME
      : (s.themes.find((t) => t.id === s.activeThemeId) ?? DEFAULT_THEME),
  )
}
