/** 用户选择独立于主题原数据；最终重要层只覆盖显式选择的用途和文字系统。 */
import { compileTokens } from './compile'
import type { ThemeTokens, TokenKey } from './tokens'
import { buildUserTokens, type FontPair } from '@/stores/appearance'

export const CONTENT_FONT_GROUPS = ['root', 'heading', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'a'] as const

/** 将相应主题子元素的另一文字系统保留，避免“只改中文”把英文字体还原成系统默认。 */
export function compileUserOverrides(theme: ThemeTokens, settings: {
  codeFontSize: number | null
  contentFont: FontPair
  codeFont: FontPair
}): Record<string, string> {
  const overrides = buildUserTokens(settings)
  const vars: Record<string, string> = {}
  const groups = [...CONTENT_FONT_GROUPS, 'inlineCode', 'codeBlock']
  for (const group of groups) {
    const isCode = group === 'inlineCode' || group === 'codeBlock'
    const choice = isCode ? settings.codeFont : settings.contentFont
    if (choice.latin === 'theme' && choice.cjk === 'theme') continue
    const merged = { ...theme }
    for (const suffix of ['fontLatin', 'fontCjk'] as const) {
      // 主题可能在标题等处独立选字体；先沿声明链取得未覆盖一侧，再施加用户选择。
      const key = `${group}.${suffix}` as TokenKey
      const parent = isCode ? undefined : group === 'root' ? undefined : group.startsWith('h') ? `heading.${suffix}` as TokenKey : `root.${suffix}` as TokenKey
      const base = theme[key] ?? (parent === undefined ? undefined : theme[parent]) ?? (isCode ? undefined : theme[`root.${suffix}`])
      const value = overrides[`${isCode ? group : 'root'}.${suffix}` as TokenKey] ?? base
      if (value !== undefined) merged[key] = value
    }
    const compiled = compileTokens(merged)
    const variable = group === 'inlineCode' ? 'inline-code' : group === 'codeBlock' ? 'code' : group
    vars[`--cogent-user-${variable}-font`] = compiled[`--t-${variable}-font`]
  }
  if (settings.codeFontSize !== null) vars['--cogent-user-code-size'] = `${settings.codeFontSize}px`
  return vars
}
