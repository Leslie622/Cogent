import { TOKEN_VAR, type ThemeTokens, type TokenKey } from './tokens'

/**
 * 令牌 → CSS 变量（自 Themd 平移，字体拼合/继承链展开逻辑原样）。
 * 链路只有这一条：theme store 的 tokens → compileTokens → 消息流容器
 * style 注入（亮色）/ <style> 块（暗色 + extraCss，见 ThemeApplier）。
 * 未设置的键不产出变量，globals.css 消费表的 var() 回落值即 Streamdown
 * 原生观感。dark 参数：主题有暗色令牌套且当前处于暗色模式时，用 dark 套编译
 * （Cogent 暗色切换未上线，dark 套编译产物待命，.dark 休眠期间不生效）。
 */
export function compileTokens(
  tokens: ThemeTokens,
  darkTokens?: ThemeTokens,
  isDark = false,
): Record<string, string> {
  const active = isDark && darkTokens ? darkTokens : tokens
  const vars: Record<string, string> = {}
  for (const [key, varName] of Object.entries(TOKEN_VAR)) {
    const value = active[key as TokenKey]
    if (value !== undefined && value !== '') {
      vars[varName] = value
    }
  }
  // a.underline 是策略值（always/hover/none），展开为两个实际变量
  const underline = active['a.underline']
  delete vars['--t-a-underline']
  if (underline === 'always') {
    vars['--t-a-underline-line'] = 'underline'
    vars['--t-a-hover-underline'] = 'underline'
  } else if (underline === 'none') {
    vars['--t-a-underline-line'] = 'none'
    vars['--t-a-hover-underline'] = 'none'
  } else if (underline === 'hover') {
    vars['--t-a-underline-line'] = 'none'
    vars['--t-a-hover-underline'] = 'underline'
  }
  // 字体双令牌(latin/cjk)拼合成一条 font-family 栈:latin 在前 cjk 在后,
  // 浏览器按字符自动分流。只设其一 = 另一端走回落族,拼栈时用回落链补齐空端,
  // 保证单设也即刻生效。「继承上游」在编译期展开:上游已拼好的栈文本直接接尾
  // (inherit 等 CSS 全局关键字只能独立占整条属性值,出现在 font-family 列表
  // 中间会让整条声明作废,字体静默回落——标题族曾因此全部失效)
  const emitted = new Map<string, string>()
  for (const [base, varPrefix] of FONT_STACKS) {
    const latin = active[`${base}.fontLatin` as TokenKey]
    const cjk = active[`${base}.fontCjk` as TokenKey]
    const hasLatin = latin !== undefined && latin.trim() !== ''
    const hasCjk = cjk !== undefined && cjk.trim() !== ''
    if (hasLatin || hasCjk) {
      const text = joinFontStack(hasLatin ? latin : undefined, hasCjk ? cjk : undefined, resolveFontTail(base, emitted))
      vars[varPrefix] = text
      emitted.set(base, text)
    }
  }
  return vars
}

/** FONT_STACKS 的元素基名 → 编译期继承链上的上游（继承语义与消费表的回落层级一致） */
const FONT_INHERIT_CHAIN: Record<string, string | null> = {
  root: null,
  heading: 'root',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  strong: 'root',
  em: 'root',
  del: 'root',
  a: 'root',
  inlineCode: null,
  codeBlock: null,
}

/** 正文根的基础回落链（与 globals.css 的 --font-sans 尾段一致：主题只设
 *  latin/cjk 其一时，空端由此补齐） */
const BASE_PROSE_TAIL =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"

/**
 * 元素自身栈的尾部回落:沿继承链找第一个已拼栈的上游,其栈文本整段接尾
 * (上游没设 = 下游继承上游 = 上游栈就是继承的终点展开);链上全空时接
 * 基础回落链。root/代码族不继承,用各自的通用族尾。
 * 调用顺序依赖 FONT_STACKS 的拓扑序(上游先拼)。
 */
function resolveFontTail(base: string, emitted: Map<string, string>): string {
  if (base === 'root') return "'Segoe UI', 'Microsoft YaHei', sans-serif"
  if (base === 'inlineCode' || base === 'codeBlock') {
    /* 与 --font-mono 尾段一致：等宽拉丁在前，CJK 注释回落鸿蒙 */
    return "ui-monospace, SFMono-Regular, Consolas, 'HarmonyOS Sans SC', monospace"
  }
  let up = FONT_INHERIT_CHAIN[base]
  while (up) {
    const text = emitted.get(up)
    if (text) return text
    up = FONT_INHERIT_CHAIN[up]
  }
  return BASE_PROSE_TAIL
}

/** 双字体令牌的元素基名 → 编译产出的合并变量名（消费表按同名变量取栈） */
const FONT_STACKS: [string, string][] = [
  ['root', '--t-root-font'],
  ['heading', '--t-heading-font'],
  ['h1', '--t-h1-font'],
  ['h2', '--t-h2-font'],
  ['h3', '--t-h3-font'],
  ['h4', '--t-h4-font'],
  ['h5', '--t-h5-font'],
  ['h6', '--t-h6-font'],
  ['strong', '--t-strong-font'],
  ['em', '--t-em-font'],
  ['del', '--t-del-font'],
  ['a', '--t-a-font'],
  ['inlineCode', '--t-inline-code-font'],
  ['codeBlock', '--t-code-font'],
]

/**
 * 字体族名集合 → font-family 栈文本。
 * latin 在前 cjk 在后,浏览器按字符自动分流(西文字体缺汉字时落到中文字体)。
 * 族名去引号统一保存,含空格的重新加引号;跨 latin/cjk 的重复族去重。
 */
function joinFontStack(latin: string | undefined, cjk: string | undefined, fallbackTail: string): string {
  const families: string[] = []
  const pushAll = (v: string | undefined) => {
    for (const f of (v ?? '').split(',')) {
      const t = f.trim().replace(/^['"]|['"]$/g, '')
      if (t && !families.includes(t)) families.push(t)
    }
  }
  pushAll(latin)
  pushAll(cjk)
  for (const t of fallbackTail.split(',')) {
    const clean = t.trim().replace(/^['"]|['"]$/g, '')
    if (clean && !families.includes(clean)) families.push(clean)
  }
  return families.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(', ')
}

/**
 * 附加 CSS（extraCss）作用域包装：CSS 原生 @scope 钉在 .md-body 内，
 * 浏览器级解析不改写选择器——Themd 的前缀改写（scopeExtraCss 正则重写）
 * 是为「导入第三方 CSS」服务的启发式，在嵌套 @media / 复杂选择器上脆；
 * 本仓方向相反（导出端已保证语义），@scope 是更对的工具。
 * 边界：@scope 内裸选择器只匹配 .md-body 的**后代**，要命中容器自身
 * （如改根字号）需写 :scope。
 */
export function scopeExtraCss(css: string): string {
  const trimmed = css.trim()
  return trimmed ? `@scope (.md-body) {\n${trimmed}\n}` : ''
}

/** 附加 CSS 的 <style> 内容（含主题隔离注释头，便于 DevTools 里认主） */
export function extraCssToStyle(themeId: string, css: string): string {
  const scoped = scopeExtraCss(css)
  return scoped ? `/* cogent-theme-extra:${themeId} */\n${scoped}` : ''
}
