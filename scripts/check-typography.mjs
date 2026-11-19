/** 字号治理入口：检查自有渲染源码，阻止新页面绕过公共阶梯；例外只留集中消费点。 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { checkTheme } from './themd-theme.mjs'

const allowedSizes = new Set(['text-xs', 'text-sm', 'text-base', 'text-2xl'])
const root = 'src/renderer/src'
const requested = process.argv.slice(2)
const files = requested.length === 0
  ? readdirSync(root, { recursive: true }).filter(file => /\.(?:tsx?|css)$/.test(file)).map(file => join(root, file))
  : requested
let failures = 0
for (const problem of checkTheme()) {
  console.error(problem)
  failures++
}

function report(file, source, position, message) {
  const prefix = source.slice(0, position).split('\n')
  console.error(`${file}:${prefix.length}:${prefix.at(-1).length + 1}: ${message}`)
  failures++
}

function utilityName(token) {
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index++) {
    if (token[index] === '[' || token[index] === '(') depth++
    if (token[index] === ']' || token[index] === ')') depth--
    if (token[index] === ':' && depth === 0) start = index + 1
  }
  return token.slice(start).replace(/^!|!$/g, '')
}

function checkClasses(file, source, node) {
  for (const token of node.text.split(/\s+/)) {
    const utility = utilityName(token)
    const standard = /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/.test(utility)
    const arbitrary = /^text-(?:\[|\()/.test(utility)
    const color = /^text-\[(?:color:|#|(?:rgb|hsl|oklch|oklab|lab|lch|color)\()/.test(utility)
    const styleProperty = /^\[font(?:-size)?:/.test(utility)
    if ((standard && !allowedSizes.has(utility)) || (arbitrary && !color) || styleProperty) {
      report(file, source, node.getStart(), `字号 ${token} 绕过统一配置；使用 text-xs / text-sm / text-base / text-2xl，代码使用 code-typography。`)
    }
  }
  if (/(?:font-size|(?:^|[;{])\s*font)\s*:/.test(node.text)) {
    report(file, source, node.getStart(), '不要通过字符串 CSS 声明字号；使用公共字号入口。')
  }
}

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const localPath = relative(process.cwd(), resolve(file)).replaceAll('\\', '/')
  if (file.endsWith('.css')) {
    // 生成件逐字与上游快照变换比对过；禁止手改，不逐条豁免上游的标准排版。
    if (localPath === `${root}/lib/theme/themd-base.css`) continue
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
    for (const match of clean.matchAll(/(?:^|[;{}\s])((?:font-size|font|--(?:ui-font-size|ui-text-[\w-]+|text-[\w-]+|app-code-size)))\s*:\s*([^;}]+)/g)) {
      const central = localPath === `${root}/globals.css`
      const open = clean.lastIndexOf('{', match.index)
      const boundary = Math.max(clean.lastIndexOf('}', open), clean.lastIndexOf('{', open - 1), clean.lastIndexOf(';', open))
      const selector = clean.slice(boundary + 1, open).trim().replace(/\s+/g, ' ')
      const sizeConsumers = new Map([
        ['.content-typography', '0.875rem'],
        ['.code-typography', 'var(--app-code-size)'],
        ['.md-body', 'var(--t-root-size, 0.875rem)'],
        ["[style*='--t-code-'] .md-body [data-streamdown='code-block'] pre", 'var(--t-code-size, var(--app-code-size))'],
      ])
      const scopes = [':root', '@theme', '.content-typography, .md-body', ".md-body [data-streamdown='code-block-header'], .md-body [data-streamdown='code-block-actions']"]
      const knownDeclaration = match[1] === 'font-size'
        ? sizeConsumers.get(selector) === match[2].trim()
        : match[1] !== 'font' && scopes.includes(selector)
      const content = localPath === `${root}/lib/theme/content.css` && (
        (selector === ".md-body [data-streamdown='code-block'] pre" && match[1] === 'font-size' && match[2].trim() === 'var(--t-code-size, 0.875em)') ||
        ([".md-body [data-streamdown='code-block-body']", '.md-body table :is(thead, tbody, tr, th, td)'].includes(selector) && match[1] === 'font-size' && match[2].trim() === 'inherit') ||
        (selector === ".md-body [data-streamdown='code-block-header'], .md-body [data-streamdown='code-block-actions']" && new Map([['--text-xs', 'var(--ui-text-xs)'], ['--text-sm', 'var(--ui-text-sm)'], ['--text-base', 'var(--ui-text-base)']]).get(match[1]) === match[2].trim())
      )
      const user = localPath === `${root}/lib/theme/user-overrides.css` && match[1] === 'font-size' && (
        (selector === '[style*="--cogent-user-code-size:"] .md-body pre' && match[2].trim() === 'var(--cogent-user-code-size) !important') ||
        (selector === '[style*="--cogent-user-code-size:"] .md-body pre code, [style*="--cogent-user-code-size:"] .md-body pre code *' && match[2].trim() === 'inherit !important')
      )
      if (!(central && knownDeclaration) && !content && !user) {
        report(file, source, match.index, 'CSS 字号只能在 globals.css 公共阶梯或内容/代码消费点定义。')
      }
    }
    continue
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      checkClasses(file, source, node)
    }
    if (ts.isTemplateExpression(node) && /text-(?:\[)?\$\{/.test(node.getText())) {
      report(file, source, node.getStart(), '字号类不能动态拼接；用静态档位表。')
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && /^['"`]text-/.test(node.left.getText()) && !ts.isStringLiteral(node.right)) {
      report(file, source, node.getStart(), '字号类不能动态拼接；用静态档位表。')
    }
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name) && ts.isStringLiteral(node.name.expression)
        ? node.name.expression.text
        : node.name.getText().replace(/^['"]|['"]$/g, '')
      const logo = localPath === `${root}/components/ProviderLogo.tsx` && name === 'fontSize' && node.initializer.getText() === 'Math.round(size * 0.45)'
      if (!logo && /^(?:fontSize|font-size|font|--(?:ui-font-size|ui-text-.+|text-.+|app-code-size))$/.test(name)) {
        report(file, source, node.getStart(), '内联字号绕过公共配置；使用标准档或共享内容/代码组件。')
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\.style\.(?:fontSize|font)$/.test(node.left.getText())) {
      report(file, source, node.getStart(), '禁止直接写 DOM 字号；使用统一外观投影。')
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(node.left) && /\.style$/.test(node.left.expression.getText()) && ts.isStringLiteral(node.left.argumentExpression) && ['fontSize', 'font'].includes(node.left.argumentExpression.text)) {
      report(file, source, node.getStart(), '禁止直接写 DOM 字号；使用统一外观投影。')
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['setProperty', 'removeProperty'].includes(node.expression.name.text)) {
      const property = node.arguments[0]
      const name = property && ts.isStringLiteral(property) ? property.text : ''
      const projected = localPath === `${root}/lib/appearance-dom.ts` && ['--ui-font-size', '--app-code-size'].includes(name)
      if ((!name && /\.style$/.test(node.expression.expression.getText())) || (!projected && /^(?:font-size|font|--(?:ui-font-size|ui-text-.+|text-.+|app-code-size))$/.test(name))) {
        report(file, source, node.getStart(), '字号变量只能由统一外观投影更新。')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}

if (failures > 0) process.exitCode = 1
else console.log(`字号检查通过：${files.length} 个文件。`)
