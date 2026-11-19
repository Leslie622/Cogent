/** 用户覆盖钉最终用途与单文字系统，不污染主题；CSS 冲突另由真实浏览器验证。 */
import { describe, expect, it } from 'vitest'
import { compileUserOverrides } from '@/lib/theme/user-overrides'
import type { FontPair } from '@/stores/appearance'

const follow: FontPair = { latin: 'theme', cjk: 'theme' }
describe('用户显式覆盖', () => {
  it('全部跟随时没有最终覆盖变量', () => {
    expect(compileUserOverrides({ 'h1.fontLatin': 'Georgia' }, { contentFont: follow, codeFont: follow, codeFontSize: null })).toEqual({})
  })
  it('只选中文保留各层英文，标题独立字体也受用户选择约束', () => {
    const theme = { 'root.fontLatin': 'Inter', 'h1.fontLatin': 'Georgia', 'h1.fontCjk': 'SimSun' }
    const before = { ...theme }
    const vars = compileUserOverrides(theme, { contentFont: { latin: 'theme', cjk: 'local:Microsoft YaHei' }, codeFont: follow, codeFontSize: null })
    expect(vars['--cogent-user-h1-font']).toMatch(/^Georgia, 'Microsoft YaHei'/)
    expect(vars['--cogent-user-root-font']).toMatch(/^Inter, 'Microsoft YaHei'/)
    expect(vars['--cogent-user-code-font']).toBeUndefined()
    expect(theme).toEqual(before)
  })
  it('代码单槽保留块/行内各自另一槽，字号只覆盖代码块', () => {
    const vars = compileUserOverrides({ 'inlineCode.fontLatin': 'Consolas', 'codeBlock.fontLatin': 'Georgia' }, {
      contentFont: follow, codeFont: { latin: 'theme', cjk: 'local:Microsoft YaHei' }, codeFontSize: 20,
    })
    expect(vars['--cogent-user-code-font']).toMatch(/^Georgia, 'Microsoft YaHei'/)
    expect(vars['--cogent-user-inline-code-font']).toMatch(/^Consolas, 'Microsoft YaHei'/)
    expect(vars['--cogent-user-code-size']).toBe('20px')
    expect(vars['--cogent-user-root-font']).toBeUndefined()
  })
})
