/**
 * 正文主题 store（zustand + persist → localStorage: cogent-themes）——
 * 全仓首个 persist store：纯渲染端视觉偏好，不进引擎/协议/磁盘档案，
 * localStorage 是对的层（跨设备同步是真墙：引擎侧无设置同步通道）。
 * 「默认」主题是常量而非存储档：空令牌 = 消费表全回落 = Streamdown 原生
 * 观感，不占用户存储、不可删除（与 Themd builtin 同思路；Cogent 不编辑
 * 内置主题，无需 builtin 标记与复制分支）。
 * 持久化读取是信任边界（约定.md §1.1）：merge 时校验形状，损坏档剔除
 * 并报错，激活 id 指向已剔除档时回落默认。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { parseThemeFile, type ThemeFile } from '@/lib/theme/theme-file'

export const DEFAULT_THEME_ID = 'default'

const DEFAULT_THEME: ThemeFile = {
  version: 1,
  id: DEFAULT_THEME_ID,
  name: '默认',
  tokens: {},
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
