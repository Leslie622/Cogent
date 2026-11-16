/** 主题包导入校验单测：合法包 / 坏 JSON / 缺 name / 坏字段按无值处理
    （持久化读取边界，钉行为，约定.md §1.3-4） */
import { describe, expect, it } from 'vitest'
import { parseThemeFile } from './theme-file'

/** 实样：用户主题包 Theme-Leslie 的形状（token 值节选） */
const VALID = JSON.stringify({
  version: 1,
  id: '68b81029-d0cc-497a-a4c9-77cf07726b82',
  name: 'Theme-Leslie',
  tokens: { 'hr.thickness': '2px', 'quote.bg': '#f4f2f2' },
})

describe('parseThemeFile', () => {
  it('合法包：透传令牌，id 重签（导入即新档，防与既有档撞 id）', () => {
    const theme = parseThemeFile(VALID)
    expect(theme).not.toBeNull()
    expect(theme?.name).toBe('Theme-Leslie')
    expect(theme?.tokens).toEqual({ 'hr.thickness': '2px', 'quote.bg': '#f4f2f2' })
    expect(theme?.id).not.toBe('68b81029-d0cc-497a-a4c9-77cf07726b82')
  })

  it('坏 JSON / 非对象 / 缺 name 或空名：整包拒收返回 null', () => {
    expect(parseThemeFile('{oops')).toBeNull()
    expect(parseThemeFile('"just a string"')).toBeNull()
    expect(parseThemeFile('{"tokens":{}}')).toBeNull()
    expect(parseThemeFile('{"name":""}')).toBeNull()
  })

  it('坏字段按无值处理，不让坏文件污染令牌表', () => {
    const theme = parseThemeFile(
      '{"name":"x","tokens":["数组不是令牌表"],"dark":{},"extraCss":42}',
    )
    expect(theme?.tokens).toEqual({})
    expect(theme?.dark).toBeUndefined()
    expect(theme?.extraCss).toBeUndefined()
  })

  it('dark 为空对象视为未设（零键暗色套无意义，不产出待命 style）', () => {
    const theme = parseThemeFile('{"name":"x","tokens":{},"dark":{}}')
    expect(theme?.dark).toBeUndefined()
  })
})
