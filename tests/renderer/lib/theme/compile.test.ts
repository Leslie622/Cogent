/** compile 纯函数单测：令牌→变量直译 / a.underline 策略展开 / 字体拼合 /
    dark 套替换 / extraCss @scope 包裹（钉行为，约定.md §1.3-4） */
import { describe, expect, it } from 'vitest'
import { compileTokens, extraCssToStyle, scopeExtraCss } from '@/lib/theme/compile'

describe('compileTokens', () => {
  it('键值直译；未设键不产出变量（回落即默认观感）', () => {
    const vars = compileTokens({ 'hr.thickness': '2px' })
    expect(vars).toEqual({ '--t-hr-thickness': '2px' })
  })

  it('空串值视为未设（与 undefined 同路，不产出空变量）', () => {
    expect(compileTokens({ 'hr.thickness': '' })).toEqual({})
  })

  it('a.underline 策略值展开为常态/hover 两个下划线变量，原始键不残留', () => {
    expect(compileTokens({ 'a.underline': 'always' })).toEqual({
      '--t-a-underline-line': 'underline',
      '--t-a-hover-underline': 'underline',
    })
    expect(compileTokens({ 'a.underline': 'hover' })).toEqual({
      '--t-a-underline-line': 'none',
      '--t-a-hover-underline': 'underline',
    })
    expect(compileTokens({ 'a.underline': 'none' })).toEqual({
      '--t-a-underline-line': 'none',
      '--t-a-hover-underline': 'none',
    })
  })

  it('字体双令牌拼成一条栈：latin 前 cjk 后，尾部接通用回落族', () => {
    const vars = compileTokens({ 'root.fontLatin': 'Inter', 'root.fontCjk': 'HarmonyOS Sans SC' })
    expect(vars['--t-root-font']).toBe(
      "Inter, 'HarmonyOS Sans SC', 'Segoe UI', 'Microsoft YaHei', sans-serif",
    )
  })

  it('只设 cjk 一端：空端由回落链补齐，单设即刻生效', () => {
    const vars = compileTokens({ 'h1.fontCjk': '思源黑体' })
    // 拼栈尾沿继承链：h1 → heading → root 全未设 → 接基础回落链
    expect(vars['--t-h1-font']).toBe(
      "思源黑体, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    )
  })

  it('下游字体栈接上游已拼栈（编译期继承展开），不重复回落族', () => {
    const vars = compileTokens({
      'root.fontLatin': 'Georgia',
      'heading.fontLatin': 'Comic Sans',
    })
    // heading 栈 = 自身 + root 栈整段接尾（root 栈已含回落族，不追加第二份）；
    // 含空格族名重新加引号（joinFontStack 统一引号规则）
    expect(vars['--t-heading-font']).toBe(
      "'Comic Sans', Georgia, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    )
  })

  it('代码族回落等宽尾（CJK 注释回落鸿蒙，与 --font-mono 尾段一致）', () => {
    const vars = compileTokens({ 'inlineCode.fontLatin': 'Cascadia Code' })
    expect(vars['--t-inline-code-font']).toBe(
      "'Cascadia Code', ui-monospace, SFMono-Regular, Consolas, 'HarmonyOS Sans SC', monospace",
    )
  })

  it('isDark 时用 dark 套整面替换（缺键不回落亮面，回落消费表默认）', () => {
    const vars = compileTokens(
      { 'hr.thickness': '1px', 'a.color': '#111111' },
      { 'a.color': '#eeeeee' },
      true,
    )
    expect(vars).toEqual({ '--t-a-color': '#eeeeee' })
  })
})

describe('scopeExtraCss', () => {
  it('非空 CSS 包进 @scope (.md-body)，不改写选择器', () => {
    expect(scopeExtraCss('strong { color: red; }')).toBe(
      '@scope (.md-body) {\nstrong { color: red; }\n}',
    )
  })

  it('空白输入返回空串（消费端不注入空 style）', () => {
    expect(scopeExtraCss('   ')).toBe('')
  })
})

describe('extraCssToStyle', () => {
  it('带主题隔离注释头；空 CSS 返回空串', () => {
    expect(extraCssToStyle('t1', 'p{margin:0}')).toBe(
      '/* cogent-theme-extra:t1 */\n@scope (.md-body) {\np{margin:0}\n}',
    )
    expect(extraCssToStyle('t1', ' ')).toBe('')
  })
})
