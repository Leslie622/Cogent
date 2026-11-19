import themeBaseCss from '@/styles/theme-base.css?raw'

import { compileTokens, scopeExtraCss } from './compile'
import type { ThemeFile } from './schema'

/**
 * 可移植 CSS 包(渲染统一第 5 步交付物,方案 §8-5 / §9 目标 2):
 * theme-base.css 全文 + 令牌编译内联 + 目标容器选择器映射。
 * 「用户在本应用调出的一套 MD 样式,可以应用到任何标准 Markdown 上」
 * ——产物只依赖 CommonMark/GFM 规范结构(I2:CSS 零私有钩子),贴到
 * Typora / VSCode 预览 / GitHub 即复现 Themd 内的观感。
 *
 * 与独立 HTML 导出(standalone-html)同源:同一份 theme-base.css +
 * 同一 compileTokens,只是容器选择器随目标端改写。
 */

export type PortableCssTarget = 'typora' | 'vscode' | 'github' | 'generic'

/** 目标端 → 内容容器选择器(Typora 正文容器 / VSCode Markdown 预览 body /
 *  GitHub 渲染容器 / 通用兜底)。 */
const TARGET_SCOPE: Record<PortableCssTarget, string> = {
  typora: '#write',
  vscode: '.vscode-body',
  github: '.markdown-body',
  generic: '.themd-prose',
}

/** UI 层菜单元数据(顺序即菜单顺序) */
export const PORTABLE_TARGETS: ReadonlyArray<{
  id: PortableCssTarget
  label: string
  hint: string
}> = [
  { id: 'typora', label: 'Typora', hint: '#write' },
  { id: 'vscode', label: 'VSCode 预览', hint: '.vscode-body' },
  { id: 'github', label: 'GitHub', hint: '.markdown-body' },
  { id: 'generic', label: '通用', hint: '.themd-prose' },
]

export function portableCssFileName(themeName: string, target: PortableCssTarget): string {
  return target === 'generic' ? `${themeName}.portable.css` : `${themeName}.${target}.css`
}

export function buildPortableCss(theme: ThemeFile, target: PortableCssTarget): string {
  const scope = TARGET_SCOPE[target]
  const lightVars = compileTokens(theme.tokens, theme.dark, false)
  const hasDark = !!theme.dark && Object.keys(theme.dark).length > 0
  const darkVars = hasDark ? compileTokens(theme.tokens, theme.dark, true) : null

  const lines: string[] = [
    `/* ${theme.name} — Themd 可移植样式包(${target}) */`,
    `/* 内容容器选择器:${scope};粘贴位置见 docs/可移植CSS粘贴指南.md */`,
    `/* 令牌内联:亮色常驻${hasDark ? ',暗色套随系统 prefers-color-scheme 切换' : '(主题未设暗色套)'} */`,
    '',
    varsBlock(scope, lightVars),
  ]
  if (darkVars) {
    lines.push('', '@media (prefers-color-scheme: dark) {')
    lines.push(indent(varsBlock(scope, darkVars), '  '))
    lines.push('}')
  }

  // 画布背景(app.bg):消费方是页面/正文纸张之外的整页,落 body 块
  const appBg = lightVars['--t-app-bg']
  if (appBg) lines.push('', `body {\n  background: ${appBg};\n}`)
  if (darkVars?.['--t-app-bg']) {
    lines.push(
      '',
      '@media (prefers-color-scheme: dark) {',
      `  body {\n    background: ${darkVars['--t-app-bg']};\n  }`,
      '}',
    )
  }

  // theme-base 全文:改写作用域 + 剥离依赖「应用内联 style」的守卫规则
  // (del 自绘删除线在应用里靠 [style*=--t-del-*] 探测令牌注入,移植包里
  //  令牌走 CSS 块,探测恒不命中——剥掉后按令牌有无条件补发等效规则)
  const base = themeBaseCss
    .replace(/[^{}]*\[style\*=[^{}]*\{[^}]*\}\n?/g, '')
    .replace(/var\(--foreground\)/g, 'inherit')
    .replaceAll('.themd-prose', scope)
  lines.push('', base.trimEnd())

  // del 自绘删除线:设置了 offset/thickness 任一令牌(亮/暗任一套)即启用
  const delCustom =
    '--t-del-offset' in lightVars ||
    '--t-del-thickness' in lightVars ||
    (darkVars && ('--t-del-offset' in darkVars || '--t-del-thickness' in darkVars))
  if (delCustom) {
    lines.push('', `${scope} {`, '  --t-del-line: none;', '}')
    lines.push('', `${scope} del,`, `${scope} s {`)
    lines.push(
      '  text-decoration-line: none;',
      '  background-image:',
      '    linear-gradient(var(--t-del-text-color, currentColor), var(--t-del-text-color, currentColor)),',
      '    var(--t-del-bg-image, none);',
      '  background-size:',
      '    100% var(--t-del-thickness, 1px),',
      '    auto;',
      '  background-position:',
      '    0 calc(50% + var(--t-del-offset, 0px)),',
      '    0 0;',
      '  background-repeat: no-repeat, no-repeat;',
      '  background-color: var(--t-del-bg, transparent);',
      '}',
    )
  }

  if (theme.extraCss?.trim()) {
    // extraCss 先按应用同款规则包 .themd-prose 作用域,再统一改写目标容器
    const scoped = scopeExtraCss(theme.extraCss).replaceAll('.themd-prose', scope)
    lines.push('', `/* ── 附加自定义 CSS ── */`, scoped)
  }
  return lines.join('\n') + '\n'
}

function varsBlock(scope: string, vars: Record<string, string>): string {
  const body = Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')
  return body ? `${scope} {\n${body}\n}` : ''
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n')
}
