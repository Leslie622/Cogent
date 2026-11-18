import type { ThemeTokens } from './tokens'

/**
 * 主题包（.themd.json）的文件形状与导入校验。
 * 结构与 Themd 导出格式对齐（theme-controller.ts handleExportJson）：
 * { version: 1, id, name, tokens, dark?, extraCss? }。
 * 校验是对齐 Themd importTheme 的防御形状——这是**持久化读取边界**
 * （约定.md §1.1 第四行：磁盘/外来的旧数据不可信）：坏字段按无值处理，
 * 不让坏文件污染令牌表；name 缺失整包拒收（无名的主题无法在 UI 呈现）。
 */

/** 主题文件（导入格式即此结构；Cogent 端不导出，无 builtin 概念——
    「默认」主题是 store 里的内置令牌常量，不占持久化） */
export interface ThemeFile {
  version: 1
  id: string
  name: string
  tokens: ThemeTokens
  /** 暗色令牌套：暗色模式（外观设置 html.dark）整面替换 tokens
      （未设键回落 CSS 基础值，不回落亮面） */
  dark?: ThemeTokens
  /** 附加自定义 CSS（@scope 钉在 .md-body 内注入，见 compile.ts） */
  extraCss?: string
}

const isTokenMap = (v: unknown): v is ThemeTokens =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 解析主题包文本：形状不合返回 null（调用方报错不落库）。
    令牌值不做内容校验——值是 CSS 片段，注入面与 extraCss 同级；主题包
    来自用户自己的磁盘（file picker 手选），信任级别等同用户自己写 CSS，
    不是远程攻击面。 */
export function parseThemeFile(raw: string): ThemeFile | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { name, tokens, dark, extraCss } = data as Record<string, unknown>
  if (typeof name !== 'string' || !name) return null
  return {
    version: 1,
    id: crypto.randomUUID(),
    name,
    tokens: isTokenMap(tokens) ? tokens : {},
    dark: isTokenMap(dark) && Object.keys(dark).length > 0 ? dark : undefined,
    extraCss: typeof extraCss === 'string' && extraCss ? extraCss : undefined,
  }
}
